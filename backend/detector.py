"""
detector.py — Baseball detection for pitch videos.

Three camera angles supported:
  - catcher:   Camera behind home plate, ball comes toward lens (grows larger)
  - pitcher:   Camera behind pitcher, ball moves away (shrinks)
  - broadcast: Side/center-field view, ball moves horizontally across frame

Detection pipeline:
  1. Frame differencing — moving objects between consecutive frames
  2. Brightness/white threshold — isolates the baseball color
  3. Hough circles — confirms circular shape
  4. Trajectory validation — requires consistent velocity + linear path
     (rejects crowd, scoreboards, players, static bright objects)
"""

import cv2
import numpy as np
import math
import base64
import logging
from typing import Optional, List, Tuple, Dict

log = logging.getLogger(__name__)

# ── Zone mapping defaults ──────────────────────────────────────────────────────
CATCHER_ZONE  = {"x_center": 0.50, "x_half": 0.18, "y_center": 0.50, "y_half": 0.25}
PITCHER_ZONE  = {"x_center": 0.50, "x_half": 0.10, "y_center": 0.40, "y_half": 0.15}
BROADCAST_ZONE = {"x_center": 0.75, "x_half": 0.12, "y_center": 0.55, "y_half": 0.18}


def px_to_norm(cx_px: int, cy_px: int, w: int, h: int, zone: dict) -> Tuple[float, float]:
    fx = cx_px / w
    fy = cy_px / h
    norm_x = (fx - zone["x_center"]) / zone["x_half"]
    norm_y = (zone["y_center"] - fy) / zone["y_half"]
    return max(-2.0, min(2.0, norm_x)), max(-2.0, min(2.0, norm_y))


# ── Per-frame detection ────────────────────────────────────────────────────────

def detect_candidates(frame: np.ndarray,
                      prev_frame: Optional[np.ndarray],
                      prev_prev_frame: Optional[np.ndarray],
                      max_radius: int = 35) -> List[Dict]:
    """
    Return candidate ball detections in this frame.
    Each: {cx, cy, r, score}
    """
    h, w = frame.shape[:2]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    candidates: Dict[Tuple, Dict] = {}

    def add(cx, cy, r, score_add, circ=0.5):
        key = (cx // 12, cy // 12)
        if key in candidates:
            candidates[key]["score"] += score_add
        else:
            candidates[key] = {"cx": cx, "cy": cy, "r": max(r, 3), "score": score_add, "circ": circ}

    # ── Method 1: Frame difference (finds MOVING objects) ─────────────────
    if prev_frame is not None and prev_prev_frame is not None:
        d1 = cv2.absdiff(cv2.cvtColor(prev_prev_frame, cv2.COLOR_BGR2GRAY), gray)
        d2 = cv2.absdiff(cv2.cvtColor(prev_frame, cv2.COLOR_BGR2GRAY), gray)
        motion = cv2.bitwise_and(d1, d2)
        _, mask = cv2.threshold(motion, 15, 255, cv2.THRESH_BINARY)
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k)
        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for cnt in cnts:
            area = cv2.contourArea(cnt)
            if area < 8 or area > 3000:
                continue
            p = cv2.arcLength(cnt, True)
            if p < 1:
                continue
            circ = 4 * math.pi * area / (p ** 2)
            if circ < 0.25:
                continue
            x, y, bw, bh = cv2.boundingRect(cnt)
            r = max(bw, bh) // 2
            if r > max_radius:
                continue
            add(x + bw // 2, y + bh // 2, r, 2, circ)

    # ── Method 2: White/bright isolation (baseball color) ─────────────────
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    white = cv2.inRange(hsv, (0, 0, 175), (180, 45, 255))
    _, bright = cv2.threshold(gray, 195, 255, cv2.THRESH_BINARY)
    combined = cv2.bitwise_or(white, bright)
    k2 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    combined = cv2.morphologyEx(combined, cv2.MORPH_OPEN, k2)
    combined = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, k2)
    cnts2, _ = cv2.findContours(combined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for cnt in cnts2:
        area = cv2.contourArea(cnt)
        if area < 6 or area > 3500:
            continue
        p = cv2.arcLength(cnt, True)
        if p < 1:
            continue
        circ = 4 * math.pi * area / (p ** 2)
        if circ < 0.3:
            continue
        x, y, bw, bh = cv2.boundingRect(cnt)
        if bw == 0 or bh == 0:
            continue
        asp = max(bw, bh) / min(bw, bh)
        if asp > 2.2:
            continue
        r = max(bw, bh) // 2
        if r > max_radius:
            continue
        add(x + bw // 2, y + bh // 2, r, 1, circ)

    # ── Method 3: Hough circles ────────────────────────────────────────────
    blur = cv2.GaussianBlur(gray, (9, 9), 2)
    circles = cv2.HoughCircles(blur, cv2.HOUGH_GRADIENT, dp=1.2,
                                minDist=15, param1=50, param2=22,
                                minRadius=3, maxRadius=max_radius)
    if circles is not None:
        for c in np.round(circles[0]).astype(int):
            add(int(c[0]), int(c[1]), int(c[2]), 1, 0.85)

    result = [v for v in candidates.values()]
    result.sort(key=lambda c: c["score"] * c.get("circ", 0.5), reverse=True)
    return result[:8]


# ── Trajectory validation ──────────────────────────────────────────────────────

def _velocity_consistent_chain(ordered: List[Dict]) -> List[Dict]:
    """
    Build the longest chain of detections where:
      - Each step moves in a consistent direction (±60° tolerance)
      - Speed doesn't change more than 3x between consecutive steps
      - The point actually MOVES (not stationary noise)
    Returns the best chain found.
    """
    if len(ordered) < 2:
        return ordered

    best = []

    for start in range(len(ordered)):
        chain = [ordered[start]]
        prev_vx, prev_vy = None, None

        for j in range(start + 1, len(ordered)):
            prev = chain[-1]
            curr = ordered[j]

            frame_gap = curr["frame_idx"] - prev["frame_idx"]
            if frame_gap > 6:
                break
            if frame_gap == 0:
                continue

            dx = curr["cx"] - prev["cx"]
            dy = curr["cy"] - prev["cy"]
            dist = math.sqrt(dx*dx + dy*dy)

            # Must actually move (at least 3px per frame gap)
            if dist < 3 * frame_gap:
                continue

            # Cap maximum jump (ball can't teleport)
            if dist > 180 * frame_gap:
                continue

            vx = dx / frame_gap
            vy = dy / frame_gap

            if prev_vx is not None:
                # Direction consistency: dot product of velocity vectors
                prev_mag = math.sqrt(prev_vx**2 + prev_vy**2)
                curr_mag = math.sqrt(vx**2 + vy**2)
                if prev_mag > 0 and curr_mag > 0:
                    dot = (prev_vx * vx + prev_vy * vy) / (prev_mag * curr_mag)
                    # Must be going in roughly the same direction (cos > -0.3 = within ~105°)
                    if dot < -0.3:
                        continue
                    # Speed shouldn't change more than 4x
                    speed_ratio = max(curr_mag, prev_mag) / (min(curr_mag, prev_mag) + 0.01)
                    if speed_ratio > 4.0:
                        continue

            chain.append(curr)
            prev_vx, prev_vy = vx, vy

        if len(chain) > len(best):
            best = chain

    return best


def _linear_fit_filter(chain: List[Dict], max_residual_px: float = 40.0) -> List[Dict]:
    """
    Fit a line (or gentle curve) through the chain and remove outliers
    that deviate more than max_residual_px from the fitted path.
    Baseball paths are approximately linear (slightly curved due to gravity).
    """
    if len(chain) < 3:
        return chain

    xs = np.array([d["cx"] for d in chain], dtype=float)
    ys = np.array([d["cy"] for d in chain], dtype=float)
    ts = np.array([d["frame_idx"] for d in chain], dtype=float)

    # Fit x(t) and y(t) as polynomials (degree 2 for slight curve)
    try:
        px = np.polyfit(ts, xs, min(2, len(chain) - 1))
        py = np.polyfit(ts, ys, min(2, len(chain) - 1))
    except Exception:
        return chain

    filtered = []
    for d in chain:
        x_fit = np.polyval(px, d["frame_idx"])
        y_fit = np.polyval(py, d["frame_idx"])
        residual = math.sqrt((d["cx"] - x_fit)**2 + (d["cy"] - y_fit)**2)
        if residual <= max_residual_px:
            filtered.append(d)

    return filtered if len(filtered) >= 2 else chain


def _extract_best_trajectory(detections: List[Dict], total_frames: int) -> List[Dict]:
    """
    From raw per-frame detections, extract the most physically consistent
    ball trajectory. Uses velocity consistency + linear path filtering.
    """
    if not detections:
        return []

    # One best candidate per frame
    by_frame: Dict[int, Dict] = {}
    for d in detections:
        fi = d["frame_idx"]
        if fi not in by_frame or d["score"] > by_frame[fi]["score"]:
            by_frame[fi] = d

    if len(by_frame) < 2:
        return list(by_frame.values())

    ordered = sorted(by_frame.values(), key=lambda d: d["frame_idx"])

    # Step 1: velocity-consistent chain
    chain = _velocity_consistent_chain(ordered)

    # Step 2: remove outliers that don't fit the path
    if len(chain) >= 3:
        chain = _linear_fit_filter(chain, max_residual_px=45.0)

    return chain if chain else ordered[:5]


# ── Encode helper ──────────────────────────────────────────────────────────────

def _encode(frame: np.ndarray, quality: int = 85) -> str:
    max_w = 800
    if frame.shape[1] > max_w:
        s = max_w / frame.shape[1]
        frame = cv2.resize(frame, (int(frame.shape[1]*s), int(frame.shape[0]*s)))
    _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return base64.b64encode(buf).decode()


def _annotate(frame: np.ndarray, trajectory: List[Dict],
              plate: Dict, release: Optional[Dict] = None) -> np.ndarray:
    out = frame.copy()
    # Trajectory line
    t = sorted(trajectory, key=lambda d: d["frame_idx"])
    for i in range(1, len(t)):
        cv2.line(out, (t[i-1]["cx"], t[i-1]["cy"]),
                 (t[i]["cx"], t[i]["cy"]), (0, 165, 255), 2)
    # Release point
    if release:
        cv2.circle(out, (release["cx"], release["cy"]), release["r"]+4, (0, 255, 255), 2)
        cv2.putText(out, "Release", (release["cx"]+6, release["cy"]-6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 2)
    # Plate crossing
    cv2.circle(out, (plate["cx"], plate["cy"]), plate["r"]+6, (0, 255, 0), 3)
    cv2.circle(out, (plate["cx"], plate["cy"]), 4, (0, 255, 0), -1)
    cv2.putText(out, "Plate", (plate["cx"]+6, plate["cy"]-6),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
    return out


# ── Load video frames ──────────────────────────────────────────────────────────

def _load_frames(video_path: str):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return None, 0, 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frames = []
    while True:
        ret, f = cap.read()
        if not ret:
            break
        frames.append(f)
    cap.release()
    return frames, total, fps


# ── Catcher POV ────────────────────────────────────────────────────────────────

def analyze_pitch_video(video_path: str) -> Dict:
    """Catcher POV: ball comes toward camera, detected in lower portion of frame."""
    frames, total_frames, fps = _load_frames(video_path)
    if frames is None:
        return {"error": "Cannot open video file", "detected": False}
    if len(frames) < 3:
        return {"error": "Video too short", "detected": False,
                "total_frames": len(frames), "fps": fps, "duration": round(len(frames)/fps, 2)}

    h_px, w_px = frames[0].shape[:2]
    duration = round(len(frames) / fps, 2)

    all_det = []
    for i, frame in enumerate(frames):
        for c in detect_candidates(frame,
                                   frames[i-1] if i >= 1 else None,
                                   frames[i-2] if i >= 2 else None):
            nx, ny = px_to_norm(c["cx"], c["cy"], w_px, h_px, CATCHER_ZONE)
            all_det.append({**c, "frame_idx": i,
                             "norm_x": round(nx, 3), "norm_y": round(ny, 3)})

    if not all_det:
        return {"detected": False, "error": "No ball detected",
                "total_frames": len(frames), "fps": fps, "duration": duration,
                "debug": "Try better lighting, higher contrast background, or use the calibration tool."}

    traj = _extract_best_trajectory(all_det, len(frames))
    if not traj:
        traj = all_det

    # Plate crossing = deepest in frame + latest
    def plate_score(d):
        return (d["cy"] / h_px) * 0.7 + (d["frame_idx"] / len(frames)) * 0.3

    plate = max(traj, key=plate_score)
    norm_x = max(-2.0, min(2.0, plate["norm_x"]))
    norm_y = max(-2.0, min(2.0, plate["norm_y"]))

    best = _annotate(frames[plate["frame_idx"]].copy(), traj, plate)
    return {
        "detected": True,
        "norm_x": norm_x, "norm_y": norm_y,
        "trajectory_length": len(traj),
        "total_detections": len(all_det),
        "total_frames": len(frames), "fps": fps, "duration": duration,
        "frame_b64": _encode(best),
    }


# ── Pitcher POV ────────────────────────────────────────────────────────────────

def analyze_pitcher_pov(video_path: str) -> Dict:
    """Pitcher POV: ball moves away, gets smaller. Release = early/large, plate = late/small."""
    frames, total_frames, fps = _load_frames(video_path)
    if frames is None:
        return {"error": "Cannot open video file", "detected": False}
    if len(frames) < 3:
        return {"error": "Video too short", "detected": False,
                "total_frames": len(frames), "fps": fps, "duration": round(len(frames)/fps, 2)}

    h_px, w_px = frames[0].shape[:2]
    duration = round(len(frames) / fps, 2)

    all_det = []
    for i, frame in enumerate(frames):
        for c in detect_candidates(frame,
                                   frames[i-1] if i >= 1 else None,
                                   frames[i-2] if i >= 2 else None):
            nx, ny = px_to_norm(c["cx"], c["cy"], w_px, h_px, PITCHER_ZONE)
            all_det.append({**c, "frame_idx": i,
                             "norm_x": round(nx, 3), "norm_y": round(ny, 3)})

    if not all_det:
        return {"detected": False, "error": "No ball detected",
                "total_frames": len(frames), "fps": fps, "duration": duration}

    traj = _extract_best_trajectory(all_det, len(frames))
    if not traj:
        traj = all_det

    traj_sorted = sorted(traj, key=lambda d: d["frame_idx"])
    release = traj_sorted[0]
    # Plate = latest + smallest radius (farthest away)
    late = traj_sorted[max(0, int(len(traj_sorted)*0.6)):]
    plate = min(late, key=lambda d: d["r"]) if late else traj_sorted[-1]

    norm_x = max(-2.0, min(2.0, plate["norm_x"]))
    norm_y = max(-2.0, min(2.0, plate["norm_y"]))

    # Mechanics
    h_break = round((plate["norm_x"] - release["norm_x"]) * 8.5)
    v_drop  = round((release["norm_y"] - plate["norm_y"]) * 17)

    rel_h = release["cy"] / h_px
    mechanics = {}
    mechanics["release_height"] = (
        "High release point — good downhill plane" if rel_h < 0.3 else
        "Mid release point — solid arm slot" if rel_h < 0.55 else
        "Low/dropped arm slot — check for fatigue or mechanical drift"
    )
    mechanics["horizontal_break"] = (
        f"Arm-side run of ~{abs(h_break)}\" — natural fade/sink" if h_break > 2 else
        f"Glove-side cut of ~{abs(h_break)}\" — cutter/slider movement" if h_break < -2 else
        "Minimal horizontal movement — straight pitch"
    )
    mechanics["vertical_drop"] = (
        f"Heavy drop of ~{v_drop}\" — good downhill plane" if v_drop > 20 else
        f"Normal drop of ~{v_drop}\"" if v_drop > 8 else
        f"Flat trajectory (~{v_drop}\") — may get squared up in the zone"
    )

    best = _annotate(frames[plate["frame_idx"]].copy(), traj_sorted, plate, release)
    return {
        "detected": True,
        "plate_norm_x": norm_x, "plate_norm_y": norm_y,
        "release_point": {"cx_pct": round(release["cx"]/w_px, 3),
                          "cy_pct": round(release["cy"]/h_px, 3)},
        "horizontal_break_inches": h_break,
        "vertical_drop_inches": v_drop,
        "trajectory_length": len(traj_sorted),
        "total_detections": len(all_det),
        "total_frames": len(frames), "fps": fps, "duration": duration,
        "mechanics": mechanics,
        "frame_b64": _encode(best),
    }


# ── Broadcast / side-view ──────────────────────────────────────────────────────

def analyze_broadcast_pov(video_path: str) -> Dict:
    """
    Broadcast / center-field / side-view camera.
    Ball moves roughly HORIZONTALLY across the frame (left→right or right→left).
    Provides: pitch location at plate, horizontal break, vertical drop, trajectory shape.
    """
    frames, total_frames, fps = _load_frames(video_path)
    if frames is None:
        return {"error": "Cannot open video file", "detected": False}
    if len(frames) < 3:
        return {"error": "Video too short", "detected": False,
                "total_frames": len(frames), "fps": fps, "duration": round(len(frames)/fps, 2)}

    h_px, w_px = frames[0].shape[:2]
    duration = round(len(frames) / fps, 2)

    # For broadcast: restrict detection to relevant vertical band
    # (roughly middle 70% of frame height — avoid scoreboard at top and grass at bottom)
    y_start = int(h_px * 0.15)
    y_end   = int(h_px * 0.85)

    all_det = []
    for i, frame in enumerate(frames):
        # Crop to relevant band for detection
        crop  = frame[y_start:y_end, :]
        prev  = frames[i-1][y_start:y_end, :] if i >= 1 else None
        pp    = frames[i-2][y_start:y_end, :] if i >= 2 else None
        for c in detect_candidates(crop, prev, pp, max_radius=20):
            # Adjust cy back to full-frame coords
            c["cy"] += y_start
            nx, ny = px_to_norm(c["cx"], c["cy"], w_px, h_px, BROADCAST_ZONE)
            all_det.append({**c, "frame_idx": i,
                             "norm_x": round(nx, 3), "norm_y": round(ny, 3)})

    if not all_det:
        return {"detected": False, "error": "No ball detected in broadcast video",
                "total_frames": len(frames), "fps": fps, "duration": duration,
                "debug": "Broadcast detection works best with HD video, clear sky/batter background, and the ball in frame for ≥5 frames."}

    traj = _extract_best_trajectory(all_det, len(frames))
    if not traj:
        traj = all_det[:10]

    traj_sorted = sorted(traj, key=lambda d: d["frame_idx"])

    # In broadcast view: pitcher side = early frames, plate side = late frames
    release = traj_sorted[0]
    plate   = traj_sorted[-1]

    norm_x = max(-2.0, min(2.0, plate["norm_x"]))
    norm_y = max(-2.0, min(2.0, plate["norm_y"]))

    # Movement analysis
    h_break = round((plate["cx"] - release["cx"]) / w_px * 17 * 3)
    v_drop  = round((plate["cy"] - release["cy"]) / h_px * 24)

    mechanics = {}
    mechanics["horizontal_movement"] = (
        f"Ball moved {abs(h_break)}\" toward the arm side" if h_break > 3 else
        f"Ball moved {abs(h_break)}\" toward the glove side" if h_break < -3 else
        "Minimal horizontal movement — straight pitch"
    )
    mechanics["vertical_drop"] = (
        f"Significant drop of ~{v_drop}\" — heavy sink or breaking ball" if v_drop > 20 else
        f"Normal drop of ~{v_drop}\" — standard pitch plane" if v_drop > 8 else
        f"Flat trajectory (~{v_drop}\") — keep it in the lower half to avoid barrels"
    )
    if len(traj_sorted) >= 4:
        mechanics["trajectory"] = f"Ball tracked across {len(traj_sorted)} frames — good for analysis"

    best = _annotate(frames[plate["frame_idx"]].copy(), traj_sorted, plate, release)
    return {
        "detected": True,
        "plate_norm_x": norm_x, "plate_norm_y": norm_y,
        "horizontal_break_inches": h_break,
        "vertical_drop_inches": v_drop,
        "trajectory_length": len(traj_sorted),
        "total_detections": len(all_det),
        "total_frames": len(frames), "fps": fps, "duration": duration,
        "mechanics": mechanics,
        "frame_b64": _encode(best),
    }


# ── Live camera helpers (used by WebSocket stream) ────────────────────────────

def encode_frame(frame: np.ndarray, quality: int = 70) -> str:
    return _encode(frame, quality)


def draw_overlay(frame: np.ndarray, tracker_result: dict, cal_px: Optional[dict]) -> np.ndarray:
    out = frame.copy()
    h, w = out.shape[:2]
    if cal_px:
        pts = np.array([cal_px["tl"], cal_px["tr"], cal_px["br"], cal_px["bl"]], dtype=np.int32)
        cv2.polylines(out, [pts], True, (0, 255, 0), 2)
    for d in tracker_result.get("detections", []):
        cv2.circle(out, (d["cx"], d["cy"]), d["r"], (0, 0, 255), 2)
    traj = tracker_result.get("trajectory", [])
    for i in range(1, len(traj)):
        cv2.line(out, (traj[i-1]["cx"], traj[i-1]["cy"]),
                 (traj[i]["cx"], traj[i]["cy"]), (0, 165, 255), 2)
    if tracker_result.get("pitch_detected"):
        loc = tracker_result["pitch_location"]
        cv2.putText(out, f"PITCH x:{loc['x']:.2f} y:{loc['y']:.2f}",
                    (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
    arrival_y = int(h * 0.75)
    cv2.line(out, (0, arrival_y), (w, arrival_y), (255, 255, 0), 1)
    return out
