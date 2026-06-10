"""
database.py — Supabase persistence for Pitch Tracker.

Tables are created in Supabase directly (see SQL in README / setup guide).
Uses supabase-py client for all reads and writes.

Environment variables required:
  SUPABASE_URL         — e.g. https://xxxx.supabase.co
  SUPABASE_SERVICE_KEY — service_role secret key (bypasses RLS)
"""

import os
from datetime import datetime
from typing import Optional

from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

_client: Optional[Client] = None


def _get_client() -> Client:
    global _client
    if _client is None:
        if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables must be set"
            )
        _client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    return _client


def init_db():
    """No-op — tables are created in the Supabase SQL editor. Safe to call on startup."""
    pass


# ── Outings ───────────────────────────────────────────────────────────────────

def create_outing(
    outing_id: str,
    pitcher_name: str,
    user_id: str = None,
    outing_type: str = "bullpen",
    opponent: str = None,
) -> dict:
    now = datetime.utcnow().isoformat()
    record = {
        "id": outing_id,
        "pitcher_name": pitcher_name,
        "created_at": now,
        "outing_type": outing_type,
    }
    if user_id:
        record["user_id"] = user_id
    if opponent:
        record["opponent"] = opponent
    _get_client().table("outings").insert(record).execute()
    return {
        "outing_id": outing_id,
        "pitcher_name": pitcher_name,
        "created_at": now,
        "outing_type": outing_type,
        "opponent": opponent,
    }


def get_outing(outing_id: str) -> Optional[dict]:
    result = _get_client().table("outings").select("*").eq("id", outing_id).execute()
    if not result.data:
        return None
    row = result.data[0]
    pitches = get_pitches_for_outing(outing_id)
    return {
        "outing_id": row["id"],
        "pitcher_name": row["pitcher_name"],
        "created_at": row["created_at"],
        "outing_type": row.get("outing_type", "bullpen"),
        "opponent": row.get("opponent"),
        "pitches": pitches,
    }


def list_outings(user_id: str = None) -> list:
    sb = _get_client()
    query = sb.table("outings").select("id, pitcher_name, created_at, outing_type, opponent").order(
        "created_at", desc=True
    )
    if user_id:
        query = query.eq("user_id", user_id)
    outings_res = query.execute()

    result = []
    for row in outings_res.data:
        count_res = (
            sb.table("pitches")
            .select("id", count="exact")
            .eq("outing_id", row["id"])
            .execute()
        )
        result.append(
            {
                "id": row["id"],
                "pitcher_name": row["pitcher_name"],
                "created_at": row["created_at"],
                "outing_type": row.get("outing_type", "bullpen"),
                "opponent": row.get("opponent"),
                "pitch_count": count_res.count or 0,
            }
        )
    return result


def get_trends(user_id: str) -> list:
    """Return per-outing summary stats for trend analysis, ordered oldest → newest."""
    sb = _get_client()
    outings_res = (
        sb.table("outings")
        .select("id, pitcher_name, created_at, outing_type, opponent")
        .eq("user_id", user_id)
        .order("created_at")
        .execute()
    )

    strike_results = {"Strike", "Swinging Strike", "Called Strike"}
    trends = []
    for outing in outings_res.data:
        pitches_res = (
            sb.table("pitches")
            .select("pitch_type, result, miss_distance, velocity, spin_rate, break_h, break_v")
            .eq("outing_id", outing["id"])
            .execute()
        )
        pitches = pitches_res.data or []
        if not pitches:
            continue

        total = len(pitches)
        strike_count = sum(1 for p in pitches if p.get("result") in strike_results)
        avg_miss = sum(p.get("miss_distance") or 0 for p in pitches) / total

        by_type: dict = {}
        for p in pitches:
            pt = p.get("pitch_type") or "Other"
            if pt not in by_type:
                by_type[pt] = {"count": 0, "miss_total": 0.0}
            by_type[pt]["count"] += 1
            by_type[pt]["miss_total"] += p.get("miss_distance") or 0

        type_summary = {
            pt: {
                "count": d["count"],
                "avg_miss_inches": round(d["miss_total"] / d["count"] * 17, 1),
            }
            for pt, d in by_type.items()
        }

        trends.append(
            {
                "outing_id": outing["id"],
                "pitcher_name": outing["pitcher_name"],
                "created_at": outing["created_at"],
                "outing_type": outing.get("outing_type", "bullpen"),
                "opponent": outing.get("opponent"),
                "total_pitches": total,
                "strike_pct": round(strike_count / total * 100, 1),
                "avg_miss_inches": round(avg_miss * 17, 1),
                "by_type": type_summary,
            }
        )
    return trends


# ── Pitches ───────────────────────────────────────────────────────────────────

def save_pitch(pitch_data: dict) -> dict:
    now = datetime.utcnow().isoformat()
    record = {
        "outing_id":                  pitch_data.get("outing_id"),
        "pitcher_name":               pitch_data.get("pitcher_name"),
        "pitch_type":                 pitch_data.get("pitch_type"),
        "intended_x":                 pitch_data.get("intended_x"),
        "intended_y":                 pitch_data.get("intended_y"),
        "actual_x":                   pitch_data.get("actual_x"),
        "actual_y":                   pitch_data.get("actual_y"),
        "velocity":                   pitch_data.get("velocity"),
        "inning":                     pitch_data.get("inning"),
        "batter_hand":                pitch_data.get("batter_hand"),
        "result":                     pitch_data.get("result"),
        "notes":                      pitch_data.get("notes"),
        "miss_distance":              pitch_data.get("miss_distance"),
        "miss_description":           pitch_data.get("miss_description"),
        "intended_zone":              pitch_data.get("intended_zone"),
        "actual_zone":                pitch_data.get("actual_zone"),
        "rulebook_context":           pitch_data.get("rulebook_context"),
        "intended_rulebook_context":  pitch_data.get("intended_rulebook_context"),
        "balls":                      pitch_data.get("balls", 0),
        "strikes":                    pitch_data.get("strikes", 0),
        "spin_rate":                  pitch_data.get("spin_rate"),
        "break_h":                    pitch_data.get("break_h"),
        "break_v":                    pitch_data.get("break_v"),
        "created_at":                 now,
    }
    _get_client().table("pitches").insert(record).execute()
    return {**pitch_data, "created_at": now}


def get_pitches_for_outing(outing_id: str, conn=None) -> list:
    """conn param kept for backward-compat signature — unused with Supabase."""
    result = (
        _get_client()
        .table("pitches")
        .select("*")
        .eq("outing_id", outing_id)
        .order("created_at")
        .execute()
    )
    return result.data or []


def delete_pitch(pitch_id: int):
    _get_client().table("pitches").delete().eq("id", pitch_id).execute()


def update_pitch(pitch_id: int, updates: dict) -> dict:
    """Update editable fields on a pitch. Returns updated record."""
    allowed = {"pitch_type", "result", "notes", "velocity"}
    payload = {k: v for k, v in updates.items() if k in allowed}
    result = (
        _get_client()
        .table("pitches")
        .update(payload)
        .eq("id", pitch_id)
        .execute()
    )
    return result.data[0] if result.data else {}


def delete_outing(outing_id: str):
    sb = _get_client()
    # Cascade delete is on in the schema; delete pitches first for safety
    sb.table("pitches").delete().eq("outing_id", outing_id).execute()
    sb.table("outings").delete().eq("id", outing_id).execute()
