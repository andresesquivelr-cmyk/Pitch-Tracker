/**
 * TrackManAnalyzer
 * Input TrackMan / Rapsodo metrics for a pitch and get AI-powered coaching feedback
 * based on spin rate, spin efficiency, IVB, HB, VAA, extension, and velocity.
 */
import React, { useState } from 'react'
import axios from 'axios'

const API = '/api'

const PITCH_TYPES = ['Fastball', 'Two-Seam', 'Sinker', 'Cutter', 'Slider', 'Curveball', 'Changeup', 'Splitter']

// Spin rate reference ranges shown as helper text
const SPIN_REFERENCE = {
  Fastball:  '2,100–2,500 RPM (MLB avg ~2,263)',
  'Two-Seam':'1,850–2,350 RPM (MLB avg ~2,165)',
  Sinker:    '1,800–2,300 RPM (MLB avg ~2,100)',
  Cutter:    '2,200–2,800 RPM (MLB avg ~2,545)',
  Slider:    '2,100–2,700 RPM (MLB avg ~2,430)',
  Curveball: '2,100–2,800 RPM (MLB avg ~2,530)',
  Changeup:  '1,500–2,100 RPM (MLB avg ~1,850)',
  Splitter:  '1,100–1,600 RPM (MLB avg ~1,350)',
}

const SPIN_EFF_REFERENCE = {
  Fastball:  '90–100% (pure backspin = max carry)',
  'Two-Seam':'85–95%',
  Sinker:    '85–92%',
  Cutter:    '45–65% (some gyro = late cut)',
  Slider:    '20–45% (gyro-dominant = sharp late break)',
  Curveball: '60–75% (topspin-dominant)',
  Changeup:  '75–90%',
  Splitter:  '40–60%',
}

function Field({ label, hint, value, onChange, unit, type = 'number', step = '0.1', placeholder }) {
  return (
    <div>
      <label className="text-xs text-gray-400 block mb-1">
        {label} {unit && <span className="text-gray-600">({unit})</span>}
      </label>
      <input
        type={type}
        step={step}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
      />
      {hint && <p className="text-xs text-gray-600 mt-0.5">{hint}</p>}
    </div>
  )
}

function RatingBadge({ rating }) {
  const colors = {
    'Elite': 'bg-emerald-900 text-emerald-300',
    'Above Average': 'bg-green-900 text-green-300',
    'Average': 'bg-gray-700 text-gray-300',
    'Below Average': 'bg-yellow-900 text-yellow-300',
    'Low': 'bg-red-900 text-red-300',
    'Good': 'bg-green-900 text-green-300',
    'Needs Work': 'bg-yellow-900 text-yellow-300',
    'Concern': 'bg-red-900 text-red-300',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded font-medium ${colors[rating] || 'bg-gray-700 text-gray-300'}`}>
      {rating}
    </span>
  )
}

export default function TrackManAnalyzer() {
  const [pitchType, setPitchType] = useState('Fastball')
  const [velocity, setVelocity] = useState('')
  const [spinRate, setSpinRate] = useState('')
  const [spinEff, setSpinEff] = useState('')
  const [ivb, setIvb] = useState('')
  const [hb, setHb] = useState('')
  const [vaa, setVaa] = useState('')
  const [extension, setExtension] = useState('')
  const [releaseHeight, setReleaseHeight] = useState('')
  const [batterHand, setBatterHand] = useState('R')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const analyze = async () => {
    setError('')
    setLoading(true)
    try {
      const payload = {
        pitch_type: pitchType,
        velocity: velocity ? parseFloat(velocity) : null,
        spin_rate: spinRate ? parseFloat(spinRate) : null,
        spin_efficiency: spinEff ? parseFloat(spinEff) : null,
        induced_vertical_break: ivb ? parseFloat(ivb) : null,
        horizontal_break: hb ? parseFloat(hb) : null,
        vertical_approach_angle: vaa ? parseFloat(vaa) : null,
        release_extension: extension ? parseFloat(extension) : null,
        release_height: releaseHeight ? parseFloat(releaseHeight) : null,
        batter_hand: batterHand,
      }
      const res = await axios.post(`${API}/trackman/analyze`, payload)
      setResult(res.data)
    } catch {
      setError('Could not connect to backend. Make sure the server is running.')
    } finally {
      setLoading(false)
    }
  }

  const hasAnyInput = spinRate || spinEff || ivb || hb || vaa || extension || velocity

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold">TrackMan Analyzer</h2>
        <p className="text-xs text-gray-400 mt-0.5">
          Input metrics from TrackMan, Rapsodo, or Hawk-Eye to get coaching feedback on why the pitch is or isn't working.
        </p>
      </div>

      {/* Pitch type */}
      <div>
        <label className="text-xs text-gray-400 mb-1 block">Pitch Type</label>
        <div className="flex flex-wrap gap-1.5">
          {PITCH_TYPES.map(pt => (
            <button
              key={pt}
              onClick={() => { setPitchType(pt); setResult(null) }}
              className={`px-3 py-1 rounded-full text-sm transition ${
                pitchType === pt ? 'bg-indigo-600 text-white font-medium' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
            >{pt}</button>
          ))}
        </div>
      </div>

      {/* Batter hand */}
      <div className="flex gap-2 items-center">
        <span className="text-xs text-gray-400">vs.</span>
        {['L', 'R'].map(h => (
          <button key={h}
            onClick={() => setBatterHand(h)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
              batterHand === h ? 'bg-indigo-600' : 'bg-gray-800 hover:bg-gray-700'
            }`}
          >{h}HH</button>
        ))}
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Velocity" unit="mph" value={velocity} onChange={setVelocity}
          placeholder="e.g. 91.5" />
        <div>
          <Field label="Spin Rate" unit="RPM" value={spinRate} onChange={setSpinRate}
            placeholder="e.g. 2340" step="1" />
          <p className="text-xs text-gray-600 mt-0.5">{SPIN_REFERENCE[pitchType]}</p>
        </div>
        <div>
          <Field label="Spin Efficiency" unit="%" value={spinEff} onChange={setSpinEff}
            placeholder="e.g. 92" step="1" />
          <p className="text-xs text-gray-600 mt-0.5">{SPIN_EFF_REFERENCE[pitchType]}</p>
        </div>
        <Field label="Induced Vertical Break (IVB)" unit="in" value={ivb} onChange={setIvb}
          placeholder="e.g. 16.2" hint="Positive = rise, negative = drop" />
        <Field label="Horizontal Break" unit="in" value={hb} onChange={setHb}
          placeholder="e.g. 8.4" hint="Positive = arm side, negative = glove side" />
        <Field label="Vertical Approach Angle (VAA)" unit="°" value={vaa} onChange={setVaa}
          placeholder="e.g. -4.8" hint="Negative = downward. Flatter = harder to hit" />
        <Field label="Release Extension" unit="ft" value={extension} onChange={setExtension}
          placeholder="e.g. 6.4" hint="MLB avg ~6.2 ft" />
        <Field label="Release Height" unit="ft" value={releaseHeight} onChange={setReleaseHeight}
          placeholder="e.g. 6.1" />
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <button
        onClick={analyze}
        disabled={loading || !hasAnyInput}
        className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-xl py-3 font-semibold text-base transition"
      >
        {loading ? 'Analyzing...' : 'Analyze Pitch'}
      </button>

      {/* Results */}
      {result && (
        <div className="space-y-4 pt-2 border-t border-gray-800">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-base">{result.pitch_type} Analysis</h3>
            <div className="flex gap-1">
              {Object.entries(result.ratings || {}).map(([key, val]) => (
                <RatingBadge key={key} rating={val} />
              ))}
            </div>
          </div>

          {/* Strengths */}
          {result.strengths?.length > 0 && (
            <div className="bg-emerald-950/50 border border-emerald-800 rounded-xl p-3 space-y-1.5">
              <p className="text-xs font-semibold text-emerald-400 uppercase tracking-wide">Strengths</p>
              {result.strengths.map((s, i) => (
                <p key={i} className="text-sm text-emerald-200">✓ {s}</p>
              ))}
            </div>
          )}

          {/* Concerns */}
          {result.concerns?.length > 0 && (
            <div className="bg-red-950/50 border border-red-800 rounded-xl p-3 space-y-1.5">
              <p className="text-xs font-semibold text-red-400 uppercase tracking-wide">Concerns</p>
              {result.concerns.map((c, i) => (
                <p key={i} className="text-sm text-red-200">⚠ {c}</p>
              ))}
            </div>
          )}

          {/* Coaching feedback */}
          {result.coaching_feedback?.length > 0 && (
            <div className="bg-indigo-950/50 border border-indigo-800 rounded-xl p-3 space-y-1.5">
              <p className="text-xs font-semibold text-indigo-400 uppercase tracking-wide">Coaching Notes</p>
              {result.coaching_feedback.map((f, i) => (
                <p key={i} className="text-sm text-indigo-200">→ {f}</p>
              ))}
            </div>
          )}

          {/* Rulebook note */}
          <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-3">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">MLB Rulebook — Strike Zone</p>
            <p className="text-xs text-gray-400 leading-relaxed">{result.rulebook_note}</p>
          </div>
        </div>
      )}

      {/* Static reference card */}
      {!result && (
        <div className="bg-gray-800/40 border border-gray-700 rounded-xl p-4 space-y-2">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">MLB Rulebook — Strike Zone (Rule 2.00)</p>
          <p className="text-xs text-gray-400 leading-relaxed">
            <span className="text-gray-300 font-medium">Upper boundary:</span> midpoint between the top of the shoulders and the top of the uniform pants (approx. letters/chest)
          </p>
          <p className="text-xs text-gray-400 leading-relaxed">
            <span className="text-gray-300 font-medium">Lower boundary:</span> the hollow beneath the kneecap
          </p>
          <p className="text-xs text-gray-400 leading-relaxed">
            <span className="text-gray-300 font-medium">Width:</span> 17 inches — the width of home plate. A pitch touching any part of the plate is a strike.
          </p>
          <p className="text-xs text-gray-400 leading-relaxed">
            <span className="text-gray-300 font-medium">Determined by:</span> the batter's stance as they prepare to swing — not a fixed absolute height.
          </p>
        </div>
      )}
    </div>
  )
}
