/**
 * OutingSummary
 * Fetches and displays an outing's pitch stats, miss analysis, and heatmap.
 * Includes count sequencing, delete pitch, and inline edit.
 */
import React, { useState, useEffect } from 'react'
import axios from 'axios'
import StrikeZone from './StrikeZone'

const API = '/api'

const PITCH_COLORS = {
  Fastball: '#ef4444', Curveball: '#3b82f6', Slider: '#f59e0b',
  Changeup: '#22c55e', Cutter: '#a855f7', Sinker: '#f97316',
  Splitter: '#06b6d4', 'Two-Seam': '#ec4899',
}
const PITCH_TYPES = ['Fastball', 'Two-Seam', 'Cutter', 'Slider', 'Curveball', 'Changeup', 'Sinker', 'Splitter']
const RESULTS     = ['Strike', 'Called Strike', 'Swinging Strike', 'Ball', 'Foul', 'Hit', 'Out', 'HBP']

// Count importance labels for sequencing display
const COUNT_LABELS = {
  '0-2': 'Putaway', '1-2': 'Two-strike', '2-2': 'Two-strike', '3-2': 'Full',
  '3-0': "Hitter's", '3-1': "Hitter's", '2-0': "Hitter's", '0-0': 'First pitch',
}

function resultColor(result) {
  if (['Strike', 'Swinging Strike', 'Called Strike'].includes(result)) return 'bg-green-900 text-green-300'
  if (result === 'Ball') return 'bg-red-900 text-red-300'
  return 'bg-gray-700 text-gray-300'
}

export default function OutingSummary({ outingId, onBack }) {
  const [summary,       setSummary]       = useState(null)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState('')
  const [selectedPitch, setSelectedPitch] = useState(null)
  const [editingId,     setEditingId]     = useState(null)  // pitch.id being edited
  const [editForm,      setEditForm]      = useState({})
  const [saving,        setSaving]        = useState(false)
  const [deleting,      setDeleting]      = useState(null)  // pitch.id being deleted

  const fetchSummary = async () => {
    setLoading(true)
    try {
      const res = await axios.get(`${API}/outing/${outingId}/summary`)
      setSummary(res.data)
      setSelectedPitch(null)
    } catch {
      setError('Could not load summary.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchSummary() }, [outingId])

  const startEdit = (p, e) => {
    e.stopPropagation()
    setEditingId(p.id)
    setEditForm({ pitch_type: p.pitch_type, result: p.result, notes: p.notes || '', velocity: p.velocity || '' })
  }

  const saveEdit = async (pitchId) => {
    setSaving(true)
    try {
      await axios.patch(`${API}/pitch/${pitchId}`, {
        pitch_type: editForm.pitch_type,
        result:     editForm.result,
        notes:      editForm.notes || null,
        velocity:   editForm.velocity ? parseFloat(editForm.velocity) : null,
      })
      setEditingId(null)
      fetchSummary()
    } catch { alert('Could not save edit.') }
    finally { setSaving(false) }
  }

  const deletePitch = async (pitchId, e) => {
    e.stopPropagation()
    if (!window.confirm('Delete this pitch?')) return
    setDeleting(pitchId)
    try {
      await axios.delete(`${API}/pitch/${pitchId}`)
      fetchSummary()
    } catch { alert('Could not delete pitch.') }
    finally { setDeleting(null) }
  }

  if (loading) return <div className="text-center text-gray-400 py-8">Loading summary...</div>
  if (error)   return <div className="text-red-400 py-4">{error}</div>
  if (!summary) return null

  const pitches = summary.pitches || []
  const selected = selectedPitch !== null ? pitches[selectedPitch] : null

  // ── Count sequencing ─────────────────────────────────────────────────────
  const countGroups = {}
  for (const p of pitches) {
    const key = `${p.balls ?? 0}-${p.strikes ?? 0}`
    if (!countGroups[key]) countGroups[key] = []
    countGroups[key].push(p)
  }
  const sortedCounts = Object.keys(countGroups).sort((a, b) => {
    const [ab, as] = a.split('-').map(Number)
    const [bb, bs] = b.split('-').map(Number)
    return as !== bs ? bs - as : ab - bb  // two-strike counts first, then balls descending
  })

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">{summary.pitcher_name}</h2>
          <p className="text-sm text-gray-400">
            Outing Summary
            {summary.outing_type && (
              <span className={`ml-2 text-xs font-medium ${summary.outing_type === 'game' ? 'text-amber-400' : 'text-indigo-400'}`}>
                {summary.outing_type === 'game' ? '⚾ Game' : '🎯 Bullpen'}
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <button
            onClick={async () => {
              try {
                const res = await axios.get(`${API}/outing/${outingId}/pdf`, { responseType: 'blob' })
                const url = URL.createObjectURL(res.data)
                const a = document.createElement('a')
                a.href = url
                a.download = `outing_${outingId}.pdf`
                a.click()
                URL.revokeObjectURL(url)
              } catch { alert('Could not export PDF') }
            }}
            className="px-3 py-1.5 bg-green-700 hover:bg-green-600 rounded-lg text-xs font-semibold text-white transition"
          >
            📄 PDF
          </button>
          <button onClick={onBack} className="text-sm text-gray-400 hover:text-white">← Back</button>
        </div>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Pitches',  value: summary.total_pitches },
          { label: 'Strike%',  value: `${summary.strike_percentage}%` },
          { label: 'Avg Miss', value: `${summary.avg_miss_inches}"` },
        ].map(({ label, value }) => (
          <div key={label} className="bg-gray-800 rounded-xl p-3 text-center">
            <div className="text-2xl font-bold text-indigo-400">{value}</div>
            <div className="text-xs text-gray-400 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* By pitch type */}
      {Object.keys(summary.by_pitch_type || {}).length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-300 mb-2">By Pitch Type</h3>
          <div className="space-y-2">
            {Object.entries(summary.by_pitch_type).map(([pt, data]) => (
              <div key={pt} className="bg-gray-800 rounded-xl p-3 flex items-center gap-3">
                <div className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ background: PITCH_COLORS[pt] || '#9ca3af' }} />
                <div className="flex-1">
                  <div className="flex justify-between">
                    <span className="font-medium text-sm">{pt}</span>
                    <span className="text-gray-400 text-sm">{data.count} pitches</span>
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    Avg miss: <span className="text-yellow-400">{Math.round(data.avg_miss_distance * 17)}"</span>
                    &nbsp;·&nbsp;
                    Most common: <span className="text-gray-300">{data.most_common_miss}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Count sequencing */}
      {sortedCounts.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-300 mb-2">Sequencing by Count</h3>
          <div className="space-y-2">
            {sortedCounts.map(count => {
              const ps = countGroups[count]
              // tally pitch types and results
              const typeMap = {}, resultMap = {}
              for (const p of ps) {
                const pt = p.pitch_type || 'Other'
                typeMap[pt] = (typeMap[pt] || 0) + 1
                const r = p.result || '—'
                resultMap[r] = (resultMap[r] || 0) + 1
              }
              const topType   = Object.entries(typeMap).sort((a,b) => b[1]-a[1])[0]
              const topResult = Object.entries(resultMap).sort((a,b) => b[1]-a[1])[0]
              const label     = COUNT_LABELS[count]
              const [b, s]    = count.split('-').map(Number)
              const isPitcher = s === 2
              const isHitter  = b >= 2 && s <= 1
              return (
                <div key={count} className="bg-gray-800 rounded-xl px-3 py-2.5 flex items-center gap-3">
                  {/* Count badge */}
                  <div className={`text-lg font-black tabular-nums w-10 text-center flex-shrink-0 ${
                    isPitcher ? 'text-green-400' : isHitter ? 'text-red-400' : 'text-gray-300'
                  }`}>
                    {count}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {label && (
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                          isPitcher ? 'bg-green-900/50 text-green-400' : isHitter ? 'bg-red-900/50 text-red-400' : 'bg-gray-700 text-gray-400'
                        }`}>{label}</span>
                      )}
                      {/* Pitch type dots */}
                      {Object.entries(typeMap).map(([pt, cnt]) => (
                        <span key={pt} className="flex items-center gap-0.5 text-xs text-gray-400">
                          <span className="w-2 h-2 rounded-full inline-block"
                            style={{ background: PITCH_COLORS[pt] || '#6b7280' }} />
                          {pt.split(' ')[0]} ×{cnt}
                        </span>
                      ))}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      Most common: <span className="text-gray-300">{topResult[0]}</span>
                      {topType && <> · <span style={{ color: PITCH_COLORS[topType[0]] || '#9ca3af' }}>{topType[0]}</span></>}
                    </div>
                  </div>
                  <span className="text-xs text-gray-600 flex-shrink-0">{ps.length}×</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Heatmap */}
      {pitches.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-300 mb-2">Pitch Chart</h3>
          <div className="flex justify-center">
            <StrikeZone
              pitches={pitches}
              showAllPitches
              intended={selected ? { x: selected.intended_x, y: selected.intended_y } : null}
              actual={selected ? { x: selected.actual_x, y: selected.actual_y } : null}
            />
          </div>
        </div>
      )}

      {/* Pitch log */}
      {pitches.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-300 mb-2">Pitch Log</h3>
          <div className="space-y-1.5">
            {pitches.map((p, i) => (
              <div key={p.id || i}>
                {/* Main row */}
                <div
                  onClick={() => { setSelectedPitch(selectedPitch === i ? null : i); setEditingId(null) }}
                  className={`rounded-xl p-3 cursor-pointer transition ${
                    selectedPitch === i && editingId !== p.id
                      ? 'bg-indigo-900/50 border border-indigo-600'
                      : 'bg-gray-800 hover:bg-gray-750'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 w-5 text-right">{i + 1}</span>
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ background: PITCH_COLORS[p.pitch_type] || '#9ca3af' }} />
                    <span className="font-medium text-sm flex-1">{p.pitch_type}</span>
                    {p.balls != null && p.strikes != null && (
                      <span className="text-xs text-gray-500 font-mono">{p.balls}-{p.strikes}</span>
                    )}
                    {p.velocity && <span className="text-xs text-gray-400">{p.velocity} mph</span>}
                    {p.result && (
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${resultColor(p.result)}`}>
                        {p.result}
                      </span>
                    )}
                    {/* Edit / Delete buttons */}
                    <button
                      onClick={e => startEdit(p, e)}
                      className="text-gray-600 hover:text-gray-300 transition text-xs px-1"
                      title="Edit pitch"
                    >✎</button>
                    <button
                      onClick={e => deletePitch(p.id, e)}
                      disabled={deleting === p.id}
                      className="text-gray-600 hover:text-red-400 transition text-xs px-1"
                      title="Delete pitch"
                    >{deleting === p.id ? '…' : '🗑'}</button>
                  </div>

                  <div className="ml-7 mt-1 text-xs text-gray-400">
                    <span className={p.miss_distance < 0.1 ? 'text-green-400' : p.miss_distance < 0.3 ? 'text-yellow-400' : 'text-red-400'}>
                      {p.miss_description}
                    </span>
                    {p.spin_rate && <span className="ml-2 text-gray-500">· {Math.round(p.spin_rate)} rpm</span>}
                    {p.notes && <span className="ml-2 text-gray-500">· {p.notes}</span>}
                  </div>

                  {selectedPitch === i && editingId !== p.id && (
                    <div className="ml-7 mt-1.5 bg-gray-900 rounded-lg p-2 space-y-1">
                      {(p.spin_rate || p.break_h != null || p.break_v != null) && (
                        <div className="flex gap-3 mb-1.5">
                          {p.spin_rate && <span className="text-xs text-indigo-300">📡 {Math.round(p.spin_rate)} rpm</span>}
                          {p.break_h != null && <span className="text-xs text-gray-400">H: {p.break_h}"</span>}
                          {p.break_v != null && <span className="text-xs text-gray-400">V: {p.break_v}"</span>}
                        </div>
                      )}
                      {p.rulebook_context && (
                        <>
                          <p className="text-xs text-indigo-300 font-medium">Actual location:</p>
                          <p className="text-xs text-gray-400">{p.rulebook_context}</p>
                          {p.intended_rulebook_context && p.intended_rulebook_context !== p.rulebook_context && (
                            <>
                              <p className="text-xs text-green-400 font-medium mt-1">Intended:</p>
                              <p className="text-xs text-gray-400">{p.intended_rulebook_context}</p>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* Inline edit form */}
                {editingId === p.id && (
                  <div className="bg-gray-900 border border-indigo-700 rounded-xl p-3 mt-1 space-y-2"
                    onClick={e => e.stopPropagation()}>
                    <p className="text-xs text-indigo-400 font-medium mb-1">Edit pitch #{i + 1}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-gray-500 block mb-1">Pitch type</label>
                        <select
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm"
                          value={editForm.pitch_type}
                          onChange={e => setEditForm(f => ({ ...f, pitch_type: e.target.value }))}
                        >
                          {PITCH_TYPES.map(t => <option key={t}>{t}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-gray-500 block mb-1">Result</label>
                        <select
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm"
                          value={editForm.result}
                          onChange={e => setEditForm(f => ({ ...f, result: e.target.value }))}
                        >
                          {RESULTS.map(r => <option key={r}>{r}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-gray-500 block mb-1">Velocity (mph)</label>
                        <input type="number" placeholder="88"
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm"
                          value={editForm.velocity}
                          onChange={e => setEditForm(f => ({ ...f, velocity: e.target.value }))}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-gray-500 block mb-1">Notes</label>
                        <input type="text" placeholder="optional"
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm"
                          value={editForm.notes}
                          onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => saveEdit(p.id)} disabled={saving}
                        className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg py-1.5 text-xs font-semibold transition">
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                      <button onClick={() => setEditingId(null)}
                        className="px-4 bg-gray-700 hover:bg-gray-600 rounded-lg py-1.5 text-xs transition">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={fetchSummary}
        className="w-full py-2 text-sm text-indigo-400 hover:text-indigo-300 transition"
      >
        ↻ Refresh
      </button>
    </div>
  )
}
