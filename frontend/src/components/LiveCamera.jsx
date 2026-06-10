/**
 * LiveCamera
 * Connects to the backend WebSocket camera stream.
 * Handles 3 states:
 *   1. "setup"      — pick camera, grab still, click 4 zone corners to calibrate
 *   2. "live"       — streaming feed with ball detection overlay
 *   3. "detected"   — pitch was auto-detected, confirm location
 *
 * Props:
 *   onPitchDetected({ x, y }) — called when a pitch location is confirmed
 */
import React, { useState, useEffect, useRef, useCallback } from 'react'
import axios from 'axios'

const API = '/api'
const WS_BASE = 'ws://localhost:8000'

const CORNER_LABELS = ['tl', 'tr', 'bl', 'br']
const CORNER_NAMES  = ['Top-Left', 'Top-Right', 'Bottom-Left', 'Bottom-Right']
const CORNER_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444']

export default function LiveCamera({ onPitchDetected }) {
  const [phase, setPhase] = useState('setup')        // setup | calibrating | live | detected
  const [cameras, setCameras] = useState([])
  const [cameraIndex, setCameraIndex] = useState(0)
  const [stillB64, setStillB64] = useState(null)
  const [corners, setCorners] = useState({})         // { tl, tr, bl, br } as [fx, fy]
  const [nextCorner, setNextCorner] = useState(0)    // index into CORNER_LABELS
  const [calibrated, setCalibrated] = useState(false)
  const [liveFrame, setLiveFrame] = useState(null)
  const [lastPitch, setLastPitch] = useState(null)
  const [wsStatus, setWsStatus] = useState('disconnected')
  const [error, setError] = useState('')

  const wsRef = useRef(null)
  const stillImgRef = useRef()
  const liveImgRef = useRef()

  // ── Load cameras on mount ─────────────────────────────────────────────────
  useEffect(() => {
    axios.get(`${API}/camera/devices`)
      .then(r => setCameras(r.data.cameras))
      .catch(() => setCameras([{ index: 0, label: 'Camera 0', resolution: 'unknown' }]))

    axios.get(`${API}/camera/calibration`)
      .then(r => { if (r.data.calibrated) setCalibrated(true) })
      .catch(() => {})
  }, [])

  // ── Grab still for calibration ────────────────────────────────────────────
  const grabStill = async () => {
    setError('')
    try {
      const r = await axios.get(`${API}/camera/still?index=${cameraIndex}`)
      setStillB64(r.data.frame_b64)
      setPhase('calibrating')
      setCorners({})
      setNextCorner(0)
    } catch {
      setError('Could not open camera. Make sure it is connected and not in use by another app.')
    }
  }

  // ── Handle click on still image to set corners ───────────────────────────
  const handleStillClick = (e) => {
    if (nextCorner >= 4) return
    const rect = stillImgRef.current.getBoundingClientRect()
    const fx = (e.clientX - rect.left) / rect.width
    const fy = (e.clientY - rect.top) / rect.height
    const label = CORNER_LABELS[nextCorner]
    const updated = { ...corners, [label]: [fx, fy] }
    setCorners(updated)
    setNextCorner(n => n + 1)

    if (nextCorner === 3) {
      saveCalibration({ ...corners, [label]: [fx, fy] })
    }
  }

  const saveCalibration = async (pts) => {
    try {
      await axios.post(`${API}/camera/calibrate`, {
        tl: pts.tl, tr: pts.tr, bl: pts.bl, br: pts.br,
        camera_index: cameraIndex,
      })
      setCalibrated(true)
    } catch {
      setError('Failed to save calibration.')
    }
  }

  const resetCalibration = async () => {
    await axios.delete(`${API}/camera/calibrate`).catch(() => {})
    setCorners({})
    setNextCorner(0)
    setCalibrated(false)
    setPhase('calibrating')
  }

  // ── Start live stream ─────────────────────────────────────────────────────
  const startStream = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close()
    }
    setWsStatus('connecting')
    setError('')
    setPhase('live')

    const ws = new WebSocket(`${WS_BASE}/camera/stream?index=${cameraIndex}`)
    wsRef.current = ws

    ws.onopen = () => setWsStatus('connected')
    ws.onerror = () => { setWsStatus('error'); setError('WebSocket connection failed.') }
    ws.onclose = () => setWsStatus('disconnected')

    ws.onmessage = (e) => {
      const data = JSON.parse(e.data)
      if (data.error) { setError(data.error); return }
      if (data.frame_b64) setLiveFrame(data.frame_b64)
      if (data.pitch_detected && data.pitch_location) {
        setLastPitch(data.pitch_location)
        setPhase('detected')
      }
    }
  }, [cameraIndex])

  const stopStream = () => {
    wsRef.current?.close()
    setPhase(calibrated ? 'ready' : 'setup')
    setLiveFrame(null)
  }

  const resetTracker = () => {
    wsRef.current?.send(JSON.stringify({ type: 'reset_tracker' }))
    setPhase('live')
    setLastPitch(null)
  }

  const confirmPitch = () => {
    if (lastPitch) onPitchDetected(lastPitch)
    resetTracker()
  }

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => () => wsRef.current?.close(), [])

  // ── Render ────────────────────────────────────────────────────────────────

  const cornerDot = (label, idx) => {
    const pt = corners[label]
    if (!pt) return null
    return (
      <div
        key={label}
        className="absolute w-4 h-4 rounded-full border-2 border-white"
        style={{
          left: `${pt[0] * 100}%`,
          top: `${pt[1] * 100}%`,
          background: CORNER_COLORS[idx],
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
        }}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-base">Live Camera Detection</h3>
        <span className={`text-xs px-2 py-0.5 rounded-full ${
          wsStatus === 'connected' ? 'bg-green-900 text-green-300' :
          wsStatus === 'connecting' ? 'bg-yellow-900 text-yellow-300' :
          'bg-gray-700 text-gray-400'
        }`}>
          {wsStatus === 'connected' ? '● Live' : wsStatus === 'connecting' ? '◌ Connecting' : '○ Off'}
        </span>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {/* ── Phase: setup ── */}
      {(phase === 'setup' || phase === 'ready') && (
        <div className="space-y-3">
          {cameras.length > 1 && (
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Camera</label>
              <div className="flex flex-wrap gap-2">
                {cameras.map(c => (
                  <button key={c.index}
                    onClick={() => setCameraIndex(c.index)}
                    className={`px-3 py-1.5 rounded-lg text-sm transition ${
                      cameraIndex === c.index ? 'bg-indigo-600' : 'bg-gray-800 hover:bg-gray-700'
                    }`}
                  >{c.label} ({c.resolution})</button>
                ))}
              </div>
            </div>
          )}

          {calibrated ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-green-400">
                <span>✓ Strike zone calibrated</span>
                <button onClick={resetCalibration} className="text-xs text-gray-500 hover:text-gray-300 underline">
                  Recalibrate
                </button>
              </div>
              <button
                onClick={startStream}
                className="w-full bg-indigo-600 hover:bg-indigo-500 rounded-xl py-3 font-semibold transition"
              >
                Start Live Detection
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-gray-400">
                First, calibrate the strike zone — the app will take a photo from your camera and you'll click the 4 corners of the strike zone.
              </p>
              <button
                onClick={grabStill}
                className="w-full bg-indigo-600 hover:bg-indigo-500 rounded-xl py-3 font-semibold transition"
              >
                📷 Capture Frame to Calibrate
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Phase: calibrating ── */}
      {phase === 'calibrating' && stillB64 && (
        <div className="space-y-3">
          <div className="bg-indigo-900/40 border border-indigo-700 rounded-xl p-3 text-sm">
            {nextCorner < 4 ? (
              <>
                <span className="font-semibold" style={{ color: CORNER_COLORS[nextCorner] }}>
                  Click {CORNER_NAMES[nextCorner]}
                </span>
                <span className="text-gray-400"> of the strike zone</span>
                <div className="flex gap-1 mt-1">
                  {CORNER_LABELS.map((l, i) => (
                    <span key={l} className={`text-xs px-1.5 py-0.5 rounded ${
                      i < nextCorner ? 'bg-green-900 text-green-300' :
                      i === nextCorner ? 'bg-indigo-700 text-white' :
                      'bg-gray-700 text-gray-400'
                    }`}>{CORNER_NAMES[i].split('-')[0][0]}{CORNER_NAMES[i].split('-')[1][0]}</span>
                  ))}
                </div>
              </>
            ) : (
              <span className="text-green-400">✓ All corners set — saving calibration...</span>
            )}
          </div>

          <div
            className="relative rounded-xl overflow-hidden border border-gray-700 cursor-crosshair"
            onClick={handleStillClick}
          >
            <img ref={stillImgRef} src={`data:image/jpeg;base64,${stillB64}`} className="w-full" alt="calibration frame" />
            {CORNER_LABELS.map((l, i) => cornerDot(l, i))}

            {/* Draw lines between set corners */}
            {Object.keys(corners).length >= 2 && (() => {
              const pts = CORNER_LABELS.map(l => corners[l]).filter(Boolean)
              if (pts.length < 2) return null
              return (
                <svg className="absolute inset-0 w-full h-full" style={{ pointerEvents: 'none' }}>
                  {pts.length >= 2 && <line
                    x1={`${pts[0][0]*100}%`} y1={`${pts[0][1]*100}%`}
                    x2={`${pts[1][0]*100}%`} y2={`${pts[1][1]*100}%`}
                    stroke="#22c55e" strokeWidth="1.5" strokeDasharray="4 2" />}
                  {pts.length >= 3 && <line
                    x1={`${pts[1][0]*100}%`} y1={`${pts[1][1]*100}%`}
                    x2={`${pts[3]?.[0]*100 || pts[2][0]*100}%`} y2={`${pts[3]?.[1]*100 || pts[2][1]*100}%`}
                    stroke="#22c55e" strokeWidth="1.5" strokeDasharray="4 2" />}
                </svg>
              )
            })()}
          </div>

          {nextCorner === 4 && calibrated && (
            <button
              onClick={startStream}
              className="w-full bg-green-700 hover:bg-green-600 rounded-xl py-3 font-semibold transition"
            >
              ✓ Calibrated — Start Live Detection
            </button>
          )}

          <button
            onClick={() => setPhase('setup')}
            className="w-full py-2 text-sm text-gray-500 hover:text-gray-300"
          >
            Cancel
          </button>
        </div>
      )}

      {/* ── Phase: live ── */}
      {phase === 'live' && (
        <div className="space-y-3">
          <div className="relative rounded-xl overflow-hidden border border-gray-700 bg-black">
            {liveFrame ? (
              <img src={`data:image/jpeg;base64,${liveFrame}`} className="w-full" alt="live feed" />
            ) : (
              <div className="aspect-video flex items-center justify-center text-gray-500 text-sm">
                Waiting for camera...
              </div>
            )}
            <div className="absolute top-2 left-2 bg-black/60 rounded px-2 py-0.5 text-xs text-white">
              Watching for pitch...
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={resetTracker}
              className="flex-1 py-2 bg-gray-800 hover:bg-gray-700 rounded-xl text-sm transition"
            >
              Reset Tracker
            </button>
            <button
              onClick={stopStream}
              className="flex-1 py-2 bg-red-900 hover:bg-red-800 rounded-xl text-sm transition"
            >
              Stop Camera
            </button>
          </div>
          <button
            onClick={resetCalibration}
            className="w-full py-1.5 text-xs text-gray-600 hover:text-gray-400"
          >
            Recalibrate zone
          </button>
        </div>
      )}

      {/* ── Phase: detected ── */}
      {phase === 'detected' && lastPitch && (
        <div className="space-y-3">
          {liveFrame && (
            <div className="relative rounded-xl overflow-hidden border border-green-700">
              <img src={`data:image/jpeg;base64,${liveFrame}`} className="w-full" alt="detected pitch" />
              <div className="absolute top-2 left-2 bg-green-900/80 rounded px-2 py-0.5 text-xs text-green-300 font-semibold">
                ⚾ Pitch Detected
              </div>
            </div>
          )}

          <div className="bg-green-900/40 border border-green-700 rounded-xl p-3 text-sm space-y-1">
            <p className="text-green-300 font-semibold">Pitch location auto-detected</p>
            <p className="text-gray-400 text-xs">
              Position: x={lastPitch.x.toFixed(3)}, y={lastPitch.y.toFixed(3)}
            </p>
          </div>

          <div className="flex gap-2">
            <button
              onClick={confirmPitch}
              className="flex-1 py-3 bg-green-700 hover:bg-green-600 rounded-xl font-semibold transition"
            >
              ✓ Use This Location
            </button>
            <button
              onClick={resetTracker}
              className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 rounded-xl text-sm transition"
            >
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
