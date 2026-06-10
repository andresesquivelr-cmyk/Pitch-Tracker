/**
 * BullpenSession — Upload a bullpen video (from behind the catcher) and
 * mark where each pitch was caught to build a full session pitch chart.
 *
 * Workflow:
 *   1. Upload video
 *   2. Calibrate: tap the 4 corners of the strike zone on any frame
 *   3. For each pitch: scrub to the catch frame → tap the glove → label the pitch
 *   4. View running strike zone chart; finish session for full summary
 */

import React, { useState, useRef, useEffect, useCallback } from 'react'

// ── Geometry ──────────────────────────────────────────────────────────────────
function bilinearToNorm(x, y, corners) {
  const [tl, tr, br, bl] = corners
  let s = 0.5, t = 0.5
  for (let i = 0; i < 30; i++) {
    const px = (1-s)*(1-t)*tl[0] + s*(1-t)*tr[0] + s*t*br[0] + (1-s)*t*bl[0]
    const py = (1-s)*(1-t)*tl[1] + s*(1-t)*tr[1] + s*t*br[1] + (1-s)*t*bl[1]
    const dpx_ds = -(1-t)*tl[0] + (1-t)*tr[0] + t*br[0] - t*bl[0]
    const dpy_ds = -(1-t)*tl[1] + (1-t)*tr[1] + t*br[1] - t*bl[1]
    const dpx_dt = -(1-s)*tl[0] - s*tr[0] + s*br[0] + (1-s)*bl[0]
    const dpy_dt = -(1-s)*tl[1] - s*tr[1] + s*br[1] + (1-s)*bl[1]
    const det = dpx_ds * dpy_dt - dpy_ds * dpx_dt
    if (Math.abs(det) < 1e-10) break
    const ex = px - x, ey = py - y
    s -= (dpy_dt * ex - dpx_dt * ey) / det
    t -= (dpx_ds * ey - dpy_ds * ex) / det
    s = Math.max(-0.3, Math.min(1.3, s))
    t = Math.max(-0.3, Math.min(1.3, t))
  }
  return { x: parseFloat(s.toFixed(3)), y: parseFloat(t.toFixed(3)) }
}

// ── Zone chart (mini strike zone with dots) ────────────────────────────────────
const PITCH_COLORS = {
  Fastball: '#ef4444', Curveball: '#3b82f6', Slider: '#a855f7',
  Changeup: '#f59e0b', Cutter: '#06b6d4', Sinker: '#10b981',
  Other: '#9ca3af',
}

function ZoneChart({ pitches, width = 160, height = 200 }) {
  const pad = 24
  const zW = width - pad * 2
  const zH = height - pad * 2

  // Strike zone is center 1/3 of height, middle horizontal
  const szX = pad + zW * 0.2
  const szY = pad + zH * 0.15
  const szW = zW * 0.6
  const szH = zH * 0.65

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
      {/* Background */}
      <rect x={0} y={0} width={width} height={height} fill="transparent" />
      {/* Zone outline */}
      <rect x={szX} y={szY} width={szW} height={szH}
        fill="none" stroke="#4b5563" strokeWidth="1.5" strokeDasharray="4,3" />
      {/* Zone thirds (horizontal lines) */}
      {[1/3, 2/3].map(f => (
        <line key={f}
          x1={szX} y1={szY + szH * f}
          x2={szX + szW} y2={szY + szH * f}
          stroke="#374151" strokeWidth="0.5" />
      ))}
      {/* Zone thirds (vertical lines) */}
      {[1/3, 2/3].map(f => (
        <line key={f}
          x1={szX + szW * f} y1={szY}
          x2={szX + szW * f} y2={szY + szH}
          stroke="#374151" strokeWidth="0.5" />
      ))}
      {/* Home plate symbol */}
      <text x={pad + zW / 2} y={height - 6} textAnchor="middle" fontSize="10" fill="#6b7280">▲ Catcher</text>

      {/* Pitch dots */}
      {pitches.map((p, i) => {
        // Map norm x,y to SVG coords
        // x: 0=left(away to RHH) 1=right(inside to RHH)  → map to szX..szX+szW
        // y: 0=top(high) 1=bottom(low) → map to szY..szY+szH
        const cx = szX + p.norm.x * szW + (szW * 0.2 * (p.norm.x - 0.5))
        const cy = szY + p.norm.y * szH + (szH * 0.1 * (p.norm.y - 0.5))
        const color = PITCH_COLORS[p.type] || PITCH_COLORS.Other
        return (
          <g key={i}>
            <circle cx={cx} cy={cy} r={6} fill={color} opacity={0.85} />
            <text x={cx} y={cy + 4} textAnchor="middle" fontSize="7" fill="white" fontWeight="bold">
              {i + 1}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// ── Strike zone location description ──────────────────────────────────────────
function describeLocation(x, y) {
  const xStr = x < 0.25 ? 'Way Outside' : x < 0.42 ? 'Outside' : x > 0.75 ? 'Way Inside' : x > 0.58 ? 'Inside' : 'Middle'
  const yStr = y < 0.2 ? 'Way High' : y < 0.38 ? 'High' : y > 0.8 ? 'Way Low' : y > 0.62 ? 'Low' : 'Middle'
  const inZone = x >= 0.2 && x <= 0.8 && y >= 0.15 && y <= 0.85
  return { label: `${yStr} ${xStr}`, inZone }
}

// ── Corner labels ─────────────────────────────────────────────────────────────
const CORNERS = ['Top-Left', 'Top-Right', 'Bottom-Right', 'Bottom-Left']
const CORNER_COLORS = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b']

const PITCH_TYPES = ['Fastball', 'Curveball', 'Slider', 'Changeup', 'Cutter', 'Sinker', 'Other']

// ── Main component ─────────────────────────────────────────────────────────────
const API = '/api'

export default function BullpenSession({ onSessionComplete }) {
  const [phase, setPhase]         = useState('upload')   // upload|calibrate|log|summary
  const [corners, setCorners]     = useState([])
  const [pitches, setPitches]     = useState([])
  const [pendingType, setPendingType] = useState('Fastball')
  const [pendingResult, setPendingResult] = useState('Strike')
  const [pendingNote, setPendingNote] = useState('')
  const [lastPitch, setLastPitch] = useState(null)
  const [showSummary, setShowSummary] = useState(false)

  // ── Frame session (true frame-accurate via backend extraction) ────────────
  const [extracting,   setExtracting]   = useState(false)
  const [extractError, setExtractError] = useState(null)
  const [frameSession, setFrameSession] = useState(null)   // session_id string
  const [totalFrames,  setTotalFrames]  = useState(0)
  const [frameIdx,     setFrameIdx]     = useState(0)
  const [videoFps,     setVideoFps]     = useState(30)
  const [videoW,       setVideoW]       = useState(1280)
  const [videoH,       setVideoH]       = useState(720)

  const canvasRef  = useRef()
  const fileRef    = useRef()
  const animRef    = useRef()

  // Current frame URL — changes every time frameIdx changes
  const frameUrl = frameSession
    ? `${API}/video/frame/${frameSession}/${frameIdx}`
    : null

  // Frame navigation helpers
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
  const goFrame = useCallback((delta) => {
    setFrameIdx(i => clamp(i + delta, 0, totalFrames - 1))
  }, [totalFrames])

  const fmtFrame = (i) => i
  const fmtTime  = (i) => {
    const t = i / videoFps
    const m = Math.floor(t / 60)
    const s = (t % 60).toFixed(2).padStart(5, '0')
    return `${m}:${s}`
  }

  // ── Draw overlay ─────────────────────────────────────────────────────────────
  const drawOverlay = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !videoW || !videoH) return

    const W = canvas.width  = videoW
    const H = canvas.height = videoH
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, W, H)

    // Draw corners
    corners.forEach(([cx, cy], i) => {
      ctx.beginPath()
      ctx.arc(cx, cy, 10, 0, Math.PI * 2)
      ctx.fillStyle = CORNER_COLORS[i]
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.fillStyle = '#fff'
      ctx.font = 'bold 11px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(CORNERS[i][0], cx, cy + 4)
    })

    // Draw zone box when 4 corners set
    if (corners.length === 4) {
      ctx.beginPath()
      corners.forEach(([cx, cy], i) => i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy))
      ctx.closePath()
      ctx.strokeStyle = 'rgba(99,102,241,0.9)'
      ctx.lineWidth = 2
      ctx.setLineDash([8, 5])
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Draw already-logged pitches on this frame
    if (phase === 'log' && corners.length === 4) {
      pitches.forEach((p, i) => {
        // Reverse map norm coords back to canvas pixels
        const [tl, tr, br, bl] = corners
        const s = p.norm.x, t = p.norm.y
        const px = (1-s)*(1-t)*tl[0] + s*(1-t)*tr[0] + s*t*br[0] + (1-s)*t*bl[0]
        const py = (1-s)*(1-t)*tl[1] + s*(1-t)*tr[1] + s*t*br[1] + (1-s)*t*bl[1]
        const color = PITCH_COLORS[p.type] || '#9ca3af'
        ctx.beginPath()
        ctx.arc(px, py, 8, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.globalAlpha = 0.75
        ctx.fill()
        ctx.globalAlpha = 1
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 1.5
        ctx.stroke()
        ctx.fillStyle = '#fff'
        ctx.font = 'bold 9px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText(i + 1, px, py + 3)
      })
    }

    animRef.current = requestAnimationFrame(drawOverlay)
  }, [corners, pitches, phase, videoW, videoH])

  useEffect(() => {
    animRef.current = requestAnimationFrame(drawOverlay)
    return () => cancelAnimationFrame(animRef.current)
  }, [drawOverlay])

  // ── File upload → extract ALL frames on backend ───────────────────────────
  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setExtracting(true)
    setExtractError(null)
    setPhase('upload')   // stay on upload screen while extracting
    setCorners([])
    setPitches([])
    setFrameIdx(0)
    setFrameSession(null)

    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`${API}/video/extract-all`, { method: 'POST', body: fd })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data = await res.json()
      setFrameSession(data.session_id)
      setTotalFrames(data.frame_count)
      setVideoFps(data.fps || 30)
      setVideoW(data.width  || 1280)
      setVideoH(data.height || 720)
      setPhase('calibrate')
    } catch (err) {
      setExtractError(`Could not extract frames: ${err.message}`)
    } finally {
      setExtracting(false)
    }
  }

  // ── Handle tap on canvas ──────────────────────────────────────────────────────
  const handleTap = (e) => {
    e.preventDefault()
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width  / rect.width
    const scaleY = canvas.height / rect.height
    const raw = e.touches ? e.changedTouches[0] : e
    const x = (raw.clientX - rect.left)  * scaleX
    const y = (raw.clientY - rect.top)   * scaleY

    if (phase === 'calibrate') {
      if (corners.length < 4) {
        setCorners(prev => [...prev, [x, y]])
      }
    } else if (phase === 'log') {
      if (corners.length !== 4) return
      const norm = bilinearToNorm(x, y, corners)
      const { label, inZone } = describeLocation(norm.x, norm.y)
      const pitch = {
        id: Date.now(),
        type: pendingType,
        result: pendingResult,
        note: pendingNote,
        norm,
        location: label,
        inZone,
        number: pitches.length + 1,
      }
      setPitches(prev => [...prev, pitch])
      setLastPitch(pitch)
      setPendingNote('')
    }
  }

  // ── Undo last pitch ───────────────────────────────────────────────────────────
  const undoLast = () => {
    setPitches(prev => prev.slice(0, -1))
    setLastPitch(null)
  }

  // ── Summary stats ─────────────────────────────────────────────────────────────
  const stats = () => {
    if (!pitches.length) return null
    const strikes = pitches.filter(p =>
      ['Strike', 'Called Strike', 'Swinging Strike', 'Foul'].includes(p.result) || p.inZone
    ).length
    const byType = {}
    pitches.forEach(p => { byType[p.type] = (byType[p.type] || 0) + 1 })
    const zoneRate = Math.round((pitches.filter(p => p.inZone).length / pitches.length) * 100)
    return { strikes, zoneRate, byType, total: pitches.length }
  }

  // ── Upload screen ─────────────────────────────────────────────────────────────
  if (phase === 'upload') {
    return (
      <div className="space-y-4">
        <div className="bg-blue-900/20 border border-blue-700 rounded-2xl p-4 space-y-2">
          <p className="font-semibold text-blue-300 text-base">⚾ Bullpen Session Analysis</p>
          <p className="text-gray-300 text-sm">
            Upload a video recorded <strong className="text-white">behind the catcher</strong>. Mark the strike zone corners once, then tap where each pitch was caught to chart the full session.
          </p>
        </div>

        {extracting ? (
          <div className="border-2 border-indigo-700 bg-indigo-900/20 rounded-2xl p-8 text-center space-y-3">
            <div className="text-4xl animate-spin inline-block">⚙️</div>
            <p className="font-semibold text-indigo-300">Extracting frames…</p>
            <p className="text-gray-400 text-xs">Decoding every frame so you can scrub with perfect accuracy</p>
          </div>
        ) : extractError ? (
          <div className="border-2 border-red-700 bg-red-900/20 rounded-2xl p-6 text-center space-y-3">
            <p className="text-red-400 font-semibold">Upload failed</p>
            <p className="text-gray-400 text-xs">{extractError}</p>
            <label className="block cursor-pointer">
              <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={handleFile} />
              <span className="text-indigo-400 underline text-sm cursor-pointer">Try again</span>
            </label>
          </div>
        ) : (
          <label className="block cursor-pointer">
            <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={handleFile} />
            <div className="border-2 border-dashed border-blue-600 hover:border-blue-400 rounded-2xl p-8 text-center transition group">
              <div className="text-4xl mb-3">📹</div>
              <p className="font-semibold text-blue-400 group-hover:text-blue-300 text-base">Upload bullpen video</p>
              <p className="text-gray-500 text-xs mt-1">MP4, MOV, AVI — any length</p>
            </div>
          </label>
        )}

        <div className="bg-gray-800 rounded-xl p-4 text-xs space-y-1.5">
          <p className="text-gray-300 font-medium text-sm">How to film:</p>
          <p className="text-gray-400">📍 Camera on a tripod or stand, directly behind the catcher, slightly above catcher's head height</p>
          <p className="text-gray-400">🎯 The full strike zone should be visible — don't zoom in too tight</p>
          <p className="text-gray-400">📐 Keep the camera still — if it moves between pitches, re-calibrate the zone</p>
        </div>
      </div>
    )
  }

  const s = stats()

  // ── Summary screen ────────────────────────────────────────────────────────────
  if (showSummary && pitches.length > 0) {
    return (
      <div className="space-y-5 pb-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Session Summary</h2>
          <button className="text-xs text-gray-500 hover:text-gray-300" onClick={() => setShowSummary(false)}>
            ← Back
          </button>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-gray-800 rounded-xl p-3 text-center">
            <p className="text-2xl font-bold">{s.total}</p>
            <p className="text-gray-400 text-xs">Total Pitches</p>
          </div>
          <div className="bg-gray-800 rounded-xl p-3 text-center">
            <p className="text-2xl font-bold text-green-400">{s.zoneRate}%</p>
            <p className="text-gray-400 text-xs">Zone Rate</p>
          </div>
          <div className="bg-gray-800 rounded-xl p-3 text-center">
            <p className="text-2xl font-bold">{Object.keys(s.byType).length}</p>
            <p className="text-gray-400 text-xs">Pitch Types</p>
          </div>
        </div>

        {/* Zone chart */}
        <div className="bg-gray-800 rounded-2xl p-4">
          <p className="text-sm font-medium text-gray-300 mb-3">Pitch Locations</p>
          <div className="max-w-[240px] mx-auto">
            <ZoneChart pitches={pitches} width={240} height={280} />
          </div>
          {/* Legend */}
          <div className="flex flex-wrap gap-2 mt-3 justify-center">
            {Object.entries(s.byType).map(([type, count]) => (
              <div key={type} className="flex items-center gap-1.5 text-xs">
                <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: PITCH_COLORS[type] || '#9ca3af' }} />
                <span className="text-gray-300">{type} ({count})</span>
              </div>
            ))}
          </div>
        </div>

        {/* Pitch list */}
        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-300">Pitch Log</p>
          {pitches.map((p, i) => {
            const inZone = p.inZone
            return (
              <div key={p.id} className="flex items-center gap-3 bg-gray-800 rounded-xl px-4 py-3">
                <span className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                  style={{ backgroundColor: PITCH_COLORS[p.type] || '#9ca3af' }}>
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <span className="text-white text-sm font-medium">{p.type}</span>
                  <span className="text-gray-500 text-xs ml-2">{p.location}</span>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${inZone ? 'bg-green-900/60 text-green-300' : 'bg-red-900/60 text-red-300'}`}>
                  {inZone ? 'Strike' : 'Ball'}
                </span>
              </div>
            )
          })}
        </div>

        <div className="flex gap-2">
          <button
            className="flex-1 bg-indigo-600 hover:bg-indigo-500 rounded-xl py-3 font-semibold transition"
            onClick={() => { setPhase('upload'); setFrameSession(null); setCorners([]); setPitches([]); setShowSummary(false); setFrameIdx(0) }}
          >New Session</button>
        </div>
      </div>
    )
  }

  // ── Video + calibrate / log screen ────────────────────────────────────────────
  return (
    <div className="space-y-3 pb-6">

      {/* Phase header */}
      <div className={`rounded-xl p-3 border ${phase === 'calibrate' ? 'bg-yellow-900/20 border-yellow-700' : 'bg-indigo-900/20 border-indigo-700'}`}>
        {phase === 'calibrate' ? (
          <div>
            <p className="font-semibold text-yellow-300 text-sm">Step 1 — Set up the strike zone</p>
            <p className="text-gray-300 text-xs mt-0.5">
              Tap the <strong>{CORNERS[corners.length] || 'all 4'}</strong> corner{corners.length < 4 ? '' : 's done ✓'} of the strike zone in the video.
              Pause the video first on a frame where the zone is clearly visible.
            </p>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div>
              <p className="font-semibold text-indigo-300 text-sm">Step 2 — Mark each pitch</p>
              <p className="text-gray-400 text-xs">Scrub to when the catcher catches → tap the glove</p>
            </div>
            <span className="text-indigo-400 font-bold text-lg">{pitches.length}</span>
          </div>
        )}
      </div>

      {/* ── Frame viewer (true frame-accurate — images, not video) ── */}
      <div className="space-y-2">
        {/* Frame image + tap overlay */}
        <div className="relative bg-black rounded-xl overflow-hidden" style={{ aspectRatio: `${videoW}/${videoH}` }}>
          {frameUrl && (
            <img
              src={frameUrl}
              alt={`Frame ${frameIdx}`}
              className="w-full h-full object-contain"
              draggable={false}
            />
          )}
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full pointer-events-none"
          />
          {(phase === 'calibrate' || phase === 'log') && (
            <div
              className="absolute inset-0 cursor-crosshair"
              style={{ touchAction: 'none' }}
              onClick={handleTap}
              onTouchEnd={handleTap}
            />
          )}
        </div>

        {/* ── Frame-accurate controls ── */}
        <div className="bg-gray-900 rounded-xl border border-gray-700 p-3 space-y-2">

          {/* Frame counter + timestamp */}
          <div className="flex items-center justify-between text-xs">
            <span className="font-mono text-white tabular-nums">{fmtTime(frameIdx)}</span>
            <span className="text-gray-400">Frame <span className="text-white font-bold">{frameIdx + 1}</span> / {totalFrames}</span>
            <span className="font-mono text-gray-500 tabular-nums">{fmtTime(totalFrames - 1)}</span>
          </div>

          {/* Integer scrubber — steps exactly 1 frame per tick */}
          <input
            type="range"
            min={0}
            max={totalFrames - 1}
            step={1}
            value={frameIdx}
            onChange={e => setFrameIdx(+e.target.value)}
            className="w-full h-2 accent-indigo-500 cursor-pointer"
          />

          {/* Step buttons */}
          <div className="flex items-center justify-center gap-2">
            <button
              className="w-10 h-10 bg-gray-800 hover:bg-gray-700 active:bg-gray-600 rounded-lg text-white font-bold text-sm transition flex items-center justify-center"
              onClick={() => goFrame(-3)} title="-3 frames"
            >‹‹</button>
            <button
              className="w-10 h-10 bg-gray-800 hover:bg-gray-700 active:bg-gray-600 rounded-lg text-white font-bold text-lg transition flex items-center justify-center"
              onClick={() => goFrame(-1)} title="-1 frame"
            >‹</button>
            <span className="text-xs text-gray-600 w-20 text-center">‹/› = 1 frame</span>
            <button
              className="w-10 h-10 bg-gray-800 hover:bg-gray-700 active:bg-gray-600 rounded-lg text-white font-bold text-lg transition flex items-center justify-center"
              onClick={() => goFrame(1)} title="+1 frame"
            >›</button>
            <button
              className="w-10 h-10 bg-gray-800 hover:bg-gray-700 active:bg-gray-600 rounded-lg text-white font-bold text-sm transition flex items-center justify-center"
              onClick={() => goFrame(3)} title="+3 frames"
            >››</button>
          </div>
        </div>
      </div>

      {/* Corner progress (calibrate phase) */}
      {phase === 'calibrate' && (
        <div className="space-y-2">
          <div className="flex gap-1.5 flex-wrap">
            {CORNERS.map((label, i) => (
              <span key={i} className={`text-xs px-2.5 py-1 rounded-full transition ${
                i < corners.length ? 'bg-green-800 text-green-300' : 'bg-gray-700 text-gray-400'
              }`}>
                {i < corners.length ? '✓' : `${i+1}.`} {label}
              </span>
            ))}
          </div>

          {corners.length === 4 && (
            <button
              className="w-full bg-green-600 hover:bg-green-500 rounded-xl py-3 font-bold transition"
              onClick={() => setPhase('log')}
            >✓ Zone Set — Start Marking Pitches</button>
          )}

          {corners.length > 0 && (
            <button className="text-xs text-gray-500 hover:text-gray-300" onClick={() => setCorners([])}>
              ↩ Reset corners
            </button>
          )}
        </div>
      )}

      {/* Pitch logging controls */}
      {phase === 'log' && (
        <div className="space-y-3">
          {/* Pitch type selector */}
          <div>
            <p className="text-xs text-gray-400 mb-1.5">Pitch type for next tap:</p>
            <div className="flex flex-wrap gap-1.5">
              {PITCH_TYPES.map(t => (
                <button
                  key={t}
                  onClick={() => setPendingType(t)}
                  className={`px-3 py-1 rounded-full text-sm transition ${
                    pendingType === t
                      ? 'text-white font-medium'
                      : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                  }`}
                  style={pendingType === t ? { backgroundColor: PITCH_COLORS[t] || '#6366f1' } : {}}
                >{t}</button>
              ))}
            </div>
          </div>

          {/* Result selector */}
          <div>
            <p className="text-xs text-gray-400 mb-1.5">Result:</p>
            <div className="flex flex-wrap gap-1.5">
              {['Strike', 'Ball', 'Called Strike', 'Swinging Strike', 'Foul', 'Hit', 'HBP'].map(r => (
                <button
                  key={r}
                  onClick={() => setPendingResult(r)}
                  className={`px-2.5 py-1 rounded-full text-xs transition ${
                    pendingResult === r ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                  }`}
                >{r}</button>
              ))}
            </div>
          </div>

          {/* Last pitch feedback */}
          {lastPitch && (
            <div className={`rounded-xl px-4 py-2.5 flex items-center justify-between ${
              lastPitch.inZone ? 'bg-green-900/30 border border-green-800' : 'bg-gray-800 border border-gray-700'
            }`}>
              <div>
                <span className="text-white font-medium text-sm">#{lastPitch.number} {lastPitch.type}</span>
                <span className="text-gray-400 text-xs ml-2">{lastPitch.location}</span>
                <span className={`text-xs ml-2 ${lastPitch.inZone ? 'text-green-400' : 'text-gray-500'}`}>
                  {lastPitch.inZone ? '✓ Zone' : '✗ Ball'}
                </span>
              </div>
              <button className="text-xs text-gray-500 hover:text-red-400 transition" onClick={undoLast}>
                Undo
              </button>
            </div>
          )}

          {/* Zone preview */}
          {pitches.length > 0 && (
            <div className="bg-gray-800 rounded-xl p-3">
              <div className="flex items-start gap-3">
                <div className="w-24 flex-shrink-0">
                  <ZoneChart pitches={pitches} width={96} height={120} />
                </div>
                <div className="flex-1 min-w-0 pt-1">
                  <p className="text-xs text-gray-400">{pitches.length} pitch{pitches.length > 1 ? 'es' : ''} logged</p>
                  {s && <p className="text-sm font-medium text-white mt-0.5">{s.zoneRate}% zone rate</p>}
                  <div className="flex flex-wrap gap-1 mt-2">
                    {s && Object.entries(s.byType).map(([type, count]) => (
                      <span key={type} className="text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-300">
                        {type.slice(0,2).toUpperCase()} ×{count}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2">
            <button
              className="flex-1 bg-gray-700 hover:bg-gray-600 rounded-xl py-2.5 text-sm font-medium transition"
              onClick={() => { setPhase('calibrate'); setCorners([]) }}
            >Recalibrate Zone</button>
            {pitches.length > 0 && (
              <button
                className="flex-1 bg-indigo-600 hover:bg-indigo-500 rounded-xl py-2.5 text-sm font-bold transition"
                onClick={() => setShowSummary(true)}
              >Finish Session →</button>
            )}
          </div>

          <p className="text-xs text-gray-600 text-center">
            Scrub the video to the catch frame, then tap the glove location
          </p>
        </div>
      )}
    </div>
  )
}
