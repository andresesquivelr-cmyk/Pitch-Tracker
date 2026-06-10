# ⚾ Pitch Tracker

Analyze pitch command for college pitchers. Upload video or mark pitch locations manually, track misses, and generate outing summaries.

## Features
- Log each pitch: type, velocity, intended vs. actual location, result
- Upload video and click on the frame to mark where the pitch crossed
- Strike zone visualization with miss distance and direction
- Outing summary: strike%, avg miss by pitch type, pitch chart heatmap

---

## Running Locally

### Backend (Python / FastAPI)

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### Frontend (React / Vite)

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000 in your browser.

---

## iOS (via Capacitor)

To wrap this as a native iOS app:

```bash
cd frontend
npm install @capacitor/core @capacitor/cli @capacitor/ios
npx cap init "Pitch Tracker" com.yourteam.pitchtracker
npm run build
npx cap add ios
npx cap sync ios
npx cap open ios   # opens Xcode
```

The backend must be reachable from the device (use a local IP or deploy to a server).
Update `vite.config.js` proxy → set the `target` to your server's address.

---

## Project Structure

```
backend/
  main.py           # FastAPI app — pitch logging, video frame extraction, summaries
  requirements.txt

frontend/
  src/
    App.jsx                       # Main screens: start outing, log pitches
    components/
      StrikeZone.jsx              # Interactive SVG strike zone
      VideoAnnotator.jsx          # Video upload + frame click-to-mark
      OutingSummary.jsx           # Outing stats, heatmap, pitch log
```

## Notes

- Data is stored **in memory** on the backend — it resets when the server restarts. For persistence, swap the in-memory `outings` dict in `main.py` with a SQLite or Postgres database.
- The video frame annotator maps where you click on the frame to a normalized strike zone coordinate. For best results, upload video shot from behind the catcher so the strike zone is visible.
