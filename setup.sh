#!/bin/bash
# ─────────────────────────────────────────────
#  Pitch Tracker — First-time Setup
#  Run once: bash setup.sh
# ─────────────────────────────────────────────

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "⚾  Pitch Tracker Setup"
echo "────────────────────────"

# ── Check Python ─────────────────────────────
if ! command -v python3 &>/dev/null; then
  echo "❌  Python 3 not found."
  echo "    Install it from https://python.org or run: brew install python"
  exit 1
fi
echo "✅  Python: $(python3 --version)"

# ── Check Node ───────────────────────────────
if ! command -v node &>/dev/null; then
  echo "❌  Node.js not found."
  echo "    Install it from https://nodejs.org or run: brew install node"
  exit 1
fi
echo "✅  Node:   $(node --version)"

# ── Python deps ──────────────────────────────
echo ""
echo "📦  Installing Python dependencies..."
cd "$SCRIPT_DIR/backend"
pip3 install fastapi uvicorn python-multipart opencv-python numpy Pillow websockets --quiet
echo "📦  Installing MediaPipe (for automatic mechanics analysis)..."
pip3 install mediapipe --break-system-packages --quiet 2>/dev/null || \
  pip3 install mediapipe --quiet 2>/dev/null || \
  echo "⚠️  MediaPipe install skipped (optional — mechanics auto-analysis won't be available)"

# ── Node deps ────────────────────────────────
echo "📦  Installing Node dependencies..."
cd "$SCRIPT_DIR/frontend"
npm install --silent

echo ""
echo "✅  Setup complete!"
echo ""
echo "👉  To start the app, run:  bash start.sh"
echo "    Then open:              http://localhost:3000"
echo ""
