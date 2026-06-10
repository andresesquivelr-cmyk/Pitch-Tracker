from fastapi import FastAPI, File, UploadFile, HTTPException, WebSocket, WebSocketDisconnect, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional, List
import cv2
import numpy as np
import base64
import uuid
import math
import asyncio
import json
import os
from io import BytesIO
from PIL import Image
from supabase import create_client
from camera import (
    BallTracker, encode_frame, draw_overlay,
    list_cameras, grab_still,
    set_calibration, get_calibration, clear_calibration, pixel_to_norm
)
from database import (
    init_db, create_outing, get_outing, list_outings, save_pitch,
    get_pitches_for_outing, delete_outing,
    get_trends, delete_pitch, update_pitch,
)

app = FastAPI(title="Pitch Tracker API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Supabase Auth ─────────────────────────────────────────────────────────────
_SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
_SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
_supabase_admin = None

def _get_supabase_admin():
    global _supabase_admin
    if _supabase_admin is None and _SUPABASE_URL and _SUPABASE_SERVICE_KEY:
        _supabase_admin = create_client(_SUPABASE_URL, _SUPABASE_SERVICE_KEY)
    return _supabase_admin


async def get_current_user(authorization: Optional[str] = Header(None)):
    """FastAPI dependency — verifies the Supabase JWT and returns the user object."""
    sb = _get_supabase_admin()
    if sb is None:
        raise HTTPException(503, "Auth not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing or invalid Authorization header")
    token = authorization.split(" ", 1)[1]
    try:
        resp = sb.auth.get_user(token)
        if not resp or not resp.user:
            raise HTTPException(401, "Invalid token")
        return resp.user
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(401, "Token verification failed")

@app.on_event("startup")
def startup():
    init_db()

# ── Models ──────────────────────────────────────────────────────────────────

class PitchData(BaseModel):
    outing_id: str
    pitcher_name: str
    pitch_type: str          # Fastball, Curveball, etc.
    intended_x: float        # -1.0 to 1.0  (left to right relative to strike zone width)
    intended_y: float        # -1.0 to 1.0  (bottom to top relative to strike zone height)
    actual_x: float          # same scale
    actual_y: float
    velocity: Optional[float] = None
    inning: Optional[int] = None
    batter_hand: Optional[str] = None  # L or R
    result: Optional[str] = None       # Strike, Ball, Hit, etc.
    notes: Optional[str] = None
    balls: Optional[int] = 0
    strikes: Optional[int] = 0
    spin_rate: Optional[float] = None   # rpm
    break_h: Optional[float] = None    # inches, horizontal break
    break_v: Optional[float] = None    # inches, vertical break (induced)

class OutingCreate(BaseModel):
    pitcher_name: str
    outing_type: str = "bullpen"   # "bullpen" | "game"
    opponent: Optional[str] = None


class PitchEdit(BaseModel):
    pitch_type: Optional[str] = None
    result: Optional[str] = None
    notes: Optional[str] = None
    velocity: Optional[float] = None

# ── Strike zone constants ─────────────────────────────────────────────────
# Coordinate system: x in [-1, 1] (left=glove side, right=arm side),
#                    y in [-1, 1] (bottom=low, top=high)
# Zone boundaries map to the MLB rulebook (Official Baseball Rules 2.00):
#   Upper limit: midpoint between top of shoulders and top of uniform pants
#   Lower limit: hollow beneath the kneecap
#   Width:       17 inches (home plate width)
# In normalized coords:
#   y = +1.0 → top of shoulders
#   y = +0.5 → upper boundary (midpoint shoulders/belt) ≈ letters
#   y =  0.0 → belt
#   y = -0.5 → lower boundary (hollow of kneecap)
#   y = -1.0 → floor / ankles
#   x = ±1.0 → edge of plate (8.5" from center)
#   x = ±1.15 → shadow zone edge (ball that just clips the corner)

MLB_UPPER = 0.5   # normalized y of upper strike zone boundary
MLB_LOWER = -0.5  # normalized y of lower strike zone boundary
PLATE_INCHES = 17  # width of home plate in inches

def zone_label(x: float, y: float) -> str:
    """Return descriptive zone label for a coordinate."""
    col = "Inside" if x < -0.33 else ("Middle" if x < 0.33 else "Outside")
    row = "High" if y > 0.33 else ("Middle" if y > -0.33 else "Low")
    return f"{row}-{col}"

def miss_distance(ix, iy, ax, ay) -> float:
    """Euclidean miss distance in normalized units. 1.0 = half strike zone width (8.5")."""
    return math.sqrt((ax - ix) ** 2 + (ay - iy) ** 2)

def rulebook_zone_context(x: float, y: float) -> str:
    """
    Given a pitch location, return a human-readable description anchored to
    the MLB Official Rules strike zone landmarks (per Rule 2.00 / 8.02).
    """
    parts = []

    # Vertical context
    if y > 1.0:
        parts.append("well above the batter's shoulders — far outside the rulebook upper boundary")
    elif y > MLB_UPPER:
        parts.append("above the midpoint between the shoulders and belt — above the upper boundary of the rulebook strike zone")
    elif y > 0.1:
        parts.append("in the upper portion of the rulebook zone (between the letters and the upper boundary)")
    elif y > -0.1:
        parts.append("near belt height — the middle of the rulebook strike zone vertically")
    elif y > MLB_LOWER:
        parts.append("in the lower portion of the rulebook zone (between the belt and the hollow of the kneecap)")
    elif y > -1.0:
        parts.append("below the hollow of the kneecap — below the lower boundary of the rulebook strike zone")
    else:
        parts.append("in the dirt — well below the rulebook strike zone")

    # Horizontal context
    if abs(x) > 1.15:
        side = "arm side" if x > 0 else "glove side"
        parts.append(f"well off the plate to the {side}")
    elif abs(x) > 1.0:
        side = "arm side" if x > 0 else "glove side"
        parts.append(f"just off the corner to the {side} (shadow zone — often called a strike)")
    elif abs(x) > 0.66:
        side = "arm side" if x > 0 else "glove side"
        parts.append(f"on the outer third of the plate to the {side}")
    elif abs(x) > 0.33:
        side = "arm side" if x > 0 else "glove side"
        parts.append(f"toward the {side} half of the plate")
    else:
        parts.append("over the middle of the 17-inch plate")

    return "; ".join(parts)

def miss_description(ix, iy, ax, ay) -> str:
    dx = ax - ix
    dy = ay - iy
    dist = miss_distance(ix, iy, ax, ay)
    if dist < 0.05:
        return "On target"
    parts = []
    if abs(dy) > 0.05:
        parts.append("high" if dy > 0 else "low")
    if abs(dx) > 0.05:
        parts.append("arm-side" if dx > 0 else "glove-side")
    desc = " and ".join(parts)
    inches = round(dist * PLATE_INCHES)
    return f"{desc} by ~{inches} inches"

# ── Endpoints ────────────────────────────────────────────────────────────

@app.post("/outing/start")
def start_outing(data: OutingCreate, user=Depends(get_current_user)):
    oid = str(uuid.uuid4())
    return create_outing(
        oid, data.pitcher_name,
        user_id=user.id,
        outing_type=data.outing_type,
        opponent=data.opponent,
    )


@app.get("/outings/trends")
def outings_trends(user=Depends(get_current_user)):
    return {"trends": get_trends(user_id=user.id)}


@app.delete("/pitch/{pitch_id}")
def remove_pitch(pitch_id: int, user=Depends(get_current_user)):
    delete_pitch(pitch_id)
    return {"status": "deleted"}


@app.patch("/pitch/{pitch_id}")
def edit_pitch(pitch_id: int, data: PitchEdit, user=Depends(get_current_user)):
    updates = {k: v for k, v in data.dict().items() if v is not None}
    updated = update_pitch(pitch_id, updates)
    return updated

@app.get("/outings")
def all_outings(user=Depends(get_current_user)):
    return {"outings": list_outings(user_id=user.id)}

@app.get("/outing/{outing_id}")
def fetch_outing(outing_id: str, user=Depends(get_current_user)):
    outing = get_outing(outing_id)
    if not outing:
        raise HTTPException(404, "Outing not found")
    return outing

@app.delete("/outing/{outing_id}")
def remove_outing(outing_id: str, user=Depends(get_current_user)):
    delete_outing(outing_id)
    return {"status": "deleted"}

@app.post("/pitch/log")
def log_pitch(pitch: PitchData, user=Depends(get_current_user)):
    outing = get_outing(pitch.outing_id)
    if not outing:
        raise HTTPException(404, "Outing not found")
    entry = pitch.dict()
    entry["miss_distance"] = round(miss_distance(pitch.intended_x, pitch.intended_y,
                                                  pitch.actual_x, pitch.actual_y), 3)
    entry["miss_description"] = miss_description(pitch.intended_x, pitch.intended_y,
                                                  pitch.actual_x, pitch.actual_y)
    entry["intended_zone"] = zone_label(pitch.intended_x, pitch.intended_y)
    entry["actual_zone"] = zone_label(pitch.actual_x, pitch.actual_y)
    entry["rulebook_context"] = rulebook_zone_context(pitch.actual_x, pitch.actual_y)
    entry["intended_rulebook_context"] = rulebook_zone_context(pitch.intended_x, pitch.intended_y)
    return save_pitch(entry)

@app.get("/outing/{outing_id}/summary")
def outing_summary(outing_id: str, user=Depends(get_current_user)):
    outing = get_outing(outing_id)
    if not outing:
        raise HTTPException(404, "Outing not found")
    pitches = outing["pitches"]
    if not pitches:
        return {"outing_id": outing_id, "pitcher_name": outing["pitcher_name"],
                "total_pitches": 0, "summary": "No pitches logged yet."}

    total = len(pitches)
    strikes = sum(1 for p in pitches if p.get("result") in ("Strike", "Swinging Strike", "Called Strike"))
    balls = sum(1 for p in pitches if p.get("result") == "Ball")
    avg_miss = round(sum(p["miss_distance"] for p in pitches) / total, 3)
    by_type: dict = {}
    for p in pitches:
        pt = p["pitch_type"]
        if pt not in by_type:
            by_type[pt] = {"count": 0, "total_miss": 0.0, "misses": []}
        by_type[pt]["count"] += 1
        by_type[pt]["total_miss"] += p["miss_distance"]
        by_type[pt]["misses"].append(p["miss_description"])

    pitch_type_summary = {}
    for pt, data in by_type.items():
        avg = round(data["total_miss"] / data["count"], 3)
        pitch_type_summary[pt] = {
            "count": data["count"],
            "avg_miss_distance": avg,
            "most_common_miss": max(set(data["misses"]), key=data["misses"].count)
        }

    return {
        "outing_id": outing_id,
        "pitcher_name": outing["pitcher_name"],
        "created_at": outing.get("created_at"),
        "total_pitches": total,
        "strikes": strikes,
        "balls": balls,
        "strike_percentage": round(strikes / total * 100, 1) if total else 0,
        "avg_miss_distance_normalized": avg_miss,
        "avg_miss_inches": round(avg_miss * 17),
        "by_pitch_type": pitch_type_summary,
        "pitches": pitches,
    }

@app.get("/outing/{outing_id}/pdf")
def export_outing_pdf(outing_id: str, user=Depends(get_current_user)):
    """Generate a clean PDF outing report — pitch chart, miss stats by type, count breakdown."""
    from fastapi.responses import StreamingResponse
    from io import BytesIO
    from reportlab.lib.pagesizes import letter
    from reportlab.lib import colors
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
    from reportlab.graphics.shapes import Drawing, Circle, Line, Rect, String
    from reportlab.graphics import renderPDF

    outing = get_outing(outing_id)
    if not outing:
        raise HTTPException(404, "Outing not found")

    pitches = outing["pitches"]
    pitcher = outing["pitcher_name"]
    date_str = outing.get("created_at", "")[:10]
    total = len(pitches)

    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=letter,
                            leftMargin=0.75*inch, rightMargin=0.75*inch,
                            topMargin=0.75*inch, bottomMargin=0.75*inch)
    styles = getSampleStyleSheet()
    story  = []

    # ── Title ──────────────────────────────────────────────────────────────
    title_style = ParagraphStyle('T', parent=styles['Title'], fontSize=22, spaceAfter=4, textColor=colors.HexColor('#1e293b'))
    sub_style   = ParagraphStyle('S', parent=styles['Normal'], fontSize=10, textColor=colors.HexColor('#64748b'), spaceAfter=12)
    h2_style    = ParagraphStyle('H2', parent=styles['Heading2'], fontSize=13, textColor=colors.HexColor('#1e293b'), spaceBefore=16, spaceAfter=6)
    body_style  = ParagraphStyle('B', parent=styles['Normal'], fontSize=10, textColor=colors.HexColor('#334155'))

    story.append(Paragraph(f"⚾ Outing Report — {pitcher}", title_style))
    story.append(Paragraph(f"{date_str}  ·  {total} pitches logged", sub_style))
    story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor('#e2e8f0')))
    story.append(Spacer(1, 10))

    # ── Summary stats table ────────────────────────────────────────────────
    if total:
        strikes_res = sum(1 for p in pitches if p.get("result") in ("Strike","Swinging Strike","Called Strike","Foul"))
        balls_res   = sum(1 for p in pitches if p.get("result") == "Ball")
        avg_miss_in = round(sum(p.get("miss_distance",0) for p in pitches) / total * 17, 1)
        strike_pct  = round(strikes_res / total * 100, 1)

        stat_data = [
            ["Total Pitches", "Strike %", "Avg Miss", "Balls"],
            [str(total), f"{strike_pct}%", f"{avg_miss_in}\"", str(balls_res)],
        ]
        stat_tbl = Table(stat_data, colWidths=[1.5*inch]*4)
        stat_tbl.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#1e40af')),
            ('TEXTCOLOR',  (0,0), (-1,0), colors.white),
            ('FONTSIZE',   (0,0), (-1,0), 9),
            ('FONTNAME',   (0,0), (-1,0), 'Helvetica-Bold'),
            ('BACKGROUND', (0,1), (-1,1), colors.HexColor('#eff6ff')),
            ('FONTSIZE',   (0,1), (-1,1), 16),
            ('FONTNAME',   (0,1), (-1,1), 'Helvetica-Bold'),
            ('ALIGN', (0,0), (-1,-1), 'CENTER'),
            ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
            ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.HexColor('#eff6ff')]),
            ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#bfdbfe')),
            ('TOPPADDING', (0,0), (-1,-1), 8),
            ('BOTTOMPADDING', (0,0), (-1,-1), 8),
        ]))
        story.append(stat_tbl)
        story.append(Spacer(1, 14))

    # ── Strike zone chart (SVG-style via reportlab Drawing) ───────────────
    story.append(Paragraph("Pitch Location Chart", h2_style))

    DW, DH = 300, 320
    d = Drawing(DW, DH)
    # Background
    d.add(Rect(0, 0, DW, DH, fillColor=colors.HexColor('#0f172a'), strokeColor=None))
    # Zone box (center 60% x 55%)
    zx, zy = DW*0.2, DH*0.22
    zw, zh = DW*0.6, DH*0.55
    d.add(Rect(zx, zy, zw, zh, fillColor=None, strokeColor=colors.HexColor('#6366f1'), strokeWidth=1.5, strokeDashArray=[4,3]))
    # Grid lines
    for f in [1/3, 2/3]:
        d.add(Line(zx, zy+zh*f, zx+zw, zy+zh*f, strokeColor=colors.HexColor('#1e293b'), strokeWidth=0.5))
        d.add(Line(zx+zw*f, zy, zx+zw*f, zy+zh, strokeColor=colors.HexColor('#1e293b'), strokeWidth=0.5))

    # Map norm coords → drawing coords
    # norm x: -1=left, 1=right → zx..zx+zw
    # norm y: -1=bottom, 1=top → zy..zy+zh (reportlab y increases upward)
    def to_drawing(nx, ny):
        px = zx + (nx + 1) / 2 * zw
        py = zy + (ny + 1) / 2 * zh
        return px, py

    PITCH_COLORS_PDF = {
        'Fastball': '#ef4444', 'Curveball': '#3b82f6', 'Slider': '#a855f7',
        'Changeup': '#f59e0b', 'Cutter': '#06b6d4', 'Sinker': '#10b981',
        'Two-Seam': '#f97316', 'Splitter': '#ec4899', 'Other': '#9ca3af',
    }
    for i, p in enumerate(pitches):
        ax, ay = p.get("actual_x", 0), p.get("actual_y", 0)
        px, py = to_drawing(ax, ay)
        col = colors.HexColor(PITCH_COLORS_PDF.get(p.get("pitch_type","Other"), '#9ca3af'))
        d.add(Circle(px, py, 7, fillColor=col, strokeColor=colors.white, strokeWidth=0.5))
        lbl = String(px, py-3, str(i+1), fillColor=colors.white,
                     fontSize=5, textAnchor='middle', fontName='Helvetica-Bold')
        d.add(lbl)

    story.append(d)
    story.append(Spacer(1, 14))

    # ── By pitch type table ────────────────────────────────────────────────
    story.append(Paragraph("Miss Analysis by Pitch Type", h2_style))
    by_type: dict = {}
    for p in pitches:
        pt = p.get("pitch_type","Other")
        if pt not in by_type:
            by_type[pt] = {"count":0, "miss_total":0.0, "misses":[], "strikes":0}
        by_type[pt]["count"] += 1
        by_type[pt]["miss_total"] += p.get("miss_distance", 0)
        by_type[pt]["misses"].append(p.get("miss_description",""))
        if p.get("result") in ("Strike","Called Strike","Swinging Strike","Foul"):
            by_type[pt]["strikes"] += 1

    tbl_data = [["Pitch", "# Thrown", "Strike %", "Avg Miss", "Common Miss"]]
    for pt, d2 in by_type.items():
        avg_in = round(d2["miss_total"] / d2["count"] * 17, 1)
        spct   = round(d2["strikes"] / d2["count"] * 100)
        common = max(set(d2["misses"]), key=d2["misses"].count) if d2["misses"] else "—"
        tbl_data.append([pt, str(d2["count"]), f"{spct}%", f"{avg_in}\"", common[:40]])

    type_tbl = Table(tbl_data, colWidths=[1.1*inch, 0.8*inch, 0.8*inch, 0.8*inch, 3.0*inch])
    type_tbl.setStyle(TableStyle([
        ('BACKGROUND',  (0,0), (-1,0), colors.HexColor('#1e40af')),
        ('TEXTCOLOR',   (0,0), (-1,0), colors.white),
        ('FONTNAME',    (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE',    (0,0), (-1,-1), 9),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, colors.HexColor('#f8fafc')]),
        ('GRID',        (0,0), (-1,-1), 0.4, colors.HexColor('#e2e8f0')),
        ('ALIGN',       (1,0), (-2,-1), 'CENTER'),
        ('TOPPADDING',  (0,0), (-1,-1), 5),
        ('BOTTOMPADDING',(0,0),(-1,-1), 5),
    ]))
    story.append(type_tbl)
    story.append(Spacer(1, 14))

    # ── Count breakdown ────────────────────────────────────────────────────
    pitches_with_count = [p for p in pitches if p.get("balls") is not None]
    if pitches_with_count:
        story.append(Paragraph("Pitch Usage by Count", h2_style))
        count_groups: dict = {}
        for p in pitches_with_count:
            key = f"{p.get('balls',0)}-{p.get('strikes',0)}"
            count_groups.setdefault(key, []).append(p.get("pitch_type","Other"))
        cnt_data = [["Count", "Pitches Thrown", "Most Used"]]
        for count_str in sorted(count_groups.keys()):
            pts = count_groups[count_str]
            most = max(set(pts), key=pts.count)
            cnt_data.append([count_str, str(len(pts)), most])
        cnt_tbl = Table(cnt_data, colWidths=[1.2*inch, 1.5*inch, 2.0*inch])
        cnt_tbl.setStyle(TableStyle([
            ('BACKGROUND',  (0,0),(-1,0), colors.HexColor('#1e40af')),
            ('TEXTCOLOR',   (0,0),(-1,0), colors.white),
            ('FONTNAME',    (0,0),(-1,0), 'Helvetica-Bold'),
            ('FONTSIZE',    (0,0),(-1,-1), 9),
            ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#f8fafc')]),
            ('GRID',        (0,0),(-1,-1), 0.4, colors.HexColor('#e2e8f0')),
            ('ALIGN',       (0,0),(-1,-1), 'CENTER'),
            ('TOPPADDING',  (0,0),(-1,-1), 5),
            ('BOTTOMPADDING',(0,0),(-1,-1), 5),
        ]))
        story.append(cnt_tbl)
        story.append(Spacer(1, 14))

    # ── Pitch log ──────────────────────────────────────────────────────────
    story.append(Paragraph("Full Pitch Log", h2_style))
    log_data = [["#", "Count", "Type", "MPH", "Result", "Miss", "Notes"]]
    for i, p in enumerate(pitches):
        cnt  = f"{p.get('balls','-')}-{p.get('strikes','-')}"
        miss = f"{round(p.get('miss_distance',0)*17,1)}\""
        log_data.append([
            str(i+1), cnt, p.get("pitch_type",""), str(p.get("velocity","") or ""),
            p.get("result",""), miss, (p.get("notes","") or "")[:30],
        ])
    log_tbl = Table(log_data, colWidths=[0.3*inch,0.55*inch,0.9*inch,0.5*inch,1.1*inch,0.5*inch,2.65*inch])
    log_tbl.setStyle(TableStyle([
        ('BACKGROUND',  (0,0),(-1,0), colors.HexColor('#1e40af')),
        ('TEXTCOLOR',   (0,0),(-1,0), colors.white),
        ('FONTNAME',    (0,0),(-1,0), 'Helvetica-Bold'),
        ('FONTSIZE',    (0,0),(-1,-1), 8),
        ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#f8fafc')]),
        ('GRID',        (0,0),(-1,-1), 0.3, colors.HexColor('#e2e8f0')),
        ('ALIGN',       (0,0),(5,-1), 'CENTER'),
        ('TOPPADDING',  (0,0),(-1,-1), 4),
        ('BOTTOMPADDING',(0,0),(-1,-1), 4),
    ]))
    story.append(log_tbl)

    doc.build(story)
    buf.seek(0)
    filename = f"{pitcher.replace(' ','_')}_{date_str}_outing.pdf"
    return StreamingResponse(buf, media_type="application/pdf",
                             headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# ── Video frame extraction ───────────────────────────────────────────────

@app.post("/video/analyze")
async def analyze_video(file: UploadFile = File(...), pitch_type: str = "Fastball", batter_hand: str = "R"):
    """
    Upload a video. Automatically tracks the baseball using multi-method CV
    (frame diff + brightness threshold + Hough circles), finds plate crossing,
    and returns a full pitch analysis with mistakes and positives.
    """
    import tempfile, os
    from detector import analyze_pitch_video

    data = await file.read()
    suffix = ".mp4"
    if file.filename:
        ext = os.path.splitext(file.filename)[1].lower()
        if ext in (".mov", ".avi", ".mkv", ".mp4", ".m4v"):
            suffix = ext

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    try:
        detection = analyze_pitch_video(tmp_path)
    except Exception as e:
        os.unlink(tmp_path)
        raise HTTPException(500, f"Video processing error: {str(e)}")
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass

    # ── Could not detect ball ─────────────────────────────────────────────
    if not detection.get("detected"):
        return {
            "detected": False,
            "message": detection.get("error", "Ball not detected"),
            "debug": detection.get("debug", ""),
            "pitch_location": None,
            "best_frame_b64": None,
            "duration": detection.get("duration", 0),
            "total_frames": detection.get("total_frames", 0),
            "mistakes": [],
            "positives": [],
        }

    norm_x = detection["norm_x"]
    norm_y = detection["norm_y"]
    traj_len = detection.get("trajectory_length", 0)
    total_dets = detection.get("total_detections", 0)

    # ── Zone + rulebook analysis ─────────────────────────────────────────
    zone = zone_label(norm_x, norm_y)
    rulebook = rulebook_zone_context(norm_x, norm_y)
    inches_from_center = round(miss_distance(0, 0, norm_x, norm_y) * 17)
    in_zone = abs(norm_x) <= 1.0 and MLB_LOWER <= norm_y <= MLB_UPPER

    mistakes, positives = [], []

    if not in_zone:
        if norm_y > MLB_UPPER:
            mistakes.append(
                "Pitch was HIGH — above the midpoint between the shoulders and belt (upper rulebook boundary). "
                "High balls are easy to take and produce pop-ups when swung at. "
                "Focus on finishing the pitch downward through the release point."
            )
        elif norm_y < MLB_LOWER:
            mistakes.append(
                "Pitch was LOW — below the hollow of the kneecap (lower rulebook boundary). "
                "Low balls that miss badly give free passes; aim for the bottom of the zone where ground balls happen."
            )
        if norm_x > 1.0:
            miss_in = round((norm_x - 1.0) * 8.5)
            mistakes.append(
                f"Missed arm-side by ~{miss_in}\" off the plate. "
                "This typically means the arm dragged or the release point drifted — "
                "work on keeping the elbow up and driving through the target."
            )
        elif norm_x < -1.0:
            miss_in = round((abs(norm_x) - 1.0) * 8.5)
            mistakes.append(
                f"Missed glove-side by ~{miss_in}\" off the plate. "
                "Early hip rotation often causes the arm to cut across the body — "
                "focus on staying closed longer and leading with the hip."
            )
    else:
        positives.append(f"Pitch hit the strike zone — {zone} of the 17-inch plate.")
        if abs(norm_x) > 0.6:
            positives.append("Good use of the corners — pitches on the thirds of the plate are much harder to square up.")
        if norm_y < -0.1:
            positives.append("Lower half location — generates more ground balls and weak contact.")
        if norm_y > 0.1:
            positives.append("Upper half location — effective for high-spin pitches; batters struggle to elevate these.")

    if inches_from_center > 12:
        mistakes.append(
            f"Command miss of ~{inches_from_center}\" from the center of the plate. "
            "A miss that large usually points to a mechanical inconsistency — check release point and stride direction."
        )
    elif inches_from_center > 6:
        mistakes.append(
            f"Slight command miss of ~{inches_from_center}\" from center. "
            "Refine finger pressure at release and ensure consistent arm path."
        )

    # Trajectory drift note
    if traj_len >= 4:
        positives.append(f"Ball tracked across {traj_len} frames — good video quality for analysis.")

    summary = (
        f"The {pitch_type} was located in the {zone} of the strike zone. "
        f"{'Called BALL — outside the rulebook zone. ' if not in_zone else 'In the STRIKE ZONE. '}"
        f"{rulebook}"
    )

    return {
        "detected": True,
        "pitch_location": {"x": round(norm_x, 3), "y": round(norm_y, 3)},
        "in_zone": in_zone,
        "zone_label": zone,
        "rulebook_context": rulebook,
        "inches_from_center": inches_from_center,
        "summary": summary,
        "mistakes": mistakes,
        "positives": positives,
        "trajectory_points": traj_len,
        "total_detections": total_dets,
        "best_frame_b64": detection.get("frame_b64"),
        "duration": detection.get("duration", 0),
        "total_frames": detection.get("total_frames", 0),
        "pitch_type": pitch_type,
    }


@app.post("/video/analyze-pitcher")
async def analyze_pitcher_video(file: UploadFile = File(...), pitch_type: str = "Fastball", batter_hand: str = "R"):
    """
    Analyze a video filmed from behind the pitcher.
    Detects release point, arm path, horizontal break, vertical drop,
    and plate location from the pitcher's perspective.
    """
    import tempfile, os
    from detector import analyze_pitcher_pov

    data = await file.read()
    suffix = ".mp4"
    if file.filename:
        ext = os.path.splitext(file.filename)[1].lower()
        if ext in (".mov", ".avi", ".mkv", ".mp4", ".m4v"):
            suffix = ext

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    try:
        detection = analyze_pitcher_pov(tmp_path)
    except Exception as e:
        raise HTTPException(500, f"Video processing error: {str(e)}")
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass

    if not detection.get("detected"):
        return {
            "detected": False,
            "message": detection.get("error", "Ball not detected in video"),
            "pitch_location": None,
            "best_frame_b64": None,
            "mechanics": {},
            "mistakes": [],
            "positives": [],
            "duration": detection.get("duration", 0),
            "total_frames": detection.get("total_frames", 0),
        }

    norm_x = detection["plate_norm_x"]
    norm_y = detection["plate_norm_y"]
    mechanics = detection.get("mechanics", {})
    h_break = detection.get("horizontal_break_inches", 0)
    v_drop = detection.get("vertical_drop_inches", 0)

    zone = zone_label(norm_x, norm_y)
    rulebook = rulebook_zone_context(norm_x, norm_y)
    inches_from_center = round(miss_distance(0, 0, norm_x, norm_y) * 17)
    in_zone = abs(norm_x) <= 1.0 and MLB_LOWER <= norm_y <= MLB_UPPER

    mistakes, positives = [], []

    # Zone mistakes
    if not in_zone:
        if norm_y > MLB_UPPER:
            mistakes.append("Pitch ended HIGH — above the upper rulebook boundary (midpoint between shoulders and belt). Likely caused by the arm releasing early or too much upward wrist snap.")
        elif norm_y < MLB_LOWER:
            mistakes.append("Pitch ended LOW — below the hollow of the kneecap. Check if the front side is collapsing during delivery causing a downward pull.")
        if norm_x > 1.0:
            mistakes.append(f"Missed arm-side by ~{round((norm_x-1)*8.5)}\" off the plate. From pitcher POV this is typically a late arm issue — the hand trails behind the hip rotation.")
        elif norm_x < -1.0:
            mistakes.append(f"Missed glove-side by ~{round((abs(norm_x)-1)*8.5)}\" off the plate. Early shoulder rotation is the most common cause — stay closed longer through the delivery.")
    else:
        positives.append(f"Pitch located in the {zone} of the 17-inch strike zone.")
        if abs(norm_x) > 0.6:
            positives.append("Good corner location — pitches at the edges of the plate are hardest to drive for consistent power.")
        if norm_y < -0.1:
            positives.append("Lower half location — pitching down in the zone keeps the ball on the ground and out of the barrel.")

    # Mechanics feedback
    for key, note in mechanics.items():
        if any(word in note.lower() for word in ["inconsistent", "lower", "bias", "dragging", "variation", "drift", "flat", "early"]):
            mistakes.append(note)
        else:
            positives.append(note)

    return {
        "detected": True,
        "pitch_location": {"x": round(norm_x, 3), "y": round(norm_y, 3)},
        "in_zone": in_zone,
        "zone_label": zone,
        "rulebook_context": rulebook,
        "inches_from_center": inches_from_center,
        "horizontal_break_inches": h_break,
        "vertical_drop_inches": v_drop,
        "release_point": detection.get("release_point"),
        "mistakes": mistakes,
        "positives": positives,
        "trajectory_points": detection.get("trajectory_length", 0),
        "best_frame_b64": detection.get("frame_b64"),
        "duration": detection.get("duration", 0),
        "total_frames": detection.get("total_frames", 0),
        "pitch_type": pitch_type,
    }


class VideoZoneCalibration(BaseModel):
    # Two clicks on the uploaded frame: top-left and bottom-right of the strike zone
    # expressed as fractions of frame dimensions (0.0–1.0)
    tl_x: float   # top-left x
    tl_y: float   # top-left y
    br_x: float   # bottom-right x
    br_y: float   # bottom-right y
    pov: str = "catcher"  # "catcher" | "pitcher"

@app.post("/video/analyze-broadcast")
async def analyze_broadcast_video(file: UploadFile = File(...), pitch_type: str = "Fastball", batter_hand: str = "R"):
    """Analyze a broadcast / side-view / center-field camera video."""
    import tempfile, os
    from detector import analyze_broadcast_pov

    data = await file.read()
    suffix = ".mp4"
    if file.filename:
        ext = os.path.splitext(file.filename)[1].lower()
        if ext in (".mov", ".avi", ".mkv", ".mp4", ".m4v"):
            suffix = ext

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    try:
        detection = analyze_broadcast_pov(tmp_path)
    except Exception as e:
        raise HTTPException(500, f"Video processing error: {str(e)}")
    finally:
        try: os.unlink(tmp_path)
        except: pass

    if not detection.get("detected"):
        return {"detected": False, "message": detection.get("error", "Ball not detected"),
                "debug": detection.get("debug", ""), "pitch_location": None,
                "best_frame_b64": None, "mistakes": [], "positives": [],
                "duration": detection.get("duration", 0), "total_frames": detection.get("total_frames", 0)}

    norm_x = detection["plate_norm_x"]
    norm_y = detection["plate_norm_y"]
    mechanics = detection.get("mechanics", {})

    zone  = zone_label(norm_x, norm_y)
    rulebook = rulebook_zone_context(norm_x, norm_y)
    inches_from_center = round(miss_distance(0, 0, norm_x, norm_y) * 17)
    in_zone = abs(norm_x) <= 1.0 and MLB_LOWER <= norm_y <= MLB_UPPER

    mistakes, positives = [], []
    if not in_zone:
        if norm_y > MLB_UPPER:
            mistakes.append("Pitch ended HIGH — above the upper rulebook boundary.")
        elif norm_y < MLB_LOWER:
            mistakes.append("Pitch ended LOW — below the hollow of the kneecap.")
        if norm_x > 1.0:
            mistakes.append(f"Missed arm-side by ~{round((norm_x-1)*8.5)}\" off the plate.")
        elif norm_x < -1.0:
            mistakes.append(f"Missed glove-side by ~{round((abs(norm_x)-1)*8.5)}\" off the plate.")
    else:
        positives.append(f"Pitch located in the {zone} of the strike zone.")

    for note in mechanics.values():
        if any(w in note.lower() for w in ["flat", "dropped", "miss", "drag", "inconsistent"]):
            mistakes.append(note)
        else:
            positives.append(note)

    return {
        "detected": True,
        "pitch_location": {"x": round(norm_x, 3), "y": round(norm_y, 3)},
        "in_zone": in_zone, "zone_label": zone, "rulebook_context": rulebook,
        "inches_from_center": inches_from_center,
        "horizontal_break_inches": detection.get("horizontal_break_inches", 0),
        "vertical_drop_inches": detection.get("vertical_drop_inches", 0),
        "mistakes": mistakes, "positives": positives,
        "trajectory_points": detection.get("trajectory_length", 0),
        "best_frame_b64": detection.get("frame_b64"),
        "duration": detection.get("duration", 0),
        "total_frames": detection.get("total_frames", 0),
        "pitch_type": pitch_type,
    }


@app.post("/video/calibrate-zone")
def calibrate_video_zone(data: VideoZoneCalibration):
    """
    Accept two clicked corners of the strike zone on a video frame
    (as fractions of the frame) and compute the zone mapping constants
    that get stored in the detector module for subsequent analyses.
    """
    from detector import CATCHER_ZONE, PITCHER_ZONE

    x_center = (data.tl_x + data.br_x) / 2
    y_center = (data.tl_y + data.br_y) / 2
    x_half   = abs(data.br_x - data.tl_x) / 2
    y_half   = abs(data.br_y - data.tl_y) / 2

    if x_half < 0.01 or y_half < 0.01:
        raise HTTPException(400, "Zone too small — click further apart corners")

    zone = {"x_center": x_center, "x_half": x_half,
            "y_center": y_center, "y_half": y_half}

    import detector
    if data.pov == "pitcher":
        detector.PITCHER_ZONE.update(zone)
    else:
        detector.CATCHER_ZONE.update(zone)

    return {"status": "calibrated", "pov": data.pov, "zone": zone}


# ── Frame-accurate session store ────────────────────────────────────────────
import os as _os
_frame_sessions: dict = {}   # session_id -> {frame_dir, frame_count, fps, width, height}

def _do_extract(tmp_path: str, frame_dir: str, session_id: str) -> dict:
    """Runs in a thread — CPU-bound OpenCV work, won't block the event loop."""
    import shutil
    cap = cv2.VideoCapture(tmp_path)
    _os.unlink(tmp_path)
    if not cap.isOpened():
        shutil.rmtree(frame_dir, ignore_errors=True)
        return {"error": "Could not open video"}

    fps    = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    scale  = min(1.0, 1280 / max(width, 1))
    out_w  = int(width  * scale)
    out_h  = int(height * scale)

    frame_count = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if scale < 1.0:
            frame = cv2.resize(frame, (out_w, out_h))
        cv2.imwrite(f"{frame_dir}/{frame_count:05d}.jpg", frame,
                    [cv2.IMWRITE_JPEG_QUALITY, 80])
        frame_count += 1
    cap.release()

    _frame_sessions[session_id] = {
        "frame_dir": frame_dir, "frame_count": frame_count,
        "fps": fps, "width": out_w, "height": out_h,
    }
    return {"session_id": session_id, "frame_count": frame_count,
            "fps": fps, "width": out_w, "height": out_h}


@app.post("/video/extract-all")
async def extract_all_frames(file: UploadFile = File(...)):
    """
    Extract every frame of a video to disk; return a session_id the client
    uses to fetch individual frames via GET /video/frame/{session_id}/{idx}.
    Runs in a thread pool so it never blocks the event loop.
    """
    import tempfile, asyncio
    session_id = str(uuid.uuid4())
    frame_dir  = f"/tmp/pitchframes_{session_id}"
    _os.makedirs(frame_dir, exist_ok=True)

    ext = _os.path.splitext(file.filename or "v.mp4")[1].lower() or ".mp4"
    data = await file.read()

    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    loop   = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, _do_extract, tmp_path, frame_dir, session_id)

    if "error" in result:
        raise HTTPException(400, result["error"])
    return result


@app.get("/video/frame/{session_id}/{frame_idx}")
async def get_extracted_frame(session_id: str, frame_idx: int):
    """Return a single extracted frame as JPEG."""
    from fastapi.responses import FileResponse
    if session_id not in _frame_sessions:
        raise HTTPException(404, "Session not found")
    info = _frame_sessions[session_id]
    path = f"{info['frame_dir']}/{frame_idx:05d}.jpg"
    if not _os.path.exists(path):
        raise HTTPException(404, f"Frame {frame_idx} not found")
    return FileResponse(path, media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=3600"})


@app.post("/video/frames")
async def extract_frames_for_marking(file: UploadFile = File(...), n_frames: int = 12):
    """
    Upload a video and get N evenly-spaced frames back for manual ball marking.
    Returns base64 frames + metadata so the frontend can build a scrubber.
    """
    import tempfile, os
    data = await file.read()
    suffix = ".mp4"
    if file.filename:
        ext = os.path.splitext(file.filename)[1].lower()
        if ext in (".mov", ".avi", ".mkv", ".mp4", ".m4v"):
            suffix = ext

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    cap = cv2.VideoCapture(tmp_path)
    os.unlink(tmp_path)
    if not cap.isOpened():
        raise HTTPException(400, "Could not open video file")

    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps   = cap.get(cv2.CAP_PROP_FPS) or 30.0
    duration = round(total / fps, 2)

    n = min(n_frames, total, 20)
    indices = [int(total * i / (n - 1)) for i in range(n)] if n > 1 else [total // 2]

    frames_out = []
    for idx in indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = cap.read()
        if not ret:
            continue
        h, w = frame.shape[:2]
        if w > 800:
            s = 800 / w
            frame = cv2.resize(frame, (int(w*s), int(h*s)))
        _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        frames_out.append({
            "frame_idx": idx,
            "timestamp": round(idx / fps, 2),
            "b64": base64.b64encode(buf).decode(),
        })
    cap.release()

    return {"frames": frames_out, "total_frames": total, "fps": fps, "duration": duration}


@app.post("/video/extract-frame")
async def extract_frame(file: UploadFile = File(...), timestamp_pct: float = 0.5):
    """
    Upload a video and get a base64-encoded frame back.
    timestamp_pct: 0.0–1.0, which point in the video to grab (default middle).
    Returns the frame plus video duration info.
    """
    data = await file.read()
    arr = np.frombuffer(data, np.uint8)
    # Write to temp buffer for cv2
    import tempfile, os
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    cap = cv2.VideoCapture(tmp_path)
    os.unlink(tmp_path)

    if not cap.isOpened():
        raise HTTPException(400, "Could not open video file")

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    duration = total_frames / fps

    target_frame = int(total_frames * timestamp_pct)
    cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
    ret, frame = cap.read()
    cap.release()

    if not ret:
        raise HTTPException(400, "Could not extract frame")

    # Resize for display
    h, w = frame.shape[:2]
    max_w = 800
    if w > max_w:
        scale = max_w / w
        frame = cv2.resize(frame, (int(w * scale), int(h * scale)))

    _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    b64 = base64.b64encode(buf).decode()
    return {
        "frame_b64": b64,
        "total_frames": total_frames,
        "fps": fps,
        "duration_seconds": round(duration, 2),
        "extracted_frame_index": target_frame,
    }

# ── TrackMan Analysis ────────────────────────────────────────────────────────

class TrackManData(BaseModel):
    pitch_type: str
    velocity: Optional[float] = None        # mph
    spin_rate: Optional[float] = None       # RPM
    spin_efficiency: Optional[float] = None # % (0-100)
    induced_vertical_break: Optional[float] = None  # IVB, inches
    horizontal_break: Optional[float] = None         # HB, inches (positive = arm side)
    vertical_approach_angle: Optional[float] = None  # VAA, degrees (negative = downward)
    release_extension: Optional[float] = None        # feet
    release_height: Optional[float] = None           # feet
    batter_hand: Optional[str] = "R"

# Spin rate benchmarks (MLB averages, source: TrackMan / Baseball Savant)
SPIN_BENCHMARKS = {
    "Fastball":    {"avg": 2263, "high": 2500, "low": 1900, "ideal_efficiency": 95},
    "Two-Seam":    {"avg": 2165, "high": 2350, "low": 1850, "ideal_efficiency": 90},
    "Sinker":      {"avg": 2100, "high": 2300, "low": 1800, "ideal_efficiency": 88},
    "Cutter":      {"avg": 2545, "high": 2800, "low": 2200, "ideal_efficiency": 65},
    "Slider":      {"avg": 2430, "high": 2700, "low": 2100, "ideal_efficiency": 35},
    "Curveball":   {"avg": 2530, "high": 2800, "low": 2100, "ideal_efficiency": 65},
    "Changeup":    {"avg": 1850, "high": 2100, "low": 1500, "ideal_efficiency": 80},
    "Splitter":    {"avg": 1350, "high": 1600, "low": 1100, "ideal_efficiency": 50},
}

IVB_BENCHMARKS = {
    "Fastball":  {"avg": 16.0, "high": 20.0, "low": 12.0},
    "Two-Seam":  {"avg": 10.0, "high": 14.0, "low": 6.0},
    "Sinker":    {"avg": 6.0,  "high": 10.0, "low": 2.0},
    "Cutter":    {"avg": 5.0,  "high": 8.0,  "low": 2.0},
    "Slider":    {"avg": 1.0,  "high": 5.0,  "low": -8.0},
    "Curveball": {"avg": -8.0, "high": -4.0, "low": -15.0},
    "Changeup":  {"avg": 8.0,  "high": 13.0, "low": 3.0},
    "Splitter":  {"avg": 2.0,  "high": 6.0,  "low": -3.0},
}

def analyze_trackman(data: TrackManData) -> dict:
    feedback = []
    ratings = {}
    concerns = []
    strengths = []

    pt = data.pitch_type
    bench = SPIN_BENCHMARKS.get(pt, SPIN_BENCHMARKS["Fastball"])
    ivb_bench = IVB_BENCHMARKS.get(pt, None)

    # ── Spin Rate ──────────────────────────────────────────────────────────
    if data.spin_rate is not None:
        sr = data.spin_rate
        avg = bench["avg"]
        diff = sr - avg
        pct = round((sr / avg - 1) * 100, 1)

        if sr >= bench["high"]:
            rating = "Elite"
            strengths.append(f"Spin rate of {int(sr)} RPM is elite-level (+{abs(pct)}% above MLB avg)")
        elif sr >= avg + 100:
            rating = "Above Average"
            strengths.append(f"Spin rate of {int(sr)} RPM is above MLB average for {pt} (+{abs(pct)}%)")
        elif sr >= avg - 100:
            rating = "Average"
            feedback.append(f"Spin rate of {int(sr)} RPM is near MLB average for {pt} ({int(avg)} RPM avg)")
        elif sr >= bench["low"]:
            rating = "Below Average"
            concerns.append(f"Spin rate of {int(sr)} RPM is below average for {pt} ({int(avg)} RPM avg, {abs(pct)}% below)")
        else:
            rating = "Low"
            concerns.append(f"Spin rate of {int(sr)} RPM is significantly low for {pt} — pitch likely lacks movement and tunneling ability")

        ratings["spin_rate"] = rating

        # Pitch-specific spin coaching
        if pt == "Fastball":
            if sr >= 2400:
                feedback.append("High spin fastball: elevate in the zone (above the midpoint/letters per the rulebook upper boundary) to maximize perceived rise and generate swings-and-misses above the zone")
            elif sr < 2100:
                feedback.append("Low spin fastball: use sinker/two-seam approach — keep the pitch below the hollow of the kneecap where ground ball probability increases")
        elif pt in ("Slider", "Cutter"):
            if sr < 2000:
                concerns.append("Spin rate is too low for a slider — pitch may be hanging and looping rather than cutting sharply")
            elif sr > 2600:
                strengths.append("High spin slider generates sharp late break — effective when tunneled off the fastball at a similar release point")
        elif pt == "Curveball":
            if sr > 2700:
                strengths.append("High spin curveball generates elite 12-6 depth — most effective when located below the hollow of the kneecap (lower rulebook boundary)")
            elif sr < 2200:
                concerns.append("Low spin curveball may not generate enough downward break — pitch risk being left in the middle of the zone")
        elif pt == "Changeup":
            if data.velocity and sr / data.velocity > 25:
                feedback.append("Spin-to-velocity ratio is high for a changeup — consider a pronated grip to reduce spin and increase fade")

    # ── Spin Efficiency ────────────────────────────────────────────────────
    if data.spin_efficiency is not None:
        eff = data.spin_efficiency
        ideal = bench["ideal_efficiency"]

        if pt in ("Fastball", "Two-Seam", "Sinker", "Changeup"):
            if eff < 70:
                concerns.append(f"Spin efficiency of {eff}% is low for a {pt} — high gyro spin means less of the spin is creating movement (Magnus effect reduced). Check grip and wrist angle at release")
            elif eff >= 90:
                strengths.append(f"Spin efficiency of {eff}% is excellent — nearly all spin is backspin, maximizing the fastball's 'rise' illusion and carry through the zone")
            else:
                feedback.append(f"Spin efficiency of {eff}% is acceptable — moderate gyro component")
        elif pt in ("Slider", "Cutter"):
            if eff > 50:
                concerns.append(f"Spin efficiency of {eff}% is too high for a {pt} — too much Magnus effect spin, pitch may back up instead of cutting. Aim for 25–45% efficiency (gyro-dominant)")
            elif eff < 20:
                concerns.append(f"Spin efficiency of {eff}% is very low — pitch is gyro-dominant and may be drifting rather than cutting sharply")
            else:
                strengths.append(f"Spin efficiency of {eff}% is in the ideal gyro slider range — pitch should generate sharp late horizontal cut")
        elif pt == "Curveball":
            if eff < 50:
                concerns.append(f"Spin efficiency of {eff}% is low for a curveball — too much gyro spin, pitch may have inconsistent depth")
            elif eff >= 65:
                strengths.append(f"Spin efficiency of {eff}% is excellent for a curveball — spin is mostly axis-driven for maximum vertical drop")

        ratings["spin_efficiency"] = "Good" if abs(eff - ideal) < 15 else ("Needs Work" if abs(eff - ideal) < 30 else "Concern")

    # ── Induced Vertical Break ─────────────────────────────────────────────
    if data.induced_vertical_break is not None and ivb_bench:
        ivb = data.induced_vertical_break
        avg_ivb = ivb_bench["avg"]

        if pt in ("Fastball", "Two-Seam", "Sinker", "Changeup"):
            if ivb < ivb_bench["low"]:
                concerns.append(f"IVB of {ivb}\" is below average ({avg_ivb}\" avg for {pt}) — pitch is dropping more than expected, which reduces perceived velocity and tunneling off of breaking balls")
            elif ivb > ivb_bench["high"]:
                strengths.append(f"IVB of {ivb}\" is elite ({avg_ivb}\" avg) — exceptional carry through the zone, pitch appears to 'rise' from the batter's perspective")
            else:
                feedback.append(f"IVB of {ivb}\" is within normal range for a {pt} (avg: {avg_ivb}\")")
        elif pt == "Curveball":
            if ivb > ivb_bench["high"]:
                concerns.append(f"IVB of {ivb}\" for a curveball means not enough downward break — pitch may be getting hit hard when left in the upper half of the zone")
            elif ivb < ivb_bench["low"]:
                strengths.append(f"IVB of {ivb}\" shows excellent depth on the curveball — locate it starting at the lower boundary (hollow of kneecap) or below to maximize swing-and-miss")

        ratings["induced_vertical_break"] = "Good" if ivb_bench["low"] <= ivb <= ivb_bench["high"] else "Needs Work"

    # ── Horizontal Break ───────────────────────────────────────────────────
    if data.horizontal_break is not None:
        hb = data.horizontal_break
        batter = data.batter_hand or "R"

        if pt == "Fastball":
            if abs(hb) < 3:
                feedback.append(f"Horizontal break of {hb}\" is minimal — pitch is straight, which can reduce deception without elite spin rate")
            elif hb > 8:
                strengths.append(f"Arm-side run of {hb}\" on the fastball — effective for backdoor locations and tunneling off sliders/cutters")
        elif pt in ("Slider", "Cutter"):
            glove_side = hb < 0
            if abs(hb) < 4:
                concerns.append(f"Horizontal break of only {hb}\" on the {pt} — limited lateral movement, pitch may be read early by hitters")
            elif abs(hb) > 10:
                strengths.append(f"Horizontal break of {abs(hb)}\" is elite for a {pt} — generates late sweeping action that is very difficult to barrel")

    # ── Vertical Approach Angle ────────────────────────────────────────────
    if data.vertical_approach_angle is not None:
        vaa = data.vertical_approach_angle
        if pt in ("Fastball", "Two-Seam", "Sinker"):
            if vaa > -4.0:
                strengths.append(f"VAA of {vaa}° is flatter than average — pitch enters the hitting zone at a bat-unfriendly angle, increasing weak contact and miss rates")
            elif vaa < -6.5:
                concerns.append(f"VAA of {vaa}° is steep for a fastball — pitch is diving through the zone, easier for hitters to get under (fly balls/pop-ups, but also more barrels)")
            else:
                feedback.append(f"VAA of {vaa}° is average — consider extension and release height adjustments to flatten the angle")

    # ── Release Extension ──────────────────────────────────────────────────
    if data.release_extension is not None:
        ext = data.release_extension
        if ext >= 7.0:
            strengths.append(f"Release extension of {ext} ft is elite — effectively shortens the distance to the plate, adding perceived velocity and reducing batter reaction time")
        elif ext < 5.5:
            concerns.append(f"Release extension of {ext} ft is below average — pitch is released earlier, giving hitters more time to react. Focus on driving toward the plate through release")
        else:
            feedback.append(f"Release extension of {ext} ft is average (MLB avg: ~6.2 ft)")

    # ── Velocity / Pitch Pairing ───────────────────────────────────────────
    if data.velocity is not None:
        vel = data.velocity
        if pt == "Fastball":
            if vel >= 95:
                strengths.append(f"{vel} mph fastball is plus-velocity — combined with elite extension can play up even further")
            elif vel < 88:
                feedback.append(f"{vel} mph fastball is below-average velocity — pitch needs elite movement, location (corners of the 17\" plate), or tunneling to be effective at higher levels")
        elif pt == "Changeup":
            # check if we can infer velo diff from context
            feedback.append(f"Changeup at {vel} mph — ideal differential off fastball is 8–12 mph to maximize deception")

    summary = {
        "pitch_type": pt,
        "strengths": strengths,
        "concerns": concerns,
        "coaching_feedback": feedback,
        "ratings": ratings,
        "rulebook_note": (
            "Per MLB Official Rules (Rule 2.00): the strike zone extends from the midpoint between "
            "the top of the shoulders and top of the uniform pants (upper boundary) to the hollow "
            "beneath the kneecap (lower boundary), across the 17-inch width of home plate. "
            "Pitch location relative to these landmarks determines whether a miss is inside or outside the zone."
        )
    }
    return summary


@app.post("/trackman/analyze")
def analyze_trackman_endpoint(data: TrackManData):
    return analyze_trackman(data)


# ── Mechanics Analysis ───────────────────────────────────────────────────────

@app.get("/mechanics/available")
def mechanics_available():
    """Check if MediaPipe is installed and mechanics analysis is available."""
    try:
        import mediapipe
        return {"available": True, "version": mediapipe.__version__}
    except ImportError:
        return {"available": False, "install": "pip3 install mediapipe --break-system-packages"}


@app.post("/mechanics/analyze")
async def analyze_mechanics(
    file: UploadFile = File(...),
    camera_angle: str = "side",   # "side" or "behind"
):
    """
    Upload a pitching video.
    camera_angle: "side"   → arm slot, release height, hip separation, pulling, trunk direction
                  "behind" → arm circle, follow-through, hip rotation, stride, head stability
    """
    import tempfile, os
    from mechanics import analyze_pitching_video, MEDIAPIPE_AVAILABLE

    if camera_angle not in ("side", "behind"):
        camera_angle = "side"

    if not MEDIAPIPE_AVAILABLE:
        raise HTTPException(503, (
            "MediaPipe is not installed on this server. "
            "Run: pip3 install mediapipe --break-system-packages  and restart."
        ))

    data = await file.read()
    suffix = ".mp4"
    if file.filename:
        ext = os.path.splitext(file.filename)[1].lower()
        if ext in (".mov", ".avi", ".mkv", ".mp4", ".m4v", ".webm"):
            suffix = ext

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    try:
        result = analyze_pitching_video(tmp_path, camera_angle=camera_angle)
    except Exception as e:
        os.unlink(tmp_path)
        raise HTTPException(500, f"Mechanics analysis error: {str(e)}")
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass

    if result.get('error'):
        raise HTTPException(422, result['error'])

    return result


# ── Camera endpoints ─────────────────────────────────────────────────────────

# One tracker per camera session (reset on new stream)
_tracker = BallTracker()

@app.get("/camera/devices")
def camera_devices():
    """List all connected cameras."""
    return {"cameras": list_cameras()}

@app.get("/camera/still")
def camera_still(index: int = 0):
    """Grab a single still frame for calibration."""
    frame_b64 = grab_still(index)
    if frame_b64 is None:
        raise HTTPException(400, f"Could not open camera {index}")
    return {"frame_b64": frame_b64}


class CalibrationData(BaseModel):
    # Each point is [x_fraction, y_fraction] (0.0–1.0 of frame dimensions)
    tl: List[float]  # top-left
    tr: List[float]  # top-right
    bl: List[float]  # bottom-left
    br: List[float]  # bottom-right
    camera_index: int = 0

@app.post("/camera/calibrate")
def calibrate_camera(data: CalibrationData):
    """Save the strike zone corner points (as fractions of frame size)."""
    set_calibration(
        tl=tuple(data.tl),
        tr=tuple(data.tr),
        bl=tuple(data.bl),
        br=tuple(data.br),
    )
    return {"status": "calibrated", "calibration": get_calibration()}

@app.delete("/camera/calibrate")
def reset_calibration():
    clear_calibration()
    return {"status": "cleared"}

@app.get("/camera/calibration")
def get_current_calibration():
    cal = get_calibration()
    return {"calibrated": cal is not None, "calibration": cal}


@app.websocket("/camera/stream")
async def camera_stream(websocket: WebSocket, index: int = 0):
    """
    WebSocket stream:
      - Sends JSON frames: { frame_b64, pitch_detected, pitch_location, trajectory, detections }
      - Accepts JSON messages: { type: "reset_tracker" } or { type: "ping" }
    """
    await websocket.accept()
    global _tracker
    _tracker = BallTracker()

    cap = cv2.VideoCapture(index)
    if not cap.isOpened():
        await websocket.send_text(json.dumps({"error": f"Cannot open camera {index}"}))
        await websocket.close()
        return

    # Set resolution
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                await asyncio.sleep(0.05)
                continue

            h, w = frame.shape[:2]

            # Process detection
            result = _tracker.process_frame(frame)

            # Convert calibration fractions → pixel coords for overlay
            cal = get_calibration()
            cal_px = None
            if cal:
                cal_px = {
                    k: (int(v[0] * w), int(v[1] * h))
                    for k, v in cal.items()
                }

            # Draw overlay
            display = draw_overlay(frame, result, cal_px)
            frame_b64 = encode_frame(display, quality=65)

            msg = {
                "frame_b64": frame_b64,
                "pitch_detected": result["pitch_detected"],
                "pitch_location": result["pitch_location"],
                "trajectory": result["trajectory"][-5:],  # last 5 points only
                "detections": result["detections"],
            }
            await websocket.send_text(json.dumps(msg))

            # Handle incoming messages (non-blocking)
            try:
                data = await asyncio.wait_for(websocket.receive_text(), timeout=0.001)
                msg_in = json.loads(data)
                if msg_in.get("type") == "reset_tracker":
                    _tracker.reset()
            except (asyncio.TimeoutError, Exception):
                pass

            # Target ~20 fps
            await asyncio.sleep(0.05)

    except WebSocketDisconnect:
        pass
    finally:
        cap.release()


@app.get("/health")
def health():
    return {"status": "ok"}
