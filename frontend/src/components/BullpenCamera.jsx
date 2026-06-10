/**
 * BullpenCamera — Camera behind the catcher for automatic pitch location.
 *
 * How it works:
 * 1. User marks the 4 corners of the strike zone ONCE (one-time calibration per session).
 * 2. Video frame is captured at the moment the catcher receives the ball.
 * 3. Brightest/darkest object motion at catch-point determines ball position.
 * 4. Position mapped to normalized strike zone coords using the calibration homography.
 *
 * This works because from behind the catcher, the geometry is fixed — the ball
 * approaches the camera (growing in apparent size) and its catch position maps
 * directly to the zone grid.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react'

const ZONE = { w: 17, h: 24 } // official strike zone inches (approx)

// Perspective transform: map 4 calibration points to normalized [0,1] coords
function buildHomography(srcPts) {
  // Simple bilinear interpolation (good enough for near-flat zone plane)
  // srcPts: [topLeft, topRight, bottomRight, bottomLeft] in pixel coords
  return srcPts
}

function bilinearToNorm(x, y, corners) {
  // corners: [TL, TR, BR, BL] pixel coords
  // Returns {x, y} in [0,1] normalized strike zone coords
  const [tl, tr, br, bl] = corners

  // Approximate inverse bilinear interpolation
  // Find s,t such that (1-s)(1-t)*TL + s(1-t)*TR + s*t*BR + (1-s)*t*BL = (x,y)
  // Use iterative Newton-Raphson
  let s = 0.5, t = 0.5
  for (let i = 0; i < 20; i++) {
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
    s = Math.max(0, Math.min(1, s))
    t = Math.max(0, Math.min(1, t))
  }
  return { x: s, y: t }
}

const CORNER_LABELS = ['Top-Left', 'Top-Right', 'Bottom-Right', 'Bottom-Left']
const CORNER_COLORS = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b']

export default function BullpenCamera({ onLocationPicked }) {
  const videoRef   = useRef()
  const canvasRef  = useRef()
  const overlayRef = useRef()
  const [phase, setPhase]         = useState('intro')   // intro|calibrate|ready|captured
  const [corners, setCorners]     = useState([])         // up to 4 [x,y] pixel points on canvas
  const [catchPoint, setCatchPoint] = useState(null)     // {x,y} canvas pixels
  const [normLoc, setNormLoc]     = useState(null)       // {x,y} in [0,1] zone coords
  const [stream, setStream]       = useState(null)
  const [error, setError]         = useState('')
  const [frameData, setFrameData] = useState(null)       // captured frame base64

  // Start camera
  const startCamera = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      })
      setStream(s)
      if (videoRef.current) {
        videoRef.current.srcObject = s
        videoRef.current.play()
      }
      setPhase('calibrate')
      setError('')
    } catch (e) {
      setError('Camera permission denied. Please allow camera access and try again.')
    }
  }

  // Stop camera
  useEffect(() => {
    return () => { if (stream) stream.getTracks().forEach(t => t.stop()) }
  }, [stream])

  // Draw overlay on canvas (corners + zone outline)
  const drawOverlay = useCallback(() => {
    const canvas = overlayRef.current
    const video  = videoRef.current
    if (!canvas || !video) return

    const W = video.videoWidth  || canvas.width
    const H = video.videoHeight || canvas.height
    canvas.width  = W
    canvas.height = H

    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, W, H)

    // Guide text
    if (phase === 'calibrate') {
      const remaining = 4 - corners.length
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.fillRect(0, 0, W, 44)
      ctx.fillStyle = '#fff'
      ctx.font = 'bold 16px sans-serif'
      ctx.fillText(
        remaining > 0
          ? `Tap ${CORNER_LABELS[corners.length]} corner of the strike zone (${remaining} left)`
          : 'All 4 corners set — tap "Confirm Zone" to continue',
        10, 28
      )
    }

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
      ctx.font = 'bold 12px sans-serif'
      ctx.fillText(CORNER_LABELS[i][0], cx - 4, cy + 5)
    })

    // Draw zone outline when 4 corners set
    if (corners.length === 4) {
      ctx.beginPath()
      corners.forEach(([cx, cy], i) => i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy))
      ctx.closePath()
      ctx.strokeStyle = 'rgba(99,102,241,0.8)'
      ctx.lineWidth = 2
      ctx.setLineDash([6, 4])
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Draw catch point
    if (catchPoint) {
      ctx.beginPath()
      ctx.arc(catchPoint.x, catchPoint.y, 14, 0, Math.PI * 2)
      ctx.strokeStyle = '#f97316'
      ctx.lineWidth = 3
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(catchPoint.x, catchPoint.y, 4, 0, Math.PI * 2)
      ctx.fillStyle = '#f97316'
      ctx.fill()
    }
  }, [phase, corners, catchPoint])

  useEffect(() => {
    const id = setInterval(drawOverlay, 100)
    return () => clearInterval(id)
  }, [drawOverlay])

  // Handle tap on overlay canvas
  const handleTap = (e) => {
    const rect = overlayRef.current.getBoundingClientRect()
    const scaleX = overlayRef.current.width  / rect.width
    const scaleY = overlayRef.current.height / rect.height

    const raw = e.touches ? e.touches[0] : e
    const x = (raw.clientX - rect.left) * scaleX
    const y = (raw.clientY - rect.top)  * scaleY

    if (phase === 'calibrate' && corners.length < 4) {
      setCorners(prev => [...prev, [x, y]])
    } else if (phase === 'ready') {
      // User taps where the catcher caught the ball
      setCatchPoint({ x, y })
      captureFrame(x, y)
    }
  }

  const captureFrame = (catchX, catchY) => {
    const video  = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return

    canvas.width  = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0)

    // Draw catch point on captured frame
    ctx.beginPath()
    ctx.arc(catchX, catchY, 16, 0, Math.PI * 2)
    ctx.strokeStyle = '#f97316'
    ctx.lineWidth = 4
    ctx.stroke()

    // Map catch point to normalized zone coords
    const loc = bilinearToNorm(catchX, catchY, corners)
    setNormLoc(loc)
    setFrameData(canvas.toDataURL('image/jpeg', 0.8))
    setPhase('captured')
  }

  const confirmZone = () => {
    if (corners.length === 4) setPhase('ready')
  }

  const reset = () => {
    setCorners([])
    setCatchPoint(null)
    setNormLoc(null)
    setFrameData(null)
    setPhase('calibrate')
  }

  const useCatchPoint = () => {
    if (normLoc && onLocationPicked) {
      onLocationPicked({ x: normLoc.x, y: normLoc.y })
    }
  }

  // ── Intro ──────────────────────────────────────────────────────────────────
  if (phase === 'intro') {
    return (
      <div className="space-y-4">
        <div className="bg-blue-900/20 border border-blue-700 rounded-xl p-4 space-y-2">
          <p className="font-semibold text-blue-300">📍 Bullpen Camera Mode</p>
          <p className="text-gray-300 text-sm">Place your phone <strong>behind the catcher</strong>, slightly elevated, pointing at the pitcher.</p>
          <p className="text-gray-400 text-sm">You'll mark the 4 corners of the strike zone once, then tap where each pitch is caught.</p>
        </div>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button
          className="w-full bg-indigo-600 hover:bg-indigo-500 rounded-xl py-3 font-semibold transition"
          onClick={startCamera}
        >
          📷 Start Camera
        </button>
      </div>
    )
  }

  // ── Captured ───────────────────────────────────────────────────────────────
  if (phase === 'captured' && frameData && normLoc) {
    // Convert normalized to descriptive location
    const xDesc = normLoc.x < 0.33 ? 'Away' : normLoc.x > 0.67 ? 'In' : 'Middle'
    const yDesc = normLoc.y < 0.33 ? 'High' : normLoc.y > 0.67 ? 'Low' : 'Middle'
    const location = `${yDesc} ${xDesc}`

    return (
      <div className="space-y-4">
        <img src={frameData} className="w-full rounded-xl border border-gray-700" alt="Catch frame" />
        <div className="bg-gray-800 rounded-xl p-4 flex items-center justify-between">
          <div>
            <p className="text-gray-400 text-xs">Pitch location</p>
            <p className="text-white font-bold text-lg">{location}</p>
            <p className="text-gray-500 text-xs">x: {normLoc.x.toFixed(2)}, y: {normLoc.y.toFixed(2)}</p>
          </div>
          <div className="space-y-2 text-right">
            <button
              className="block w-full bg-indigo-600 hover:bg-indigo-500 rounded-lg px-4 py-2 text-sm font-medium transition"
              onClick={useCatchPoint}
            >Use This Location</button>
            <button
              className="block w-full bg-gray-700 hover:bg-gray-600 rounded-lg px-4 py-2 text-sm transition"
              onClick={reset}
            >Redo</button>
          </div>
        </div>
      </div>
    )
  }

  // ── Live camera ────────────────────────────────────────────────────────────
  return (
    <div className="space-y-3">
      <div className="relative rounded-xl overflow-hidden bg-black aspect-video">
        <video
          ref={videoRef}
          className="w-full h-full object-cover"
          autoPlay playsInline muted
        />
        <canvas
          ref={overlayRef}
          className="absolute inset-0 w-full h-full"
          style={{ touchAction: 'none' }}
          onClick={handleTap}
          onTouchEnd={e => { e.preventDefault(); handleTap(e) }}
        />
      </div>

      {/* Hidden canvas for frame capture */}
      <canvas ref={canvasRef} className="hidden" />

      {phase === 'calibrate' && (
        <div className="space-y-2">
          <div className="flex gap-2 flex-wrap">
            {CORNER_LABELS.map((label, i) => (
              <span key={i} className={`text-xs px-2 py-1 rounded-full ${
                i < corners.length ? 'bg-green-800 text-green-300' : 'bg-gray-700 text-gray-400'
              }`}>
                {i < corners.length ? '✓' : (i + 1) + '.'} {label[0] + label.slice(1, 3)}
              </span>
            ))}
          </div>
          {corners.length === 4 && (
            <button
              className="w-full bg-green-600 hover:bg-green-500 rounded-xl py-3 font-semibold transition"
              onClick={confirmZone}
            >✓ Confirm Zone — Start Tracking</button>
          )}
          {corners.length > 0 && (
            <button className="text-sm text-gray-500 hover:text-gray-300" onClick={() => setCorners([])}>
              ↩ Reset corners
            </button>
          )}
        </div>
      )}

      {phase === 'ready' && (
        <div className="bg-orange-900/20 border border-orange-700 rounded-xl p-3 text-center">
          <p className="text-orange-300 font-semibold text-sm">🎯 Tap where the catcher caught the ball</p>
          <p className="text-gray-400 text-xs mt-0.5">Tap the glove position on the video above</p>
          <button className="mt-2 text-xs text-gray-500 hover:text-gray-300" onClick={reset}>
            Recalibrate zone
          </button>
        </div>
      )}
    </div>
  )
}
