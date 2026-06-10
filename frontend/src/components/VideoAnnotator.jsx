/**
 * VideoAnnotator — Two-point manual pitch marking.
 *
 * Step 1: Scrub to the release frame → click the ball (🟡 orange)
 * Step 2: Scrub to where ball crosses the plate → click it (🟢 green)
 *
 * Clean trajectory line is drawn between the two points.
 * Plate location is converted to normalized strike zone coords and
 * passed to onLocationPicked.
 */
import React, { useState, useRef } from 'react'
import axios from 'axios'

const API = '/api'

// Strike zone occupies roughly center 36% width × 50% height of a catcher-POV frame.
// Adjust these if your camera setup is different.
const ZONE = { xCenter: 0.50, xHalf: 0.18, yCenter: 0.50, yHalf: 0.25 }

function clickToNorm(fx, fy, zone = ZONE) {
  return {
    x: Math.max(-2, Math.min(2, (fx - zone.xCenter) / zone.xHalf)),
    y: Math.max(-2, Math.min(2, (zone.yCenter - fy) / zone.yHalf)),
  }
}

function buildAnalysis(norm_x, norm_y) {
  const inZone = Math.abs(norm_x) <= 1.0 && norm_y >= -0.5 && norm_y <= 0.5
  const inches  = Math.round(Math.sqrt(norm_x ** 2 + norm_y ** 2) * 17)
  const col = norm_x < -0.33 ? 'Inside' : norm_x < 0.33 ? 'Middle' : 'Outside'
  const row = norm_y > 0.33  ? 'High'   : norm_y > -0.33 ? 'Middle' : 'Low'
  const zone = `${row}-${col}`

  let rulebook = ''
  if      (norm_y > 1.0)  rulebook = 'Well above the shoulders — far outside the upper boundary'
  else if (norm_y > 0.5)  rulebook = 'Above midpoint between shoulders and belt — above upper boundary'
  else if (norm_y > 0.1)  rulebook = 'Upper portion of zone (letters to upper boundary)'
  else if (norm_y > -0.1) rulebook = 'Near belt height — vertical middle of the rulebook zone'
  else if (norm_y > -0.5) rulebook = 'Lower portion of zone (belt to hollow of kneecap)'
  else if (norm_y > -1.0) rulebook = 'Below the hollow of the kneecap — below lower boundary'
  else                     rulebook = 'In the dirt — well below the strike zone'

  if      (Math.abs(norm_x) > 1.15) rulebook += `; well off the plate to the ${norm_x > 0 ? 'arm' : 'glove'} side`
  else if (Math.abs(norm_x) > 1.0)  rulebook += `; just off the corner (shadow zone)`
  else if (Math.abs(norm_x) > 0.66) rulebook += `; outer third of the plate`
  else if (Math.abs(norm_x) > 0.33) rulebook += `; toward the ${norm_x > 0 ? 'arm' : 'glove'} side`
  else                               rulebook += '; over the middle of the 17-inch plate'

  const mistakes = [], positives = []
  if (!inZone) {
    if (norm_y > 0.5)  mistakes.push('HIGH — above the upper boundary. Finish the pitch downward through release.')
    if (norm_y < -0.5) mistakes.push('LOW — below the hollow of the kneecap. Stay tall through delivery.')
    if (norm_x > 1.0)  mistakes.push(`Arm-side miss ~${Math.round((norm_x - 1) * 8.5)}". Arm dragging — stay on top and drive through the target.`)
    if (norm_x < -1.0) mistakes.push(`Glove-side miss ~${Math.round((Math.abs(norm_x) - 1) * 8.5)}". Early hip rotation — stay closed longer.`)
  } else {
    positives.push(`Pitch hit the strike zone — ${zone} of the plate.`)
    if (Math.abs(norm_x) > 0.6) positives.push('Corner location — much harder to square up.')
    if (norm_y < -0.1) positives.push('Lower half — generates ground balls and weak contact.')
    if (norm_y > 0.1)  positives.push('Upper half — effective for high-spin pitches.')
  }
  if      (inches > 12) mistakes.push(`Command miss ~${inches}" from center — check release point and stride direction.`)
  else if (inches > 6)  mistakes.push(`Slight miss ~${inches}" from center — refine finger pressure at release.`)

  return { inZone, zone, rulebook, mistakes, positives, inches }
}

export default function VideoAnnotator({ onLocationPicked }) {
  const [sessionId,   setSessionId]   = useState(null)
  const [totalFrames, setTotalFrames] = useState(0)
  const [videoFps,    setVideoFps]    = useState(30)
  const [frameIdx,    setFrameIdx]    = useState(0)
  const [loading,     setLoading]     = useState(false)
  const [markMode,    setMarkMode]    = useState('release')
  const [releasePoint, setReleasePoint] = useState(null)
  const [platePoint,  setPlatePoint]  = useState(null)
  const [analysis,    setAnalysis]    = useState(null)

  const imgRef  = useRef()
  const fileRef = useRef()

  const frameUrl = sessionId
    ? `${API}/video/frame/${sessionId}/${frameIdx}`
    : null

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
  const goFrame = (delta) => setFrameIdx(i => clamp(i + delta, 0, totalFrames - 1))
  const fmtTime = (i) => {
    const t = i / videoFps
    const m = Math.floor(t / 60)
    const s = (t % 60).toFixed(2).padStart(5, '0')
    return `${m}:${s}`
  }

  // ── Load ALL frames via backend extraction ─────────────────────────────────
  const loadFrames = async (e) => {
    const file = e.target.files?.[0]; if (!file) return
    setLoading(true)
    setSessionId(null); setReleasePoint(null); setPlatePoint(null); setAnalysis(null)
    const form = new FormData(); form.append('file', file)
    try {
      const res = await axios.post(`${API}/video/extract-all`, form,
        { headers: { 'Content-Type': 'multipart/form-data' } })
      setSessionId(res.data.session_id)
      setTotalFrames(res.data.frame_count)
      setVideoFps(res.data.fps || 30)
      setFrameIdx(Math.floor((res.data.frame_count || 1) * 0.3))
      setMarkMode('release')
    } catch (err) {
      console.error('Frame extraction failed', err)
    } finally { setLoading(false) }
  }

  // ── Handle click / touch on frame ──────────────────────────────────────────
  const getRelativePos = (clientX, clientY) => {
    if (!imgRef.current) return null
    const rect = imgRef.current.getBoundingClientRect()
    return {
      fx: (clientX - rect.left)  / rect.width,
      fy: (clientY - rect.top)   / rect.height,
    }
  }

  const handleInteraction = (clientX, clientY) => {
    const pos = getRelativePos(clientX, clientY); if (!pos) return
    if (markMode === 'release') {
      setReleasePoint({ ...pos, frameIdx })
      setMarkMode('plate')
    } else {
      const norm = clickToNorm(pos.fx, pos.fy)
      const a = buildAnalysis(norm.x, norm.y)
      setPlatePoint({ ...pos, frameIdx, norm })
      setAnalysis(a)
      onLocationPicked(norm)
    }
  }

  const handleClick = (e) => handleInteraction(e.clientX, e.clientY)
  const handleTouch = (e) => {
    e.preventDefault()
    const t = e.changedTouches[0]
    handleInteraction(t.clientX, t.clientY)
  }


  // ── Upload screen ───────────────────────────────────────────────────────────
  if (!sessionId) {
    return (
      <div className="space-y-4">
        <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4 space-y-2">
          <p className="text-sm font-semibold text-white">Two-point pitch marking</p>
          <div className="flex items-start gap-2 text-xs text-gray-400">
            <span className="text-orange-400 font-bold">1</span>
            <p>Scrub to release frame → click the ball <span className="text-orange-400">(orange marker)</span></p>
          </div>
          <div className="flex items-start gap-2 text-xs text-gray-400">
            <span className="text-green-400 font-bold">2</span>
            <p>Scrub to plate crossing → click the ball <span className="text-green-400">(green marker)</span></p>
          </div>
          <p className="text-xs text-gray-500 pt-1">Works with any video: broadcast, side, catcher, pitcher POV</p>
        </div>

        <button onClick={() => fileRef.current?.click()} disabled={loading}
          className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-xl font-semibold transition text-base">
          {loading ? 'Loading frames...' : '📤 Upload Video'}
        </button>
        <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={loadFrames} />

        {loading && (
          <div className="flex items-center gap-2 text-sm text-gray-400 justify-center py-2">
            <svg className="animate-spin h-5 w-5 text-indigo-400" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
            </svg>
            Extracting frames...
          </div>
        )}
      </div>
    )
  }

  // ── Frame marking screen ────────────────────────────────────────────────────
  const bothMarked     = releasePoint && platePoint
  const releaseVisible = releasePoint?.frameIdx === frameIdx
  const plateVisible   = platePoint?.frameIdx   === frameIdx

  return (
    <div className="space-y-3">
      {/* Step toggle buttons */}
      <div className="flex gap-2">
        <button
          onClick={() => setMarkMode('release')}
          className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border transition ${
            markMode === 'release'
              ? 'border-orange-500 bg-orange-900/30 text-orange-300'
              : releasePoint
                ? 'border-orange-800 bg-gray-900 text-orange-500'
                : 'border-gray-700 bg-gray-800 text-gray-500'
          }`}
        >
          🟡 Release {releasePoint ? '✓' : ''}
        </button>
        <button
          onClick={() => releasePoint && setMarkMode('plate')}
          className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border transition ${
            markMode === 'plate'
              ? 'border-green-500 bg-green-900/30 text-green-300'
              : platePoint
                ? 'border-green-800 bg-gray-900 text-green-500'
                : 'border-gray-700 bg-gray-800 text-gray-500'
          }`}
        >
          🟢 Plate {platePoint ? '✓' : ''}
        </button>
      </div>

      {/* Instruction banner */}
      <div className={`text-xs text-center py-2.5 rounded-xl font-medium ${
        markMode === 'release'
          ? 'bg-orange-900/30 border border-orange-800 text-orange-300'
          : 'bg-green-900/30 border border-green-800 text-green-300'
      }`}>
        {markMode === 'release'
          ? '🟡 Find the release frame → tap the ball'
          : '🟢 Find where ball crosses the plate → tap it'}
      </div>

      {/* Frame viewer with markers */}
      <div
        className="relative rounded-xl overflow-hidden border border-gray-700 bg-black select-none"
        style={{ cursor: 'crosshair', touchAction: 'none' }}
        onClick={handleClick}
        onTouchEnd={handleTouch}
      >
        {frameUrl && (
          <img
            ref={imgRef}
            src={frameUrl}
            alt={`Frame ${frameIdx}`}
            className="w-full pointer-events-none block"
            draggable={false}
          />
        )}

        {/* SVG overlay — trajectory line */}
        {releasePoint && platePoint && (
          <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
            <line
              x1={`${releasePoint.fx * 100}`} y1={`${releasePoint.fy * 100}`}
              x2={`${platePoint.fx * 100}`}   y2={`${platePoint.fy * 100}`}
              stroke="rgba(251,191,36,0.6)" strokeWidth="0.6" strokeDasharray="2,1.5"
            />
          </svg>
        )}

        {/* Release marker (orange) */}
        {releaseVisible && (
          <div
            className="absolute pointer-events-none"
            style={{ left: `${releasePoint.fx * 100}%`, top: `${releasePoint.fy * 100}%`, transform: 'translate(-50%,-50%)' }}
          >
            <div className="w-8 h-8 rounded-full border-2 border-orange-400 bg-orange-400/25 flex items-center justify-center">
              <div className="w-2 h-2 rounded-full bg-orange-400"/>
            </div>
            <span className="absolute -top-6 left-1/2 -translate-x-1/2 text-orange-300 text-xs font-bold whitespace-nowrap bg-black/75 px-1.5 py-0.5 rounded">
              Release
            </span>
          </div>
        )}

        {/* Plate marker (green) */}
        {plateVisible && (
          <div
            className="absolute pointer-events-none"
            style={{ left: `${platePoint.fx * 100}%`, top: `${platePoint.fy * 100}%`, transform: 'translate(-50%,-50%)' }}
          >
            <div className="w-8 h-8 rounded-full border-2 border-green-400 bg-green-400/25 flex items-center justify-center">
              <div className="w-2 h-2 rounded-full bg-green-400"/>
            </div>
            <span className="absolute -top-6 left-1/2 -translate-x-1/2 text-green-300 text-xs font-bold whitespace-nowrap bg-black/75 px-1.5 py-0.5 rounded">
              Plate
            </span>
          </div>
        )}

        {/* Bottom hint */}
        <div className="absolute bottom-0 left-0 right-0 bg-black/65 text-center text-xs text-white/80 py-1.5">
          {bothMarked ? '✓ Both points marked — scroll up for analysis' : 'Tap / click on the ball'}
        </div>
      </div>

      {/* Frame-accurate scrubber */}
      <div className="bg-gray-900 rounded-xl border border-gray-700 p-3 space-y-2">
        <div className="flex justify-between text-xs">
          <span className="font-mono text-white">{fmtTime(frameIdx)}</span>
          <span className="text-gray-400">Frame <span className="text-white font-bold">{frameIdx + 1}</span> / {totalFrames}</span>
          <span className="font-mono text-gray-500">{fmtTime(totalFrames - 1)}</span>
        </div>
        <input
          type="range" min={0} max={totalFrames - 1} step={1} value={frameIdx}
          onChange={e => setFrameIdx(+e.target.value)}
          className="w-full accent-indigo-500 h-2 cursor-pointer"
        />
        <div className="flex items-center justify-center gap-2">
          <button onClick={() => goFrame(-3)} title="-3 frames"
            className="w-10 h-10 bg-gray-800 hover:bg-gray-700 rounded-lg text-white font-bold text-sm transition flex items-center justify-center">‹‹</button>
          <button onClick={() => goFrame(-1)} title="-1 frame"
            className="w-10 h-10 bg-gray-800 hover:bg-gray-700 rounded-lg text-white font-bold text-lg transition flex items-center justify-center">‹</button>
          <span className="text-xs text-gray-600 w-20 text-center">‹/› = 1 frame</span>
          <button onClick={() => goFrame(1)} title="+1 frame"
            className="w-10 h-10 bg-gray-800 hover:bg-gray-700 rounded-lg text-white font-bold text-lg transition flex items-center justify-center">›</button>
          <button onClick={() => goFrame(3)} title="+3 frames"
            className="w-10 h-10 bg-gray-800 hover:bg-gray-700 rounded-lg text-white font-bold text-sm transition flex items-center justify-center">››</button>
        </div>
      </div>

      {/* Reset / re-upload */}
      <div className="flex gap-2">
        <button
          onClick={() => { setReleasePoint(null); setPlatePoint(null); setAnalysis(null); setMarkMode('release') }}
          className="flex-1 py-2.5 text-xs text-gray-500 hover:text-gray-300 border border-gray-700 rounded-xl transition"
        >
          Reset marks
        </button>
        <button
          onClick={() => { setFrames([]); setReleasePoint(null); setPlatePoint(null); setAnalysis(null) }}
          className="flex-1 py-2.5 text-xs text-gray-500 hover:text-gray-300 border border-gray-700 rounded-xl transition"
        >
          New video
        </button>
      </div>

      {/* Analysis results */}
      {analysis && platePoint && (
        <div className="space-y-3 pt-2 border-t border-gray-800">
          <div className={`rounded-xl p-3 border ${analysis.inZone ? 'bg-green-900/40 border-green-700' : 'bg-red-900/40 border-red-700'}`}>
            <div className="flex justify-between items-start">
              <span className={`font-semibold text-sm ${analysis.inZone ? 'text-green-300' : 'text-red-300'}`}>
                {analysis.inZone ? '✓ Strike Zone' : '✗ Ball'}
              </span>
              <span className="text-xs text-gray-400">{analysis.zone}</span>
            </div>
            <p className="text-xs text-gray-400 mt-1">{analysis.rulebook}</p>
          </div>

          {analysis.positives.length > 0 && (
            <div className="bg-emerald-950/50 border border-emerald-800 rounded-xl p-3 space-y-1">
              <p className="text-xs font-semibold text-emerald-400 uppercase tracking-wide">What Worked</p>
              {analysis.positives.map((p, i) => <p key={i} className="text-sm text-emerald-200">✓ {p}</p>)}
            </div>
          )}

          {analysis.mistakes.length > 0 && (
            <div className="bg-red-950/50 border border-red-800 rounded-xl p-3 space-y-1">
              <p className="text-xs font-semibold text-red-400 uppercase tracking-wide">Command Issues</p>
              {analysis.mistakes.map((m, i) => <p key={i} className="text-sm text-red-200">⚠ {m}</p>)}
            </div>
          )}

          <div className="bg-indigo-900/30 border border-indigo-700 rounded-xl p-3">
            <p className="text-indigo-300 font-medium text-sm">📍 Location applied to strike zone</p>
            <p className="text-xs text-gray-400 mt-0.5">
              x={platePoint.norm.x.toFixed(2)}, y={platePoint.norm.y.toFixed(2)} · {analysis.inches}" from center
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
