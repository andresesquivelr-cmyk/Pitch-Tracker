"""
mechanics.py — Automatic pitching mechanics analysis using MediaPipe Pose.

Detects the 4 most common pitcher faults (from D1/JUCO coaching experience):
  1. Pulling the body / early shoulder rotation
  2. Not driving toward the target (trunk direction)
  3. Insufficient hip-shoulder separation
  4. Inconsistent / low release point

Returns: annotated frames, 9 biomechanical metrics, fault interpretations,
         'what's working' positives, and a personalized drill + training plan.
"""

import cv2
import numpy as np
import math
import base64
from typing import Optional, List, Tuple

try:
    import mediapipe as mp
    MEDIAPIPE_AVAILABLE = True
    _mp_pose = mp.solutions.pose
except ImportError:
    MEDIAPIPE_AVAILABLE = False

# ── Landmark indices (MediaPipe Pose, 33-point model) ─────────────────────────
L_SHOULDER, R_SHOULDER = 11, 12
L_ELBOW,    R_ELBOW    = 13, 14
L_WRIST,    R_WRIST    = 15, 16
L_HIP,      R_HIP      = 23, 24
L_KNEE,     R_KNEE     = 25, 26
L_ANKLE,    R_ANKLE    = 27, 28

# ── Geometry helpers ──────────────────────────────────────────────────────────

def angle_from_horizontal(p1, p2) -> float:
    dx = p2[0] - p1[0]
    dy = -(p2[1] - p1[1])
    return math.degrees(math.atan2(dy, abs(dx) + 1e-9))


def body_height(lms) -> float:
    sy = (lms[L_SHOULDER][1] + lms[R_SHOULDER][1]) / 2
    ay = (lms[L_ANKLE][1]    + lms[R_ANKLE][1])    / 2
    return max(abs(ay - sy), 0.001)


def line_angle(p1, p2) -> float:
    """Full 360° angle of vector p1→p2 in screen coords."""
    dx = p2[0] - p1[0]
    dy = p2[1] - p1[1]
    return math.degrees(math.atan2(dy, dx + 1e-9))

# ── Throwing-side detection ───────────────────────────────────────────────────

def detect_throwing_side(lm_seq: list) -> str:
    valid = [lm for lm in lm_seq if lm is not None]
    if not valid:
        return 'R'
    r_xs = [lm[R_WRIST][0] for lm in valid]
    l_xs = [lm[L_WRIST][0] for lm in valid]
    return 'R' if (max(r_xs) - min(r_xs)) >= (max(l_xs) - min(l_xs)) else 'L'

# ── Key frame detection ───────────────────────────────────────────────────────

def find_release_idx(lm_seq: list, throwing_side: str) -> int:
    wr = R_WRIST if throwing_side == 'R' else L_WRIST
    xs = [lm[wr][0] if lm is not None else None for lm in lm_seq]
    valid = [(i, x) for i, x in enumerate(xs) if x is not None]
    if len(valid) < 4:
        return len(lm_seq) // 2

    vels = []
    for k in range(1, len(valid)):
        i0, x0 = valid[k - 1]
        i1, x1 = valid[k]
        dt = i1 - i0
        if dt > 0:
            vels.append((i1, abs(x1 - x0) / dt))

    if not vels:
        return len(lm_seq) // 2

    n = len(lm_seq)
    candidates = [(idx, v) for idx, v in vels if 0.20 * n <= idx <= 0.75 * n]
    if not candidates:
        candidates = vels

    return max(candidates, key=lambda x: x[1])[0]


def find_stride_idx(lm_seq: list, release_idx: int, throwing_side: str) -> int:
    stride_ankle = L_ANKLE if throwing_side == 'R' else R_ANKLE
    start = max(0, int(release_idx - len(lm_seq) * 0.30))
    end   = max(start + 1, release_idx)

    pts = []
    for i in range(start, end):
        if lm_seq[i] is not None:
            pts.append((i, lm_seq[i][stride_ankle][0]))

    if len(pts) < 3:
        return max(0, release_idx - 3)

    vels = []
    for k in range(1, len(pts)):
        i0, x0 = pts[k - 1]
        i1, x1 = pts[k]
        dt = i1 - i0
        if dt > 0:
            vels.append((i1, abs(x1 - x0) / dt))

    return min(vels, key=lambda x: x[1])[0] if vels else max(0, release_idx - 3)

# ── Metrics computation ───────────────────────────────────────────────────────

def compute_metrics(release_lms: list, stride_lms: list, throwing_side: str) -> dict:
    """
    Compute 9 biomechanical metrics. Key additions vs v1:
      - shoulder_openness_at_stride: how open shoulders are at stride plant (pulling detection)
      - trunk_direction: horizontal offset of shoulder mid vs hip mid at release
    """
    s   = throwing_side
    opp = 'L' if s == 'R' else 'R'

    sh_idx     = R_SHOULDER if s == 'R' else L_SHOULDER
    el_idx     = R_ELBOW    if s == 'R' else L_ELBOW
    wr_idx     = R_WRIST    if s == 'R' else L_WRIST
    str_ankle  = L_ANKLE    if s == 'R' else R_ANKLE
    back_ankle = R_ANKLE    if s == 'R' else L_ANKLE

    sh = release_lms[sh_idx]
    el = release_lms[el_idx]
    wr = release_lms[wr_idx]

    # ── 1. Arm slot ───────────────────────────────────────────────────────────
    arm_slot_angle = angle_from_horizontal(sh, wr)

    # ── 2. Elbow height relative to shoulder ─────────────────────────────────
    bh = body_height(release_lms)
    elbow_rel_shoulder = (sh[1] - el[1]) / bh

    # ── 3. Release height ─────────────────────────────────────────────────────
    ankle_avg_y = (release_lms[L_ANKLE][1] + release_lms[R_ANKLE][1]) / 2
    release_height_norm = (ankle_avg_y - wr[1]) / bh

    # ── 4. Hip-shoulder separation at RELEASE ─────────────────────────────────
    l_hip_r, r_hip_r = release_lms[L_HIP],      release_lms[R_HIP]
    l_sh_r,  r_sh_r  = release_lms[L_SHOULDER], release_lms[R_SHOULDER]
    hip_angle_r  = math.degrees(math.atan2(-(r_hip_r[1] - l_hip_r[1]), r_hip_r[0] - l_hip_r[0] + 1e-9))
    shl_angle_r  = math.degrees(math.atan2(-(r_sh_r[1]  - l_sh_r[1]),  r_sh_r[0]  - l_sh_r[0]  + 1e-9))
    hip_shoulder_sep = abs(shl_angle_r - hip_angle_r)

    # ── 5. Trunk lean (forward) ───────────────────────────────────────────────
    sh_mid  = ((l_sh_r[0]  + r_sh_r[0])  / 2, (l_sh_r[1]  + r_sh_r[1])  / 2)
    hp_mid  = ((l_hip_r[0] + r_hip_r[0]) / 2, (l_hip_r[1] + r_hip_r[1]) / 2)
    trunk_angle = angle_from_horizontal(hp_mid, sh_mid)

    # ── 6. Stride deviation ───────────────────────────────────────────────────
    stride_ankle_pos = stride_lms[str_ankle]
    back_ankle_pos   = stride_lms[back_ankle]
    hip_mid_x        = (stride_lms[L_HIP][0] + stride_lms[R_HIP][0]) / 2
    stride_dev_pct   = (stride_ankle_pos[0] - hip_mid_x) * 100

    # ── 7. Stride length ──────────────────────────────────────────────────────
    bh_stride  = body_height(stride_lms)
    stride_len = abs(stride_ankle_pos[0] - back_ankle_pos[0]) / bh_stride

    # ── 8. Shoulder openness at stride plant (PULLING DETECTION) ─────────────
    # At stride plant, how open are the shoulders already?
    # We measure the angle of the shoulder line at stride plant.
    # For RHP: if R shoulder is far ahead of L shoulder (open toward plate early), that's pulling.
    # Range: 0° = closed (shoulders perpendicular to target), higher = more open = pulling.
    l_sh_s = stride_lms[L_SHOULDER]
    r_sh_s = stride_lms[R_SHOULDER]
    # Angle of shoulder line at stride (absolute openness toward plate)
    # We use the deviation of the shoulder line from horizontal (which = fully open)
    shl_angle_stride = math.degrees(
        math.atan2(-(r_sh_s[1] - l_sh_s[1]), r_sh_s[0] - l_sh_s[0] + 1e-9)
    )
    # Normalize: 0° shoulder line = fully horizontal = fully open (bad for RHP)
    # 45°+ line = still closed = good
    shoulder_openness = max(0.0, 30.0 - abs(shl_angle_stride))  # higher = more open = worse

    # ── 9. Trunk direction toward plate ──────────────────────────────────────
    # At release, is the trunk driving toward home plate or flying open?
    # We compare horizontal position of shoulder midpoint vs hip midpoint.
    # For RHP (pitcher moves L→R from 3B to 1B side of mound, camera typically on 1B side):
    # If shoulder mid is significantly offset from hip mid, they're flying open or falling off.
    trunk_direction = (sh_mid[0] - hp_mid[0]) * 100  # % of frame width

    return {
        'arm_slot_angle':         round(arm_slot_angle,         1),
        'elbow_rel_shoulder':     round(elbow_rel_shoulder,     3),
        'release_height_norm':    round(release_height_norm,    3),
        'hip_shoulder_sep':       round(hip_shoulder_sep,       1),
        'trunk_angle':            round(trunk_angle,            1),
        'stride_dev_pct':         round(stride_dev_pct,         1),
        'stride_len_norm':        round(stride_len,             3),
        'shoulder_openness':      round(shoulder_openness,      1),
        'trunk_direction':        round(trunk_direction,        1),
    }

# ── Drill database ────────────────────────────────────────────────────────────

DRILLS = {
    'hip_separation': [
        {
            'name': 'Hip-to-Hip Isolation',
            'how': 'From set position, practice bumping hips toward the plate before any shoulder movement. Freeze at hip load — shoulders should still face 3B side (RHP). Then rotate.',
            'reps': '3 sets × 10 reps, daily',
        },
        {
            'name': 'Resistance Band Separation',
            'how': 'Wrap a band around your waist anchored behind you. Wind up and drive hips while the band fights your shoulder rotation. Forces you to lead with hips.',
            'reps': '3 sets × 8 reps, 3x/week',
        },
        {
            'name': 'Medicine Ball Hip Throws',
            'how': 'Stand sideways to a wall, 4 feet away. Load hips, drive hip rotation, throw med ball into wall using only hip-generated rotation. No upper body pull.',
            'reps': '3 sets × 10 throws each side, 3x/week',
        },
    ],
    'pulling': [
        {
            'name': 'Stay Closed Towel Drill',
            'how': 'Hold a towel in your throwing hand. Go through full delivery focused on keeping front shoulder pointed at 3B (RHP) until stride foot plants. Snap towel at target only after plant.',
            'reps': '15 reps per bullpen session',
        },
        {
            'name': 'Wall Hip Bump',
            'how': 'Stand with glove-side shoulder 6 inches from a wall. Go into wind-up — if you pull early, your glove shoulder hits the wall. Build awareness of early opening.',
            'reps': '10 reps daily as warmup',
        },
        {
            'name': 'Closed-Stance Pick-Off Drill',
            'how': 'Practice throwing to first base from a closed stance. Builds the muscle memory of keeping shoulders closed while driving lower half. Transfer into delivery.',
            'reps': '10 reps per session',
        },
    ],
    'release_point': [
        {
            'name': 'One-Knee Drill',
            'how': 'Kneel on throwing-side knee. Focus entirely on arm path and release point. Find the exact spot where the ball exits your hand consistently. Film from behind or side.',
            'reps': '20 throws per session — feel the release height and repeat it',
        },
        {
            'name': 'Mirror Drill',
            'how': 'Slow motion delivery in front of a full-length mirror. Pause at release position and hold for 3 seconds. Engrave the feeling of being tall at release.',
            'reps': '10 reps daily',
        },
        {
            'name': 'Target String Drill',
            'how': 'Hang a string or cord at the height you want to release the ball. Throw and make sure your hand crosses above the string at release. Builds height awareness.',
            'reps': '20 throws per flat-ground session',
        },
    ],
    'trunk_direction': [
        {
            'name': 'Chalk Line Drill',
            'how': 'Draw a chalk line from the rubber straight to home plate. Your stride foot, landing foot, and follow-through should all stay on or inside this line. Keeps your body driving at the target.',
            'reps': 'Every bullpen session',
        },
        {
            'name': 'Chest to Target Finish',
            'how': 'After release, hold your follow-through and check: is your chest pointing directly at home plate? If not, you fell off or flew open. Film and review each rep.',
            'reps': '15 reps flat ground, focus on finish',
        },
    ],
    'elbow_drop': [
        {
            'name': 'Arm Care — External Rotation Band Work',
            'how': 'Stand with elbow at 90°, band anchored at elbow height. Rotate outward against resistance. Builds the external rotators that keep elbow up at release.',
            'reps': '3 sets × 15 reps daily (pre-throw)',
        },
        {
            'name': '"Thumb to Thigh" Arm Path Cue',
            'how': 'As your arm swings down before coming up to release, think "thumb goes to thigh." This prevents the arm from getting stuck behind the body and the elbow from dropping.',
            'reps': 'Mental cue on every bullpen throw',
        },
    ],
    'stride': [
        {
            'name': 'Stride Target Drill',
            'how': 'Place a small cone or piece of tape at your ideal stride landing spot (directly toward plate). Focus on driving that stride foot to the target, not opening.',
            'reps': '20 throws per session',
        },
        {
            'name': 'Rocker Drill',
            'how': 'Without a full wind-up, rock back onto back foot, drive stride toward target cone, and throw. Builds muscle memory for stride direction.',
            'reps': '15 reps flat ground',
        },
    ],
}

# ── Interpretation + coaching text ───────────────────────────────────────────

def interpret(metrics: dict) -> dict:
    results = {}

    # ── Arm slot ──────────────────────────────────────────────────────────────
    angle = metrics['arm_slot_angle']
    if angle > 72:
        results['arm_slot'] = {
            'label': 'Over-the-Top', 'color': 'blue', 'status': 'info',
            'text': 'Maximum downward plane — ideal for 12-6 breaking balls. High shoulder stress; prioritize shoulder care and long toss.',
            'positive': 'Creates steep downward angle that makes high fastballs and 12-6 curveballs extremely effective.',
        }
    elif angle > 52:
        results['arm_slot'] = {
            'label': '3/4 Slot', 'color': 'green', 'status': 'good',
            'text': 'Optimal slot — best balance of velocity, late movement, and long-term arm health.',
            'positive': 'Natural run and cut on fastball. Most pitches move well from this slot. Shoulder-friendly.',
        }
    elif angle > 30:
        results['arm_slot'] = {
            'label': 'Low 3/4', 'color': 'yellow', 'status': 'warning',
            'text': 'Sweeping horizontal break on all pitches. Effective same-side. Stay closed through hip drive.',
            'positive': 'Creates late horizontal sweep — very tough on same-handed batters.',
        }
    else:
        results['arm_slot'] = {
            'label': 'Sidearm / Submarine', 'color': 'orange', 'status': 'info',
            'text': 'Highly deceptive. Only sustainable if natural — do not force it.',
            'positive': 'Extreme deception against same-handed hitters. Historically very effective relievers.',
        }

    # ── Elbow ─────────────────────────────────────────────────────────────────
    elbow_ok = metrics['elbow_rel_shoulder'] > -0.03
    if elbow_ok:
        results['elbow'] = {
            'label': 'Good elevation', 'color': 'green', 'status': 'good',
            'text': 'Elbow at or above shoulder at release — healthy arm position, maximum carry.',
            'positive': 'Arm health protected. Ball exits high with good plane.',
            'drills': [],
        }
    else:
        results['elbow'] = {
            'label': 'Elbow drop', 'color': 'red', 'status': 'fault',
            'text': 'Elbow below shoulder at release — UCL/shoulder stress risk and reduced velocity. Keep elbow up through delivery.',
            'positive': None,
            'drills': DRILLS['elbow_drop'],
        }

    # ── Release height ────────────────────────────────────────────────────────
    h = metrics['release_height_norm']
    if h > 0.75:
        results['release_height'] = {
            'label': 'Excellent height', 'color': 'green', 'status': 'good',
            'text': 'Tall at release — maximum downward plane. Hitters see the ball coming steeply down.',
            'positive': 'Pitches have excellent downward angle. Hard to elevate against.',
            'drills': [],
        }
    elif h > 0.55:
        results['release_height'] = {
            'label': 'Good', 'color': 'green', 'status': 'good',
            'text': 'Solid release height with good downward angle through the zone.',
            'positive': 'Consistent release height helps all pitch types move predictably.',
            'drills': [],
        }
    elif h > 0.35:
        results['release_height'] = {
            'label': 'Needs work', 'color': 'yellow', 'status': 'warning',
            'text': 'Moderate height — getting topped or releasing early. Cue: "hip first, arm second." Drive hips before pulling.',
            'positive': None,
            'drills': DRILLS['release_point'],
        }
    else:
        results['release_height'] = {
            'label': 'Low / Early release', 'color': 'red', 'status': 'fault',
            'text': 'Releasing too early or collapsing at release. Wait until stride foot fully plants before arm action.',
            'positive': None,
            'drills': DRILLS['release_point'],
        }

    # ── Hip-shoulder separation ───────────────────────────────────────────────
    sep = metrics['hip_shoulder_sep']
    if sep > 28:
        results['hip_separation'] = {
            'label': f'{sep:.0f}° — Good separation', 'color': 'green', 'status': 'good',
            'text': 'Hips clearly leading shoulders. Generating proper torque and velocity.',
            'positive': f'{sep:.0f}° of separation is driving velocity and late movement. This is a real weapon.',
            'drills': [],
        }
    elif sep > 15:
        results['hip_separation'] = {
            'label': f'{sep:.0f}° — Moderate', 'color': 'yellow', 'status': 'warning',
            'text': f'{sep:.0f}° separation. Push for 30°+. Drive hips harder before rotating shoulder — think "hip bump, then shoulder."',
            'positive': None,
            'drills': DRILLS['hip_separation'],
        }
    else:
        results['hip_separation'] = {
            'label': f'{sep:.0f}° — Simultaneous rotation', 'color': 'red', 'status': 'fault',
            'text': 'Hips and shoulders rotating together — biggest velocity leak in pitching. Cue: "lead with hip, wait with shoulder."',
            'positive': None,
            'drills': DRILLS['hip_separation'],
        }

    # ── Pulling / shoulder openness at stride plant ───────────────────────────
    openness = metrics['shoulder_openness']
    if openness < 8:
        results['pulling'] = {
            'label': 'Staying closed', 'color': 'green', 'status': 'good',
            'text': 'Shoulders staying closed through stride plant — maximum power transfer at release.',
            'positive': 'Good sequence: hips opening first while shoulders stay back. This is what creates elite late life on pitches.',
            'drills': [],
        }
    elif openness < 18:
        results['pulling'] = {
            'label': 'Slight early opening', 'color': 'yellow', 'status': 'warning',
            'text': 'Shoulders beginning to open slightly before stride foot plants. Minor timing issue — slow down the upper body.',
            'positive': None,
            'drills': DRILLS['pulling'],
        }
    else:
        results['pulling'] = {
            'label': 'Pulling — early rotation', 'color': 'red', 'status': 'fault',
            'text': 'Shoulders opening well before stride plant. This is the #1 cause of arm-side misses and velocity loss. "Stay closed — let the hips pull the shoulder through."',
            'positive': None,
            'drills': DRILLS['pulling'],
        }

    # ── Trunk direction (going at target) ────────────────────────────────────
    td = metrics['trunk_direction']
    if abs(td) < 5:
        results['trunk_direction'] = {
            'label': 'Driving at target', 'color': 'green', 'status': 'good',
            'text': 'Trunk aligned and driving toward home plate at release.',
            'positive': 'Body momentum going directly at target. Maximum command and velocity transfer.',
            'drills': [],
        }
    elif abs(td) < 12:
        results['trunk_direction'] = {
            'label': 'Slight drift', 'color': 'yellow', 'status': 'warning',
            'text': 'Minor trunk drift at release. Focus on "chest to catcher" — finish with your chest facing home plate.',
            'positive': None,
            'drills': DRILLS['trunk_direction'],
        }
    else:
        results['trunk_direction'] = {
            'label': 'Falling off / flying open', 'color': 'red', 'status': 'fault',
            'text': 'Trunk significantly offline at release — not going at the target. Causes wild command misses across the plate. "Drive your chest at the catcher."',
            'positive': None,
            'drills': DRILLS['trunk_direction'],
        }

    # ── Stride ────────────────────────────────────────────────────────────────
    dev = metrics['stride_dev_pct']
    if abs(dev) < 4:
        results['stride'] = {
            'label': 'Stride on line', 'color': 'green', 'status': 'good',
            'text': 'Stride directly toward the plate — maximum lower-half power.',
            'positive': 'Stride direction is ideal. Lower half energy transferring directly to the pitch.',
            'drills': [],
        }
    elif abs(dev) < 12:
        results['stride'] = {
            'label': 'Slight offset', 'color': 'yellow', 'status': 'warning',
            'text': 'Minor stride deviation. Drill knee drive toward the target.',
            'positive': None,
            'drills': DRILLS['stride'],
        }
    elif dev > 12:
        results['stride'] = {
            'label': 'Opening early', 'color': 'red', 'status': 'fault',
            'text': 'Stride foot landing open. Early hip rotation = velocity loss and arm-side misses.',
            'positive': None,
            'drills': DRILLS['stride'],
        }
    else:
        results['stride'] = {
            'label': 'Crossing over', 'color': 'red', 'status': 'fault',
            'text': 'Stride foot crossing the centerline — restricts hip rotation.',
            'positive': None,
            'drills': DRILLS['stride'],
        }

    # ── Trunk lean ────────────────────────────────────────────────────────────
    trunk = metrics['trunk_angle']
    if trunk < 70:
        results['trunk_lean'] = {
            'label': f'Good forward drive ({round(90 - trunk)}°)', 'color': 'green', 'status': 'good',
            'text': f'Trunk leaning {round(90 - trunk)}° forward at release — good momentum toward plate.',
            'positive': 'Forward trunk lean creates downhill plane and drives velocity.',
            'drills': [],
        }
    elif trunk > 100:
        results['trunk_lean'] = {
            'label': 'Leaning back', 'color': 'red', 'status': 'fault',
            'text': f'Trunk leaning back {round(trunk - 90)}° — losing momentum. Drive chest through at release.',
            'positive': None,
            'drills': DRILLS['trunk_direction'],
        }
    else:
        results['trunk_lean'] = {
            'label': 'Upright at release', 'color': 'yellow', 'status': 'warning',
            'text': 'Trunk too upright — could drive more forward momentum into the pitch.',
            'positive': None,
            'drills': DRILLS['trunk_direction'],
        }

    return results


# ── Training plan generator ───────────────────────────────────────────────────

def generate_training_plan(metrics: dict, interpretation: dict, throwing_side: str) -> dict:
    """
    Build a personalized training plan based on detected faults.
    Returns: priority_fixes (ordered), positives, week_plan, mental_cues.
    """

    faults = []
    positives = []
    all_drills = []

    for key, val in interpretation.items():
        if val.get('status') == 'fault':
            faults.append({'area': key, 'label': val['label'], 'text': val['text'], 'drills': val.get('drills', [])})
            all_drills.extend(val.get('drills', []))
        elif val.get('status') == 'warning':
            faults.append({'area': key, 'label': val['label'], 'text': val['text'], 'drills': val.get('drills', []), 'warning': True})
        if val.get('positive'):
            positives.append({'area': key, 'label': val['label'], 'text': val['positive']})

    # Priority order based on severity (faults before warnings)
    priority_fixes = [f for f in faults if not f.get('warning')] + [f for f in faults if f.get('warning')]

    # Generate a 4-week plan focused on top 2 fault areas
    top_faults = priority_fixes[:2]
    week_plan = []

    if top_faults:
        focus_areas = [f['area'] for f in top_faults]

        # Week 1: Awareness and isolation
        w1_drills = []
        for f in top_faults[:2]:
            if f.get('drills'):
                w1_drills.append(f['drills'][0])
        week_plan.append({
            'week': 1,
            'theme': 'Awareness & Isolation',
            'focus': 'Slow-motion and mirror work. Build body awareness of the fault before trying to fix it at full speed.',
            'drills': w1_drills,
            'volume': 'Flat ground only, 30–40 throws per session, 3 sessions',
        })

        # Week 2: Drill reinforcement
        w2_drills = []
        for f in top_faults:
            if f.get('drills') and len(f['drills']) > 1:
                w2_drills.append(f['drills'][1])
            elif f.get('drills'):
                w2_drills.append(f['drills'][0])
        week_plan.append({
            'week': 2,
            'theme': 'Drill Reinforcement',
            'focus': 'Introduce the key drills with intent. Each throw has one specific focus cue. Quality over quantity.',
            'drills': w2_drills,
            'volume': 'Flat ground + light bullpen (20 pitches), 3–4 sessions',
        })

        # Week 3: Transfer to bullpen
        week_plan.append({
            'week': 3,
            'theme': 'Transfer to Bullpen',
            'focus': 'Apply drill cues in full bullpen sessions. 1 mental cue per session — don\'t try to fix everything at once. Film from the side.',
            'drills': w2_drills[:1] if w2_drills else [],
            'volume': '2–3 bullpen sessions (30–40 pitches each), 1 flat-ground drill session',
        })

        # Week 4: Compete and evaluate
        week_plan.append({
            'week': 4,
            'theme': 'Compete & Re-evaluate',
            'focus': 'Live at-bats or simulated game. Don\'t think mechanics — let the drills work. Film and compare to Week 1.',
            'drills': [],
            'volume': 'Game situations, then re-run mechanics analysis to track improvement',
        })

    # Mental cues — one simple phrase per fault
    cue_map = {
        'hip_separation':  '"Hips first, then shoulder"',
        'pulling':         '"Stay closed — stay closed — now explode"',
        'trunk_direction': '"Drive my chest to the catcher"',
        'release_height':  '"Get tall — be tall at the top"',
        'stride':          '"Drive my knee at the target"',
        'elbow':           '"Keep my elbow up through the roof"',
        'trunk_lean':      '"Lean and drive — don\'t stand up"',
    }

    mental_cues = []
    for f in priority_fixes[:3]:
        cue = cue_map.get(f['area'])
        if cue:
            mental_cues.append({'area': f['area'], 'cue': cue})

    return {
        'priority_fixes': priority_fixes,
        'positives': positives,
        'week_plan': week_plan,
        'mental_cues': mental_cues,
        'fault_count': len([f for f in faults if not f.get('warning')]),
        'warning_count': len([f for f in faults if f.get('warning')]),
    }


# ── Frame annotation ──────────────────────────────────────────────────────────

def annotate_frame(frame: np.ndarray, lms: list, throwing_side: str, label: str = 'RELEASE') -> np.ndarray:
    h, w = frame.shape[:2]
    out = frame.copy()

    def px(lm):
        return (int(lm[0] * w), int(lm[1] * h))

    CONNECTIONS = [
        (L_SHOULDER, R_SHOULDER),
        (L_SHOULDER, L_ELBOW), (L_ELBOW, L_WRIST),
        (R_SHOULDER, R_ELBOW), (R_ELBOW, R_WRIST),
        (L_SHOULDER, L_HIP),   (R_SHOULDER, R_HIP),
        (L_HIP, R_HIP),
        (L_HIP, L_KNEE),   (L_KNEE, L_ANKLE),
        (R_HIP, R_KNEE),   (R_KNEE, R_ANKLE),
    ]

    s = throwing_side
    THROW_SEQ = (R_SHOULDER, R_ELBOW, R_WRIST) if s == 'R' else (L_SHOULDER, L_ELBOW, L_WRIST)
    THROW_SET  = set(THROW_SEQ)

    for a, b in CONNECTIONS:
        if lms[a][3] > 0.40 and lms[b][3] > 0.40:
            cv2.line(out, px(lms[a]), px(lms[b]), (50, 190, 50), 2, cv2.LINE_AA)

    for k in range(len(THROW_SEQ) - 1):
        a, b = THROW_SEQ[k], THROW_SEQ[k + 1]
        if lms[a][3] > 0.40 and lms[b][3] > 0.40:
            cv2.line(out, px(lms[a]), px(lms[b]), (30, 140, 255), 3, cv2.LINE_AA)

    sh_i = R_SHOULDER if s == 'R' else L_SHOULDER
    wr_i = R_WRIST    if s == 'R' else L_WRIST
    if lms[sh_i][3] > 0.40 and lms[wr_i][3] > 0.40:
        cv2.line(out, px(lms[sh_i]), px(lms[wr_i]), (0, 220, 220), 3, cv2.LINE_AA)

    ALL_JOINTS = [L_SHOULDER, R_SHOULDER, L_ELBOW, R_ELBOW,
                  L_WRIST, R_WRIST, L_HIP, R_HIP, L_KNEE, R_KNEE, L_ANKLE, R_ANKLE]
    for j in ALL_JOINTS:
        if lms[j][3] > 0.40:
            col = (30, 140, 255) if j in THROW_SET else (50, 190, 50)
            cv2.circle(out, px(lms[j]), 6, col, -1, cv2.LINE_AA)
            cv2.circle(out, px(lms[j]), 6, (255, 255, 255), 1, cv2.LINE_AA)

    # Draw hip line (magenta) to visualize separation
    l_hip_px = px(lms[L_HIP])
    r_hip_px = px(lms[R_HIP])
    if lms[L_HIP][3] > 0.40 and lms[R_HIP][3] > 0.40:
        cv2.line(out, l_hip_px, r_hip_px, (200, 60, 200), 2, cv2.LINE_AA)

    cv2.rectangle(out, (0, 0), (w, 36), (0, 0, 0), -1)
    cv2.putText(out, f'{label}', (8, 24),
                cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 220, 220), 2, cv2.LINE_AA)

    return out


# ── Behind-pitcher metrics ────────────────────────────────────────────────────

DRILLS_BEHIND = {
    'short_arm': [
        {
            'name': 'Full-Circle Long Toss',
            'how': 'Start at 60 feet. Focus on letting the arm swing down past the hip and up into a full backswing before accelerating forward. Exaggerate the arc — get the wrist behind your ear.',
            'reps': '20 throws per flat-ground session, 3x/week',
        },
        {
            'name': 'Wrist Weight Pendulum',
            'how': 'Hold a 1–2lb wrist weight. Relax arm completely and let it swing like a pendulum from shoulder — full down-and-back arc. Builds feel for a complete arm circle.',
            'reps': '2 sets × 30 sec daily as warm-up',
        },
    ],
    'follow_through': [
        {
            'name': 'Finish Drill',
            'how': 'After every throw, freeze your follow-through and hold for 3 seconds. Check: throwing arm should be finishing past your opposite (glove-side) hip or knee. If it stops early, you cut off deceleration.',
            'reps': '15 reps every flat-ground session',
        },
        {
            'name': 'Deceleration Band Work',
            'how': 'Attach a light band to your wrist. Simulate throwing motion and let the band pull your arm through the follow-through. Builds the posterior shoulder muscles that protect from injury.',
            'reps': '3 sets × 12 reps, daily arm care routine',
        },
    ],
    'hip_rotation': [
        {
            'name': 'Hip Pop Drill',
            'how': 'From set position with hands together, fire hips toward the plate as explosively as possible — then stop. Don\'t let shoulders follow. Isolates the hip pop that should happen before shoulder rotation.',
            'reps': '3 sets × 8 reps daily',
        },
        {
            'name': 'Chair Hip Rotation',
            'how': 'Sit on the edge of a chair, feet flat. Practice rotating hips left and right explosively with a resistance band around the waist. Builds hip rotational power independently of the arm.',
            'reps': '3 sets × 15 each direction, 3x/week',
        },
    ],
    'stride_behind': [
        {
            'name': 'Tape Line Stride Drill',
            'how': 'Put tape from the rubber straight to home plate. Your stride foot should land ON or just inside this line. From behind the pitcher, you\'ll clearly see if the foot opens left or crosses right.',
            'reps': 'Every bullpen session',
        },
    ],
    'head_stability': [
        {
            'name': 'Wall Target Focus',
            'how': 'Place a small sticker at eye-level on the wall (at "catcher" distance). Go through your delivery keeping your eyes locked on that sticker throughout. Head movement = loss of command.',
            'reps': 'Towel drill + live bullpen, 1 mental cue per session',
        },
    ],
}


def compute_behind_metrics(all_lms: list, throwing_side: str, release_idx: int) -> dict:
    """
    Metrics specific to the behind-pitcher camera angle.

    From behind, the pitcher starts facing the camera and rotates away.
    Key observables: arm circle completeness, hip rotation, follow-through
    crossing, stride direction, head stability.
    """
    valid_frames = [(i, lm) for i, lm in enumerate(all_lms) if lm is not None]
    if len(valid_frames) < 5:
        return {}

    wr_idx = R_WRIST  if throwing_side == 'R' else L_WRIST
    sh_idx = R_SHOULDER if throwing_side == 'R' else L_SHOULDER
    opp_hip = L_HIP  if throwing_side == 'R' else R_HIP

    # ── 1. Arm backswing height ───────────────────────────────────────────────
    # Track throwing wrist Y in frames before release (first 70% of delivery).
    # Lower Y value = higher on screen (MediaPipe Y is 0=top).
    # From behind, the wrist should drop well BELOW the hip during backswing,
    # then come all the way up behind the head before coming forward.
    # We measure: min wrist Y (highest wrist position in backswing) relative to shoulder.
    pre_release = [(i, lm) for i, lm in valid_frames if i <= release_idx]
    if len(pre_release) >= 3:
        wrist_ys  = [lm[wr_idx][1] for _, lm in pre_release if lm[wr_idx][3] > 0.3]
        sh_ys     = [lm[sh_idx][1] for _, lm in pre_release if lm[sh_idx][3] > 0.3]
        if wrist_ys and sh_ys:
            min_wrist_y = min(wrist_ys)  # highest wrist position (smallest y = highest)
            avg_sh_y    = sum(sh_ys) / len(sh_ys)
            # backswing_height > 0 means wrist reached above shoulder level
            backswing_height = round((avg_sh_y - min_wrist_y) * 100, 1)
        else:
            backswing_height = 0.0
    else:
        backswing_height = 0.0

    # ── 2. Follow-through crossing ────────────────────────────────────────────
    # After release, does the throwing wrist cross past the body midline?
    # Midline = X midpoint between L and R hips.
    # For RHP (throwing right-to-left from behind), wrist should end up on
    # the LEFT side of midline (past the body) for healthy deceleration.
    post_release = [(i, lm) for i, lm in valid_frames if i > release_idx]
    follow_through_crosses = False
    follow_through_dist = 0.0
    if post_release and len(post_release) >= 2:
        rel_lm = all_lms[release_idx] if all_lms[release_idx] is not None else valid_frames[-1][1]
        midline_x = (rel_lm[L_HIP][0] + rel_lm[R_HIP][0]) / 2
        # Take the last few post-release frames
        post_wrist_xs = [lm[wr_idx][0] for _, lm in post_release[-3:] if lm[wr_idx][3] > 0.3]
        if post_wrist_xs:
            final_wrist_x = sum(post_wrist_xs) / len(post_wrist_xs)
            # For RHP: throwing arm is on the right side; after release it should cross LEFT past midline
            # For LHP: throwing arm is on the left; should cross RIGHT past midline
            if throwing_side == 'R':
                follow_through_dist = round((midline_x - final_wrist_x) * 100, 1)
            else:
                follow_through_dist = round((final_wrist_x - midline_x) * 100, 1)
            follow_through_crosses = follow_through_dist > 3.0

    # ── 3. Hip rotation total ─────────────────────────────────────────────────
    # Compare hip line angle at the START of the clip vs at release.
    # From behind: pitcher starts facing camera, so hip line should be near-horizontal.
    # At release, hips should have rotated ~60–90° toward home plate.
    early_frames = [(i, lm) for i, lm in valid_frames if i <= max(2, len(valid_frames) // 5)]
    if early_frames and release_idx < len(all_lms) and all_lms[release_idx] is not None:
        early_lm = early_frames[0][1]
        rel_lm   = all_lms[release_idx]
        def hip_angle(lm):
            dx = lm[R_HIP][0] - lm[L_HIP][0]
            dy = lm[R_HIP][1] - lm[L_HIP][1]
            return math.degrees(math.atan2(-dy, dx + 1e-9))
        start_ang = hip_angle(early_lm)
        rel_ang   = hip_angle(rel_lm)
        hip_rotation_total = round(abs(rel_ang - start_ang), 1)
    else:
        hip_rotation_total = 0.0

    # ── 4. Stride foot deviation (from behind) ────────────────────────────────
    # More directly measurable from behind than from the side.
    # At release, stride foot X vs hip midline X.
    if release_idx < len(all_lms) and all_lms[release_idx] is not None:
        rel_lm    = all_lms[release_idx]
        str_ankle = L_ANKLE if throwing_side == 'R' else R_ANKLE
        hip_mid_x = (rel_lm[L_HIP][0] + rel_lm[R_HIP][0]) / 2
        stride_dev_behind = round((rel_lm[str_ankle][0] - hip_mid_x) * 100, 1)
    else:
        stride_dev_behind = 0.0

    # ── 5. Head stability ─────────────────────────────────────────────────────
    # Track nose (landmark 0) X position across all frames.
    # High standard deviation = head drifting = inconsistent release point.
    NOSE = 0
    nose_xs = [lm[NOSE][0] for _, lm in valid_frames if lm[NOSE][3] > 0.3]
    if len(nose_xs) > 3:
        mean_x = sum(nose_xs) / len(nose_xs)
        variance = sum((x - mean_x) ** 2 for x in nose_xs) / len(nose_xs)
        head_stability = round(math.sqrt(variance) * 100, 2)  # % of frame width
    else:
        head_stability = 0.0

    return {
        'backswing_height':      backswing_height,
        'follow_through_dist':   follow_through_dist,
        'follow_through_crosses': follow_through_crosses,
        'hip_rotation_total':    hip_rotation_total,
        'stride_dev_behind':     stride_dev_behind,
        'head_stability':        head_stability,
    }


def interpret_behind(metrics: dict) -> dict:
    """Coaching interpretations for behind-pitcher view metrics."""
    results = {}

    # ── Arm backswing (short-arming detection) ────────────────────────────────
    bh = metrics.get('backswing_height', 0)
    if bh > 15:
        results['arm_circle'] = {
            'label': 'Full arm circle', 'status': 'good',
            'text': 'Arm taking a full backswing arc — generating maximum whip and velocity.',
            'positive': 'Complete arm circle creates natural whip. All pitch types will have better late movement.',
            'drills': [],
        }
    elif bh > 5:
        results['arm_circle'] = {
            'label': 'Moderate backswing', 'status': 'warning',
            'text': 'Arm circle is shorter than ideal. Let the arm swing fully down past the hip before coming up — don\'t rush it.',
            'positive': None,
            'drills': DRILLS_BEHIND['short_arm'],
        }
    else:
        results['arm_circle'] = {
            'label': 'Short-arming', 'status': 'fault',
            'text': 'Arm is short-arming — not completing the full backswing arc. This caps velocity and increases elbow stress. The arm needs to swing down and fully back before accelerating forward.',
            'positive': None,
            'drills': DRILLS_BEHIND['short_arm'],
        }

    # ── Follow-through crossing ───────────────────────────────────────────────
    ft = metrics.get('follow_through_dist', 0)
    crosses = metrics.get('follow_through_crosses', False)
    if crosses and ft > 8:
        results['follow_through'] = {
            'label': 'Full follow-through', 'status': 'good',
            'text': 'Arm finishing past the body — healthy posterior shoulder deceleration.',
            'positive': 'Arm properly decelerates across the body. This protects the shoulder and elbow long-term.',
            'drills': [],
        }
    elif crosses:
        results['follow_through'] = {
            'label': 'Adequate follow-through', 'status': 'good',
            'text': 'Arm crossing the body centerline after release. Healthy deceleration pattern.',
            'positive': 'Follow-through is completing properly. Good arm care habits.',
            'drills': [],
        }
    else:
        results['follow_through'] = {
            'label': 'Follow-through cut short', 'status': 'fault',
            'text': 'Arm stopping before crossing past the body. This "blocking" forces the shoulder and UCL to absorb the deceleration force — major injury risk over time. Let the arm finish all the way across.',
            'positive': None,
            'drills': DRILLS_BEHIND['follow_through'],
        }

    # ── Hip rotation ──────────────────────────────────────────────────────────
    hr = metrics.get('hip_rotation_total', 0)
    if hr > 55:
        results['hip_rotation'] = {
            'label': f'{hr:.0f}° hip rotation — Explosive', 'status': 'good',
            'text': f'Hips rotating {hr:.0f}° from set to release — excellent hip-driven power.',
            'positive': f'{hr:.0f}° of hip rotation is a real velocity driver. Lower half is doing its job.',
            'drills': [],
        }
    elif hr > 35:
        results['hip_rotation'] = {
            'label': f'{hr:.0f}° hip rotation — Moderate', 'status': 'warning',
            'text': f'Hips rotating {hr:.0f}°. There\'s more left — drive hips more aggressively before shoulder rotation. Target 60°+.',
            'positive': None,
            'drills': DRILLS_BEHIND['hip_rotation'],
        }
    else:
        results['hip_rotation'] = {
            'label': f'{hr:.0f}° hip rotation — Insufficient', 'status': 'fault',
            'text': f'Only {hr:.0f}° of hip rotation detected — hips are not firing properly. This is a major velocity and command issue. Hips must lead the entire delivery.',
            'positive': None,
            'drills': DRILLS_BEHIND['hip_rotation'],
        }

    # ── Stride (from behind) ──────────────────────────────────────────────────
    sd = metrics.get('stride_dev_behind', 0)
    if abs(sd) < 5:
        results['stride_direction'] = {
            'label': 'Stride straight to plate', 'status': 'good',
            'text': 'Stride foot landing directly toward home plate — maximum power transfer.',
            'positive': 'Stride alignment is on target. Lower half driving directly at the catcher.',
            'drills': [],
        }
    elif abs(sd) < 14:
        results['stride_direction'] = {
            'label': 'Minor stride drift', 'status': 'warning',
            'text': 'Slight stride deviation visible from behind. Drill the knee driving straight at the target.',
            'positive': None,
            'drills': DRILLS_BEHIND['stride_behind'],
        }
    elif sd > 14:
        results['stride_direction'] = {
            'label': 'Stride opening — visible from behind', 'status': 'fault',
            'text': 'Stride foot clearly opening away from the target line. This is the pulling/early rotation fault visible from behind — stride foot lands open, hips follow early.',
            'positive': None,
            'drills': DRILLS_BEHIND['stride_behind'] + DRILLS['pulling'],
        }
    else:
        results['stride_direction'] = {
            'label': 'Stride crossing over', 'status': 'fault',
            'text': 'Stride foot crossing past the centerline from behind view. Restricts hip rotation and reduces power.',
            'positive': None,
            'drills': DRILLS_BEHIND['stride_behind'],
        }

    # ── Head stability ────────────────────────────────────────────────────────
    hs = metrics.get('head_stability', 0)
    if hs < 2.0:
        results['head_stability'] = {
            'label': 'Stable head position', 'status': 'good',
            'text': 'Head staying quiet through the delivery — consistent visual anchor for release point.',
            'positive': 'Stable head = consistent release point. Command will be repeatable.',
            'drills': [],
        }
    elif hs < 4.5:
        results['head_stability'] = {
            'label': 'Minor head movement', 'status': 'warning',
            'text': 'Some head drift during the delivery. Keep eyes locked on the catcher\'s mitt from start to follow-through.',
            'positive': None,
            'drills': DRILLS_BEHIND['head_stability'],
        }
    else:
        results['head_stability'] = {
            'label': 'Head drifting', 'status': 'fault',
            'text': 'Significant head movement detected. Head drift is a primary cause of release point inconsistency and location misses. Lock your eyes on the target and keep the head still.',
            'positive': None,
            'drills': DRILLS_BEHIND['head_stability'],
        }

    return results


def generate_training_plan_behind(metrics: dict, interpretation: dict, throwing_side: str) -> dict:
    """Training plan generator for behind-pitcher view."""
    faults = []
    positives = []

    for key, val in interpretation.items():
        if val.get('status') == 'fault':
            faults.append({'area': key, 'label': val['label'], 'text': val['text'], 'drills': val.get('drills', [])})
        elif val.get('status') == 'warning':
            faults.append({'area': key, 'label': val['label'], 'text': val['text'], 'drills': val.get('drills', []), 'warning': True})
        if val.get('positive'):
            positives.append({'area': key, 'label': val['label'], 'text': val['positive']})

    priority_fixes = [f for f in faults if not f.get('warning')] + [f for f in faults if f.get('warning')]

    top = priority_fixes[:2]
    week_plan = []
    if top:
        w1_drills = [f['drills'][0] for f in top if f.get('drills')]
        week_plan.append({
            'week': 1, 'theme': 'Awareness',
            'focus': 'Slow-motion and mirror work. Film yourself from behind and compare to this analysis.',
            'drills': w1_drills[:2],
            'volume': 'Flat ground only, 30–40 throws, 3 sessions',
        })
        w2_drills = [f['drills'][1] if len(f.get('drills', [])) > 1 else f['drills'][0] for f in top if f.get('drills')]
        week_plan.append({
            'week': 2, 'theme': 'Drill Focus',
            'focus': 'One drill per session, one cue per bullpen. Don\'t try to fix everything at once.',
            'drills': w2_drills[:2],
            'volume': 'Flat ground + 20-pitch bullpen, 3–4 sessions',
        })
        week_plan.append({
            'week': 3, 'theme': 'Transfer',
            'focus': 'Apply to full bullpen sessions. Film from behind again and compare to Week 1.',
            'drills': w1_drills[:1],
            'volume': '2–3 bullpens (30–40 pitches each)',
        })
        week_plan.append({
            'week': 4, 'theme': 'Compete',
            'focus': 'Live at-bats or game situations. Trust the work. Re-analyze from behind.',
            'drills': [],
            'volume': 'Game situations + re-analysis',
        })

    cue_map = {
        'arm_circle':       '"Let it go down and all the way back"',
        'follow_through':   '"Finish past my hip — let it go"',
        'hip_rotation':     '"Pop the hips — hold the shoulder"',
        'stride_direction': '"Drive my knee straight at the catcher"',
        'head_stability':   '"Eyes locked on the mitt — don\'t move my head"',
    }
    mental_cues = [
        {'area': f['area'], 'cue': cue_map[f['area']]}
        for f in priority_fixes[:3] if f['area'] in cue_map
    ]

    return {
        'priority_fixes':  priority_fixes,
        'positives':       positives,
        'week_plan':       week_plan,
        'mental_cues':     mental_cues,
        'fault_count':     len([f for f in faults if not f.get('warning')]),
        'warning_count':   len([f for f in faults if f.get('warning')]),
    }


def annotate_frame_behind(frame: np.ndarray, lms: list, throwing_side: str,
                           label: str = 'RELEASE', metrics: dict = None) -> np.ndarray:
    """Annotate a frame from the behind-pitcher angle with arm path and hip rotation lines."""
    h, w = frame.shape[:2]
    out = frame.copy()

    def px(lm):
        return (int(lm[0] * w), int(lm[1] * h))

    CONNECTIONS = [
        (L_SHOULDER, R_SHOULDER),
        (L_SHOULDER, L_ELBOW), (L_ELBOW, L_WRIST),
        (R_SHOULDER, R_ELBOW), (R_ELBOW, R_WRIST),
        (L_SHOULDER, L_HIP),   (R_SHOULDER, R_HIP),
        (L_HIP, R_HIP),
        (L_HIP, L_KNEE),   (L_KNEE, L_ANKLE),
        (R_HIP, R_KNEE),   (R_KNEE, R_ANKLE),
    ]

    s = throwing_side
    THROW_SEQ = (R_SHOULDER, R_ELBOW, R_WRIST) if s == 'R' else (L_SHOULDER, L_ELBOW, L_WRIST)
    THROW_SET  = set(THROW_SEQ)

    for a, b in CONNECTIONS:
        if lms[a][3] > 0.40 and lms[b][3] > 0.40:
            cv2.line(out, px(lms[a]), px(lms[b]), (50, 190, 50), 2, cv2.LINE_AA)

    for k in range(len(THROW_SEQ) - 1):
        a, b = THROW_SEQ[k], THROW_SEQ[k + 1]
        if lms[a][3] > 0.40 and lms[b][3] > 0.40:
            cv2.line(out, px(lms[a]), px(lms[b]), (30, 140, 255), 3, cv2.LINE_AA)

    # Hip line (magenta)
    if lms[L_HIP][3] > 0.40 and lms[R_HIP][3] > 0.40:
        cv2.line(out, px(lms[L_HIP]), px(lms[R_HIP]), (200, 60, 200), 2, cv2.LINE_AA)

    # Body centerline (dashed vertical)
    mid_x = int((lms[L_HIP][0] + lms[R_HIP][0]) / 2 * w)
    sh_y  = int((lms[L_SHOULDER][1] + lms[R_SHOULDER][1]) / 2 * h)
    hip_y = int((lms[L_HIP][1] + lms[R_HIP][1]) / 2 * h)
    for yy in range(0, h, 12):
        cv2.line(out, (mid_x, yy), (mid_x, min(yy + 7, h)), (255, 255, 0), 1, cv2.LINE_AA)

    ALL_JOINTS = [L_SHOULDER, R_SHOULDER, L_ELBOW, R_ELBOW,
                  L_WRIST, R_WRIST, L_HIP, R_HIP, L_KNEE, R_KNEE, L_ANKLE, R_ANKLE]
    for j in ALL_JOINTS:
        if lms[j][3] > 0.40:
            col = (30, 140, 255) if j in THROW_SET else (50, 190, 50)
            cv2.circle(out, px(lms[j]), 6, col, -1, cv2.LINE_AA)
            cv2.circle(out, px(lms[j]), 6, (255, 255, 255), 1, cv2.LINE_AA)

    cv2.rectangle(out, (0, 0), (w, 36), (0, 0, 0), -1)
    cv2.putText(out, f'BEHIND VIEW — {label}', (8, 24),
                cv2.FONT_HERSHEY_SIMPLEX, 0.60, (0, 220, 220), 2, cv2.LINE_AA)

    return out


# ── Shared video loading helper ───────────────────────────────────────────────

def _load_video_frames(video_path: str):
    """
    Open video, sample ≤80 frames, run MediaPipe Pose on each.
    Returns (all_lms, raw_frames, fps) or raises ValueError on failure.
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError('Cannot open video file.')

    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps   = cap.get(cv2.CAP_PROP_FPS) or 30.0

    if total < 10:
        cap.release()
        raise ValueError('Video too short — need at least 10 frames.')

    sample_every = max(1, total // 80)
    all_lms:    list = []
    raw_frames: list = []

    with _mp_pose.Pose(
        static_image_mode=False,
        model_complexity=1,
        smooth_landmarks=True,
        min_detection_confidence=0.35,
        min_tracking_confidence=0.35,
    ) as pose:
        frame_num = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            if frame_num % sample_every == 0:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                result = pose.process(rgb)
                if result.pose_landmarks:
                    all_lms.append([
                        (lm.x, lm.y, lm.z, lm.visibility)
                        for lm in result.pose_landmarks.landmark
                    ])
                else:
                    all_lms.append(None)
                h_f, w_f = frame.shape[:2]
                if w_f > 960:
                    scale = 960 / w_f
                    frame = cv2.resize(frame, (int(w_f * scale), int(h_f * scale)))
                raw_frames.append((frame_num, frame.copy()))
            frame_num += 1

    cap.release()
    return all_lms, raw_frames, fps


# ── Main entry point ──────────────────────────────────────────────────────────

def analyze_pitching_video(video_path: str, camera_angle: str = 'side') -> dict:
    """
    Full automatic pipeline. camera_angle: 'side' or 'behind'.

    Side view:  arm slot, release height, hip-shoulder separation,
                pulling detection, trunk direction, stride, elbow.
    Behind view: arm circle, follow-through, hip rotation,
                 stride direction, head stability.
    """
    if not MEDIAPIPE_AVAILABLE:
        return {
            'available': False,
            'error': 'MediaPipe not installed. Run: pip3 install mediapipe --break-system-packages'
        }

    try:
        all_lms, raw_frames, fps = _load_video_frames(video_path)
    except ValueError as e:
        return {'available': True, 'error': str(e)}

    valid = [lm for lm in all_lms if lm is not None]
    if len(valid) < 5:
        angle_hint = (
            'Pitcher visible full-body from head to ankle, filmed from the side.'
            if camera_angle == 'side' else
            'Pitcher visible from behind the mound, full-body from head to ankle.'
        )
        return {
            'available': True,
            'error': f'Pitcher not detected. {angle_hint} Avoid dark lighting or tight crops.'
        }

    def nearest_valid(target: int):
        for offset in range(0, 8):
            for sign in (0, 1, -1):
                i = target + sign * offset
                if 0 <= i < len(all_lms) and all_lms[i] is not None:
                    frame_img = raw_frames[i][1] if i < len(raw_frames) else raw_frames[0][1]
                    return i, all_lms[i], frame_img
        return 0, valid[0], raw_frames[0][1]

    def b64(img):
        _, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 83])
        return base64.b64encode(buf.tobytes()).decode()

    throwing_side = detect_throwing_side(all_lms)
    release_idx   = find_release_idx(all_lms, throwing_side)

    # ── Branch: behind-pitcher angle ──────────────────────────────────────────
    if camera_angle == 'behind':
        # Key frames for behind view
        rel_i, release_lms, release_frame = nearest_valid(release_idx)
        # Use a mid-delivery frame (~40% through) as the "wind-up" reference
        mid_idx = max(0, release_idx // 2)
        mid_i, mid_lms, mid_frame = nearest_valid(mid_idx)

        raw    = compute_behind_metrics(all_lms, throwing_side, release_idx)
        interp = interpret_behind(raw)
        plan   = generate_training_plan_behind(raw, interp, throwing_side)

        ann_release = annotate_frame_behind(release_frame, release_lms, throwing_side, 'RELEASE', raw)
        ann_wind    = annotate_frame_behind(mid_frame,     mid_lms,     throwing_side, 'WIND-UP',  raw)

        return {
            'available':             True,
            'camera_angle':          'behind',
            'throwing_side':         throwing_side,
            'metrics':               raw,
            'interpretation':        interp,
            'training_plan':         plan,
            'release_frame_b64':     b64(ann_release),
            'stride_frame_b64':      b64(ann_wind),
            'total_frames_analyzed': len(all_lms),
            'fps':                   round(fps, 1),
            'release_time_sec':      round(raw_frames[rel_i][0] / fps, 2) if rel_i < len(raw_frames) else 0,
            'stride_time_sec':       round(raw_frames[mid_i][0] / fps, 2) if mid_i < len(raw_frames) else 0,
        }

    # ── Branch: side-view angle (default) ────────────────────────────────────
    stride_idx = find_stride_idx(all_lms, release_idx, throwing_side)
    rel_i, release_lms, release_frame = nearest_valid(release_idx)
    str_i, stride_lms,  stride_frame  = nearest_valid(stride_idx)

    raw    = compute_metrics(release_lms, stride_lms, throwing_side)
    interp = interpret(raw)
    plan   = generate_training_plan(raw, interp, throwing_side)

    ann_release = annotate_frame(release_frame, release_lms, throwing_side, label='RELEASE POINT')
    ann_stride  = annotate_frame(stride_frame,  stride_lms,  throwing_side, label='STRIDE PLANT')

    return {
        'available':              True,
        'camera_angle':           'side',
        'throwing_side':          throwing_side,
        'metrics':                raw,
        'interpretation':         interp,
        'training_plan':          plan,
        'release_frame_b64':      b64(ann_release),
        'stride_frame_b64':       b64(ann_stride),
        'total_frames_analyzed':  len(all_lms),
        'fps':                    round(fps, 1),
        'release_time_sec':       round(raw_frames[rel_i][0] / fps, 2) if rel_i < len(raw_frames) else 0,
        'stride_time_sec':        round(raw_frames[str_i][0] / fps, 2) if str_i < len(raw_frames) else 0,
    }
