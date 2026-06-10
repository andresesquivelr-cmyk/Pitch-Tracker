#!/bin/bash
# ─────────────────────────────────────────────
#  Pitch Tracker — Start App
#  Run this every time: bash start.sh
# ─────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Kill anything already on these ports ─────
lsof -ti:8000 | xargs kill -9 2>/dev/null || true
lsof -ti:3000 | xargs kill -9 2>/dev/null || true

echo ""
echo "⚾  Starting Pitch Tracker..."
echo "────────────────────────────"

# ── Backend ───────────────────────────────────
cd "$SCRIPT_DIR/backend"
echo "🔧  Backend  →  http://localhost:8000"
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!

# ── Wait for backend ──────────────────────────
sleep 2

# ── Frontend ──────────────────────────────────
cd "$SCRIPT_DIR/frontend"
echo "🌐  Frontend →  http://localhost:3000"
npm run dev &
FRONTEND_PID=$!

echo ""
echo "✅  Both servers running."
echo "   Open http://localhost:3000 in your browser."
echo ""
echo "   Press Ctrl+C to stop everything."
echo ""

# ── Open browser automatically ────────────────
sleep 3
open http://localhost:3000

# ── Wait and clean up on exit ─────────────────
trap "echo ''; echo 'Shutting down...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM

wait
