/**
 * TrendView — multi-outing command trend analysis.
 * Shows avg miss distance per outing as an SVG line chart,
 * with per-pitch-type breakdown and improvement summary.
 */
import React, { useState, useEffect } from 'react'
import axios from 'axios'

const API = '/api'

const PITCH_COLORS = {
  Fastball: '#ef4444', Curveball: '#3b82f6', Slider: '#f59e0b',
  Changeup: '#22c55e', Cutter: '#a855f7', Sinker: '#f97316',
  'Two-Seam': '#ec4899', Splitter: '#06b6d4',
}

const TYPE_SHORT = {
  Fastball: 'FB', 'Two-Seam': '2S', Cutter: 'CT', Slider: 'SL',
  Curveball: 'CB', Changeup: 'CH', Sinker: 'SI', Splitter: 'SP', Other: '?',
}

// Chart layout constants
const CW = 340, CH = 150   // chart area
const PL = 38, PR = 12, PT = 12, PB = 32  // padding
const SVG_W = CW + PL + PR
const SVG_H = CH + PT + PB
const MAX_MISS = 12   // cap Y axis at 12 inches
const GRID_LINES = [2, 4, 6, 8, 10]

function toX(i, n) {
  if (n <= 1) return PL + CW / 2
  return PL + (i / (n - 1)) * CW
}
function toY(inches) {
  const clamped = Math.min(inches, MAX_MISS)
  return PT + CH - (clamped / MAX_MISS) * CH
}

export default function TrendView({ onBack }) {
  const [trends, setTrends]   = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [pitcher, setPitcher] = useState('All')

  useEffect(() => {
    axios.get(`${API}/outings/trends`)
      .then(r => { setTrends(r.data.trends || []); setLoading(false) })
      .catch(() => { setError('Could not load trend data.'); setLoading(false) })
  }, [])

  const pitchers = ['All', ...new Set(trends.map(t => t.pitcher_name))]
  const filtered = pitcher === 'All' ? trends : trends.filter(t => t.pitcher_name === pitcher)

  // Compute aggregate stats for selected set
  const avgAll = filtered.length
    ? filtered.reduce((s, t) => s + t.avg_miss_inches, 0) / filtered.length
    : 0
  const first3 = filtered.slice(0, Math.ceil(filtered.length / 2))
  const last3  = filtered.slice(Math.floor(filtered.length / 2))
  const firstAvg = first3.length ? first3.reduce((s, t) => s + t.avg_miss_inches, 0) / first3.length : null
  const lastAvg  = last3.length  ? last3.reduce((s, t) => s + t.avg_miss_inches, 0) / last3.length  : null
  const improving = firstAvg !== null && lastAvg !== null && lastAvg < firstAvg - 0.5

  // Aggregate by-type stats across filtered outings
  const typeAgg = {}
  for (const t of filtered) {
    for (const [pt, data] of Object.entries(t.by_type || {})) {
      if (!typeAgg[pt]) typeAgg[pt] = { count: 0, miss_total: 0 }
      typeAgg[pt].count      += data.count
      typeAgg[pt].miss_total += data.avg_miss_inches * data.count
    }
  }
  const typeRows = Object.entries(typeAgg)
    .map(([pt, d]) => ({ pt, count: d.count, avg: d.miss_total / d.count }))
    .sort((a, b) => a.avg - b.avg)   // best command first

  // SVG path for the trend line
  const linePath = filtered.length > 1
    ? filtered.map((t, i) =>
        `${i === 0 ? 'M' : 'L'} ${toX(i, filtered.length).toFixed(1)} ${toY(t.avg_miss_inches).toFixed(1)}`
      ).join(' ')
    : null

  if (loading) return <div className="text-center text-gray-400 py-12">Loading trends…</div>
  if (error)   return <div className="text-red-400 py-4">{error}</div>

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">📈 Trend Analysis</h2>
          <p className="text-xs text-gray-400 mt-0.5">Command over time</p>
        </div>
        <button onClick={onBack} className="text-sm text-gray-400 hover:text-white">← Back</button>
      </div>

      {/* Pitcher filter */}
      {pitchers.length > 2 && (
        <div className="flex gap-1.5 flex-wrap">
          {pitchers.map(p => (
            <button key={p} onClick={() => setPitcher(p)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition ${
                pitcher === p ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
              }`}>{p}</button>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="text-center text-gray-500 py-10">
          No outings with pitches logged yet.
        </div>
      ) : (
        <>
          {/* Summary chips */}
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-gray-800 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-indigo-400">{filtered.length}</div>
              <div className="text-xs text-gray-400 mt-0.5">Outings</div>
            </div>
            <div className="bg-gray-800 rounded-xl p-3 text-center">
              <div className={`text-2xl font-bold ${avgAll < 4 ? 'text-green-400' : avgAll < 7 ? 'text-yellow-400' : 'text-red-400'}`}>
                {avgAll.toFixed(1)}"
              </div>
              <div className="text-xs text-gray-400 mt-0.5">Avg Miss</div>
            </div>
            <div className="bg-gray-800 rounded-xl p-3 text-center">
              {improving ? (
                <>
                  <div className="text-2xl font-bold text-green-400">↓ {(firstAvg - lastAvg).toFixed(1)}"</div>
                  <div className="text-xs text-green-500 mt-0.5">Improving</div>
                </>
              ) : firstAvg !== null && lastAvg > firstAvg + 0.5 ? (
                <>
                  <div className="text-2xl font-bold text-red-400">↑ {(lastAvg - firstAvg).toFixed(1)}"</div>
                  <div className="text-xs text-red-500 mt-0.5">Regressing</div>
                </>
              ) : (
                <>
                  <div className="text-2xl font-bold text-gray-400">—</div>
                  <div className="text-xs text-gray-500 mt-0.5">Stable</div>
                </>
              )}
            </div>
          </div>

          {/* SVG Chart */}
          <div className="bg-gray-900 rounded-2xl p-3 border border-gray-800">
            <p className="text-xs text-gray-500 mb-2">Avg command miss per outing (inches, lower = better)</p>
            <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="w-full" style={{ maxHeight: 200 }}>
              {/* Y grid lines */}
              {GRID_LINES.map(g => (
                <g key={g}>
                  <line
                    x1={PL} y1={toY(g)} x2={PL + CW} y2={toY(g)}
                    stroke="#1e293b" strokeWidth="1"
                  />
                  <text x={PL - 4} y={toY(g) + 4} textAnchor="end" fontSize="8" fill="#475569">
                    {g}"
                  </text>
                </g>
              ))}

              {/* X axis */}
              <line x1={PL} y1={PT + CH} x2={PL + CW} y2={PT + CH} stroke="#334155" strokeWidth="1" />

              {/* Trend line */}
              {linePath && (
                <path d={linePath} fill="none" stroke="#6366f1" strokeWidth="2" strokeLinejoin="round" />
              )}

              {/* Dots + X labels */}
              {filtered.map((t, i) => {
                const x = toX(i, filtered.length)
                const y = toY(t.avg_miss_inches)
                const isGame = t.outing_type === 'game'
                const dateStr = t.created_at ? t.created_at.slice(5, 10) : `#${i + 1}`
                return (
                  <g key={t.outing_id}>
                    <circle
                      cx={x} cy={y} r={5}
                      fill={isGame ? '#f59e0b' : '#6366f1'}
                      stroke="#0f172a" strokeWidth="1.5"
                    />
                    {/* Value label above dot */}
                    <text x={x} y={y - 8} textAnchor="middle" fontSize="8" fill="#94a3b8">
                      {t.avg_miss_inches}"
                    </text>
                    {/* X date label */}
                    <text x={x} y={PT + CH + 14} textAnchor="middle" fontSize="7" fill="#475569">
                      {dateStr}
                    </text>
                    {/* G/B label */}
                    <text x={x} y={PT + CH + 24} textAnchor="middle" fontSize="7"
                      fill={isGame ? '#f59e0b' : '#818cf8'}>
                      {isGame ? 'G' : 'B'}
                    </text>
                  </g>
                )
              })}
            </svg>
            {/* Legend */}
            <div className="flex gap-4 mt-1 text-xs text-gray-500 justify-center">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-indigo-500 inline-block" /> Bullpen
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" /> Game
              </span>
            </div>
          </div>

          {/* Per-pitch-type breakdown */}
          {typeRows.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-300 mb-2">Command by Pitch Type</h3>
              <div className="space-y-2">
                {typeRows.map(({ pt, count, avg }) => (
                  <div key={pt} className="bg-gray-800 rounded-xl px-3 py-2.5 flex items-center gap-3">
                    <span
                      className="w-7 text-center text-xs font-bold rounded-full py-0.5"
                      style={{ background: PITCH_COLORS[pt] || '#6b7280', color: '#fff' }}
                    >
                      {TYPE_SHORT[pt] || pt.slice(0, 2)}
                    </span>
                    <span className="flex-1 text-sm font-medium">{pt}</span>
                    <span className="text-xs text-gray-400">{count} pitches</span>
                    <span className={`text-sm font-bold ${avg < 3 ? 'text-green-400' : avg < 6 ? 'text-yellow-400' : 'text-red-400'}`}>
                      {avg.toFixed(1)}"
                    </span>
                    {/* Mini bar */}
                    <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.min(avg / MAX_MISS * 100, 100)}%`,
                          background: avg < 3 ? '#22c55e' : avg < 6 ? '#f59e0b' : '#ef4444',
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Outing list */}
          <div>
            <h3 className="text-sm font-semibold text-gray-300 mb-2">Outing Log</h3>
            <div className="space-y-1.5">
              {[...filtered].reverse().map((t, i) => (
                <div key={t.outing_id} className="bg-gray-800 rounded-xl px-3 py-2.5 flex items-center gap-3">
                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                    t.outing_type === 'game' ? 'bg-amber-900/60 text-amber-300' : 'bg-indigo-900/60 text-indigo-300'
                  }`}>
                    {t.outing_type === 'game' ? 'Game' : 'Pen'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{t.pitcher_name}</span>
                    {t.opponent && <span className="text-xs text-gray-500 ml-1.5">vs {t.opponent}</span>}
                    <span className="text-xs text-gray-500 ml-1.5">
                      {t.created_at ? new Date(t.created_at + 'Z').toLocaleDateString() : ''}
                    </span>
                  </div>
                  <span className="text-xs text-gray-500">{t.total_pitches} pitch{t.total_pitches !== 1 ? 'es' : ''}</span>
                  <span className={`text-sm font-bold ${
                    t.avg_miss_inches < 3 ? 'text-green-400' : t.avg_miss_inches < 6 ? 'text-yellow-400' : 'text-red-400'
                  }`}>{t.avg_miss_inches}"</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
