/**
 * TrackManSummary — shows TrackMan stats (spin rate, break) from
 * the pitches already logged in the current outing.
 * Replaces the standalone TrackManAnalyzer tab.
 */
import React, { useState, useEffect } from 'react'
import axios from 'axios'

const API = '/api'

const PITCH_COLORS = {
  Fastball: '#ef4444', Curveball: '#3b82f6', Slider: '#f59e0b',
  Changeup: '#22c55e', Cutter: '#a855f7', Sinker: '#f97316',
  'Two-Seam': '#ec4899', Splitter: '#06b6d4',
}

export default function TrackManSummary({ outingId }) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!outingId) return
    setLoading(true)
    axios.get(`${API}/outing/${outingId}`)
      .then(r => { setData(r.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [outingId])

  if (!outingId) return (
    <div className="text-center text-gray-500 py-8 text-sm">Start an outing to see TrackMan data.</div>
  )
  if (loading) return <div className="text-center text-gray-400 py-8">Loading…</div>

  const pitches = data?.pitches || []
  const withTM  = pitches.filter(p => p.spin_rate || p.break_h != null || p.break_v != null)

  if (withTM.length === 0) {
    return (
      <div className="space-y-3 py-4">
        <p className="text-sm text-gray-400 text-center">
          No TrackMan data in this outing yet.
        </p>
        <p className="text-xs text-gray-600 text-center">
          Expand "📡 TrackMan data (optional)" when logging a pitch to add spin rate and break values.
        </p>
      </div>
    )
  }

  // Aggregate by pitch type
  const byType = {}
  for (const p of withTM) {
    const pt = p.pitch_type || 'Other'
    if (!byType[pt]) byType[pt] = { count: 0, spins: [], hs: [], vs: [] }
    if (p.spin_rate) byType[pt].spins.push(p.spin_rate)
    if (p.break_h != null) byType[pt].hs.push(p.break_h)
    if (p.break_v != null) byType[pt].vs.push(p.break_v)
    byType[pt].count++
  }
  const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">
        TrackMan data from {withTM.length} of {pitches.length} pitches this outing.
      </p>

      <div className="space-y-2">
        {Object.entries(byType).map(([pt, d]) => {
          const avgSpin = avg(d.spins)
          const avgH    = avg(d.hs)
          const avgV    = avg(d.vs)
          return (
            <div key={pt} className="bg-gray-800 rounded-xl p-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full"
                  style={{ background: PITCH_COLORS[pt] || '#6b7280' }} />
                <span className="font-medium text-sm">{pt}</span>
                <span className="text-xs text-gray-500 ml-1">{d.count} pitches</span>
              </div>
              <div className="grid grid-cols-3 gap-2 ml-4">
                {avgSpin !== null && (
                  <div className="bg-gray-900 rounded-lg p-2 text-center">
                    <div className="text-base font-bold text-indigo-300">{Math.round(avgSpin)}</div>
                    <div className="text-xs text-gray-500 mt-0.5">rpm</div>
                  </div>
                )}
                {avgH !== null && (
                  <div className="bg-gray-900 rounded-lg p-2 text-center">
                    <div className="text-base font-bold text-blue-300">{avgH.toFixed(1)}"</div>
                    <div className="text-xs text-gray-500 mt-0.5">H-Break</div>
                  </div>
                )}
                {avgV !== null && (
                  <div className="bg-gray-900 rounded-lg p-2 text-center">
                    <div className="text-base font-bold text-green-300">{avgV.toFixed(1)}"</div>
                    <div className="text-xs text-gray-500 mt-0.5">V-Break</div>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
