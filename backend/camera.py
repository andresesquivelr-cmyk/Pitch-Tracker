"""
camera.py — Live camera capture, ball detection, and strike zone mapping.

Pipeline (catcher POV, fixed mount):
  1. Grab frame from OpenCV VideoCapture
  2. Background subtraction (MOG2) isolates moving objects
  3. Find contours → filter by area (baseball ≈ 20–120 px² at typical distance)
  4. Hough circle detection confirms round shape
  5. Track ball trajectory across frames
  6. When ball reaches the "arrival zone" (near the bottom of the frame / plate),
     capture its centroid and map to normalized strike zone coords using calibration.
  7. Send detected location back over WebSocket.
"""

import cv2
import numpy as np
import base64
import time
import json
import math
from collections import deque
from dataclasses import dataclass, field
from typing import Optional, Tuple, List

# ── Calibration store (in-memory, one per camera session) ─────────────────────
# calibration = { "tl": (px,py), "tr": (px,py), "bl": (px,py), "br": (px,py) }
_calibration: Optional[dict] = None
_camera_index: int = 0

def set_calibration(tl, tr, bl, br):
    global _calibration
    _calibration = {"tl": tl, "tr": tr, "bl": bl, "br": br}

def get_calibration():
    return _calibration

def clear_calibration():
    global _calibration
    _calibration = None

def pixel_to_norm(px: float, py: float) -> Tuple[float, float]:
    """
    Map a pixel coordinate to normalized strike zone coords (-1 to 1).
    Uses bilinear interpolation across the 4 calibration corners.
    """
    if _calibration is None:
        # fallback: assume zone is center 40% width, middle 50% height of frame
        return (px - 0.5) * 2.5, (0.5 - py) * 2.5

    tl = _calibration["tl"]
    tr = _calibration["tr"]
    bl = _calibration["bl"]
    br = _calibration["br"]

    # Find horizontal interpolation parameter (u) and vertical (v)
    # using the top and bottom edges
    def lerp(a, b, t):
        return a + t * (b - a)

    # Estimate u: how far left-to-right across the zone
    zone_width_top = tr[0] - tl[0]
    zone_width_bot = br[0] - bl[0]
    if zone_width_top == 0: zone_width_top = 1
    if zone_width_bot == 0: zone_width_bot = 1

    u_top = (px - tl[0]) / zone_width_top
    u_bot = (px - bl[0]) / zone_width_bot

    # Estimate v: how far top-to-bottom
    top_y = lerp(tl[1], tr[1], (u_top + u_bot) / 2)
    bot_y = lerp(bl[1], br[1], (u_top + u_bot) / 2)
    zone_height = bot_y - top_y
    if zone_height == 0: zone_height = 1
    v = (py - top_y) / zone_height

    u = (u_top + u_bot) / 2

    # Convert to -1..1 (x: left=-1, right=1; y: bottom=-1, top=1)
    norm_x = u * 2 - 1
    norm_y = 1 - v * 2  # invert: top of frame = high in zone

    return (
        max(-1.5, min(1.5, norm_x)),
        max(-1.5, min(1.5, norm_y))
    )


# ── Ball tracker ───────────────────────────────────────────────────────────────

@dataclass
class BallTracker:
    history: deque = field(default_factory=lambda: deque(maxlen=30))
    bg_subtractor: any = field(default_factory=lambda: cv2.createBackgroundSubtractorMOG2(
        history=200, varThreshold=50, detectShadows=False
    ))
    last_detection_time: float = 0.0
    cooldown: float = 2.0  # seconds between pitch detections
    arrival_threshold: float = 0.75  # ball must be in bottom 75% of frame height to count

    def detect(self, frame: np.ndarray) -> Optional[Tuple[int, int, int]]:
        """
        Returns (cx, cy, radius) of detected ball in this frame, or None.
        """
        fg_mask = self.bg_subtractor.apply(frame)

        # Morphological cleanup
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        fg_mask = cv2.morphologyEx(fg_mask, cv2.MORPH_OPEN, kernel)
        fg_mask = cv2.dilate(fg_mask, kernel, iterations=2)

        # Find contours
        contours, _ = cv2.findContours(fg_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        candidates = []
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < 15 or area > 2500:  # filter by area (baseball size range)
                continue
            perimeter = cv2.arcLength(cnt, True)
            if perimeter == 0:
                continue
            circularity = 4 * math.pi * area / (perimeter ** 2)
            if circularity < 0.4:  # must be fairly round
                continue
            x, y, w, h = cv2.boundingRect(cnt)
            aspect = w / h if h > 0 else 0
            if aspect < 0.5 or aspect > 2.0:  # not too elongated
                continue
            cx = x + w // 2
            cy = y + h // 2
            r = max(w, h) // 2
            candidates.append((cx, cy, r, circularity, area))

        if not candidates:
            return None

        # Pick the most circular candidate
        candidates.sort(key=lambda c: c[3], reverse=True)
        cx, cy, r, _, _ = candidates[0]
        return (cx, cy, r)

    def process_frame(self, frame: np.ndarray) -> dict:
        """
        Process one frame. Returns a dict with:
          - detections: list of {cx, cy, r} for all candidates
          - pitch_detected: bool
          - pitch_location: {x, y} normalized (if detected)
          - trajectory: list of recent {cx, cy}
        """
        h, w = frame.shape[:2]
        now = time.time()
        result = {
            "detections": [],
            "pitch_detected": False,
            "pitch_location": None,
            "trajectory": list(self.history),
        }

        detection = self.detect(frame)
        if detection:
            cx, cy, r = detection
            result["detections"].append({"cx": cx, "cy": cy, "r": r})
            self.history.append({"cx": cx, "cy": cy})

            # Check if ball has arrived at the plate zone
            # and enough time has passed since last detection
            in_arrival_zone = cy > h * self.arrival_threshold
            cooled_down = (now - self.last_detection_time) > self.cooldown
            trajectory_long_enough = len(self.history) >= 4

            if in_arrival_zone and cooled_down and trajectory_long_enough:
                # Verify the ball is moving toward the camera (y increasing over trajectory)
                recent = list(self.history)[-6:]
                ys = [p["cy"] for p in recent]
                moving_toward_plate = ys[-1] > ys[0]  # y increases as ball approaches

                if moving_toward_plate:
                    norm_x, norm_y = pixel_to_norm(cx / w, cy / h)
                    result["pitch_detected"] = True
                    result["pitch_location"] = {"x": norm_x, "y": norm_y}
                    self.last_detection_time = now
                    self.history.clear()

        return result

    def reset(self):
        self.history.clear()
        self.last_detection_time = 0.0


# ── Frame encoding helper ──────────────────────────────────────────────────────

def encode_frame(frame: np.ndarray, quality: int = 70) -> str:
    """Encode an OpenCV frame as base64 JPEG."""
    # Scale down for streaming
    h, w = frame.shape[:2]
    max_w = 640
    if w > max_w:
        scale = max_w / w
        frame = cv2.resize(frame, (int(w * scale), int(h * scale)))
    _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return base64.b64encode(buf).decode()


def draw_overlay(frame: np.ndarray, tracker_result: dict, calibration: Optional[dict]) -> np.ndarray:
    """Draw detection overlay on the frame."""
    out = frame.copy()
    h, w = out.shape[:2]

    # Draw calibration zone
    if calibration:
        pts = np.array([
            calibration["tl"], calibration["tr"],
            calibration["br"], calibration["bl"]
        ], dtype=np.int32)
        cv2.polylines(out, [pts], True, (0, 255, 0), 2)

        # Draw 9-zone grid inside
        tl, tr = calibration["tl"], calibration["tr"]
        bl, br = calibration["bl"], calibration["br"]
        for t in [1/3, 2/3]:
            # Vertical lines
            top_pt = (int(tl[0] + t*(tr[0]-tl[0])), int(tl[1] + t*(tr[1]-tl[1])))
            bot_pt = (int(bl[0] + t*(br[0]-bl[0])), int(bl[1] + t*(br[1]-bl[1])))
            cv2.line(out, top_pt, bot_pt, (0, 200, 0), 1)
            # Horizontal lines
            left_pt = (int(tl[0] + t*(bl[0]-tl[0])), int(tl[1] + t*(bl[1]-tl[1])))
            right_pt = (int(tr[0] + t*(br[0]-tr[0])), int(tr[1] + t*(br[1]-tr[1])))
            cv2.line(out, left_pt, right_pt, (0, 200, 0), 1)

    # Draw trajectory
    traj = tracker_result.get("trajectory", [])
    for i in range(1, len(traj)):
        pt1 = (traj[i-1]["cx"], traj[i-1]["cy"])
        pt2 = (traj[i]["cx"], traj[i]["cy"])
        cv2.line(out, pt1, pt2, (0, 165, 255), 2)

    # Draw current detections
    for d in tracker_result.get("detections", []):
        cv2.circle(out, (d["cx"], d["cy"]), d["r"], (0, 0, 255), 2)
        cv2.circle(out, (d["cx"], d["cy"]), 3, (0, 0, 255), -1)

    # Pitch detected flash
    if tracker_result.get("pitch_detected"):
        loc = tracker_result["pitch_location"]
        cv2.putText(out, f"PITCH DETECTED  x:{loc['x']:.2f} y:{loc['y']:.2f}",
                    (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)

    # Arrival zone line
    arrival_y = int(h * 0.75)
    cv2.line(out, (0, arrival_y), (w, arrival_y), (255, 255, 0), 1)
    cv2.putText(out, "Arrival zone", (5, arrival_y - 5),
                cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 0), 1)

    return out


def list_cameras(max_test: int = 5) -> List[dict]:
    """Return list of available camera indices and names."""
    cameras = []
    for i in range(max_test):
        cap = cv2.VideoCapture(i)
        if cap.isOpened():
            w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            cameras.append({"index": i, "label": f"Camera {i}", "resolution": f"{w}x{h}"})
            cap.release()
    return cameras


def grab_still(camera_index: int = 0) -> Optional[str]:
    """Grab a single frame from the camera and return as base64 JPEG."""
    cap = cv2.VideoCapture(camera_index)
    if not cap.isOpened():
        return None
    ret, frame = cap.read()
    cap.release()
    if not ret:
        return None
    return encode_frame(frame, quality=85)
