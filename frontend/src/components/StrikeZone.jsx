/**
 * StrikeZone
 * An interactive SVG strike zone. Clicking sets a coordinate.
 * Props:
 *   intended  – { x, y } normalized coords (-1 to 1), nullable
 *   actual    – { x, y } normalized coords (-1 to 1), nullable
 *   onPick    – (x, y) => void  — called on click (if interactive)
 *   mode      – "intended" | "actual" | "view"
 *   pitches   – array of pitch objects (for heat-map / multi-pitch view)
 *   showAllPitches – bool
 */
import React, { useRef } from 'react'

const W = 200   // SVG width
const H = 220   // SVG height
const ZX = 30   // zone left
const ZY = 30   // zone top
const ZW = 140  // zone width
const ZH = 150  // zone height

function norm2svg(x, y) {
  // x: -1=left, 1=right  →  ZX to ZX+ZW
  // y: -1=bottom, 1=top  →  ZY+ZH to ZY (SVG y is inverted)
  return {
    sx: ZX + ((x + 1) / 2) * ZW,
    sy: ZY + ((1 - y) / 2) * ZH,
  }
}

function svg2norm(sx, sy) {
  const x = ((sx - ZX) / ZW) * 2 - 1
  const y = 1 - ((sy - ZY) / ZH) * 2
  return { x: Math.max(-1.5, Math.min(1.5, x)), y: Math.max(-1.5, Math.min(1.5, y)) }
}

const PITCH_COLORS = {
  Fastball: '#ef4444',
  Curveball: '#3b82f6',
  Slider: '#f59e0b',
  Changeup: '#22c55e',
  Cutter: '#a855f7',
  Sinker: '#f97316',
  Splitter: '#06b6d4',
}

export default function StrikeZone({ intended, actual, onPick, mode = 'view', pitches = [], showAllPitches = false }) {
  const svgRef = useRef()

  const pickFromClient = (clientX, clientY) => {
    if (mode === 'view' && !showAllPitches) return
    if (!onPick) return
    const rect = svgRef.current.getBoundingClientRect()
    const sx = ((clientX - rect.left) / rect.width) * W
    const sy = ((clientY - rect.top)  / rect.height) * H
    const { x, y } = svg2norm(sx, sy)
    onPick(x, y)
  }

  const handleClick = (e) => pickFromClient(e.clientX, e.clientY)
  const handleTouch = (e) => {
    e.preventDefault()
    const t = e.changedTouches[0]
    pickFromClient(t.clientX, t.clientY)
  }

  const intentedSvg = intended ? norm2svg(intended.x, intended.y) : null
  const actualSvg = actual ? norm2svg(actual.x, actual.y) : null

  return (
    <div className="select-none">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ maxWidth: 340, cursor: onPick && mode !== 'view' ? 'crosshair' : 'default', touchAction: 'none' }}
        onClick={handleClick}
        onTouchEnd={handleTouch}
      >
        {/* Background */}
        <rect x={0} y={0} width={W} height={H} fill="#111827" rx={8} />

        {/* Plate */}
        <polygon
          points={`${ZX + ZW / 2},${ZY + ZH + 22} ${ZX + ZW / 2 - 14},${ZY + ZH + 10} ${ZX + ZW / 2 - 14},${ZY + ZH + 2} ${ZX + ZW / 2 + 14},${ZY + ZH + 2} ${ZX + ZW / 2 + 14},${ZY + ZH + 10}`}
          fill="#e5e7eb" stroke="#9ca3af" strokeWidth={1}
        />

        {/* Zone grid */}
        {[1 / 3, 2 / 3].map((t, i) => (
          <g key={i}>
            <line x1={ZX + ZW * t} y1={ZY} x2={ZX + ZW * t} y2={ZY + ZH} stroke="#374151" strokeWidth={1} />
            <line x1={ZX} y1={ZY + ZH * t} x2={ZX + ZW} y2={ZY + ZH * t} stroke="#374151" strokeWidth={1} />
          </g>
        ))}

        {/* Strike zone border */}
        <rect x={ZX} y={ZY} width={ZW} height={ZH} fill="none" stroke="#6b7280" strokeWidth={2} rx={2} />

        {/* Shadow zone (balls just outside) */}
        <rect x={ZX - 10} y={ZY - 10} width={ZW + 20} height={ZH + 20}
          fill="none" stroke="#374151" strokeWidth={1} strokeDasharray="4 3" rx={4} />

        {/* All pitches (heat map dots) */}
        {showAllPitches && pitches.map((p, i) => {
          const { sx, sy } = norm2svg(p.actual_x, p.actual_y)
          const color = PITCH_COLORS[p.pitch_type] || '#9ca3af'
          return (
            <g key={i}>
              <circle cx={sx} cy={sy} r={6} fill={color} fillOpacity={0.7} stroke="#111827" strokeWidth={1} />
              <text x={sx} y={sy + 1} textAnchor="middle" dominantBaseline="middle"
                fontSize={7} fill="white" fontWeight="bold">
                {i + 1}
              </text>
            </g>
          )
        })}

        {/* Intended spot */}
        {intentedSvg && (
          <g>
            <circle cx={intentedSvg.sx} cy={intentedSvg.sy} r={9}
              fill="none" stroke="#22c55e" strokeWidth={2} strokeDasharray="3 2" />
            <text x={intentedSvg.sx - 14} y={intentedSvg.sy - 12}
              fontSize={9} fill="#22c55e">Target</text>
          </g>
        )}

        {/* Arrow from intended to actual */}
        {intentedSvg && actualSvg && (
          <line
            x1={intentedSvg.sx} y1={intentedSvg.sy}
            x2={actualSvg.sx} y2={actualSvg.sy}
            stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="3 2"
            markerEnd="url(#arrow)"
          />
        )}

        {/* Actual pitch */}
        {actualSvg && (
          <g>
            <circle cx={actualSvg.sx} cy={actualSvg.sy} r={8}
              fill="#ef4444" fillOpacity={0.85} stroke="white" strokeWidth={1.5} />
            <text x={actualSvg.sx} y={actualSvg.sy + 1}
              textAnchor="middle" dominantBaseline="middle"
              fontSize={9} fill="white" fontWeight="bold">●</text>
          </g>
        )}

        <defs>
          <marker id="arrow" markerWidth={6} markerHeight={6} refX={3} refY={3} orient="auto">
            <path d="M0,0 L0,6 L6,3 z" fill="#f59e0b" />
          </marker>
        </defs>

        {/* Labels */}
        <text x={ZX - 2} y={ZY - 4} fontSize={8} fill="#6b7280">High</text>
        <text x={ZX - 2} y={ZY + ZH + 8} fontSize={8} fill="#6b7280">Low</text>
        <text x={ZX + 2} y={ZY + ZH / 2} fontSize={7} fill="#6b7280" writingMode="vertical-lr">L</text>
        <text x={ZX + ZW - 4} y={ZY + ZH / 2} fontSize={7} fill="#6b7280" writingMode="vertical-lr">R</text>
      </svg>

      {mode !== 'view' && onPick && (
        <p className="text-xs text-gray-500 text-center mt-1">
          Click the zone to set the {mode === 'intended' ? 'target location' : 'actual pitch location'}
        </p>
      )}

      {/* Legend */}
      {showAllPitches && pitches.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2 justify-center">
          {[...new Set(pitches.map(p => p.pitch_type))].map(pt => (
            <span key={pt} className="flex items-center gap-1 text-xs text-gray-400">
              <span className="w-3 h-3 rounded-full inline-block"
                style={{ background: PITCH_COLORS[pt] || '#9ca3af' }} />
              {pt}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
