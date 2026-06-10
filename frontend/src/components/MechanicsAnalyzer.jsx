import React, { useState, useEffect, useRef } from 'react'
import axios from 'axios'

const API = '/api'

// ── Color helpers ──────────────────────────────────────────────────────────────
const STATUS_STYLES = {
  good:    { bg: 'bg-green-900/30',  border: 'border-green-700',  dot: 'bg-green-400',  text: 'text-green-300'  },
  warning: { bg: 'bg-yellow-900/30', border: 'border-yellow-700', dot: 'bg-yellow-400', text: 'text-yellow-300' },
  fault:   { bg: 'bg-red-900/30',    border: 'border-red-700',    dot: 'bg-red-400',    text: 'text-red-300'    },
  info:    { bg: 'bg-blue-900/30',   border: 'border-blue-700',   dot: 'bg-blue-400',   text: 'text-blue-300'   },
}

// ── Arm slot SVG diagram ───────────────────────────────────────────────────────
function ArmSlotDiagram({ angle }) {
  const cx = 80, cy = 80, r = 60
  const toXY = (deg) => ({
    x: cx + r * Math.cos((-(deg) * Math.PI) / 180),
    y: cy - r * Math.sin((deg * Math.PI) / 180),
  })
  const refs = [
    { deg: 80, label: 'OTT', color: '#60a5fa' },
    { deg: 60, label: '3/4', color: '#4ade80' },
    { deg: 38, label: 'L3/4', color: '#facc15' },
    { deg: 15, label: 'Side', color: '#fb923c' },
  ]
  const end = toXY(angle)
  return (
    <svg viewBox="0 0 160 100" className="w-full max-w-[200px]">
      {refs.map(({ deg, label, color }) => {
        const pt = toXY(deg)
        return (
          <g key={deg}>
            <line x1={cx} y1={cy} x2={pt.x} y2={pt.y} stroke={color} strokeWidth="1" strokeDasharray="3,3" opacity="0.5" />
            <text x={pt.x + (pt.x > cx ? 3 : -3)} y={pt.y + 4} fontSize="7" fill={color} textAnchor={pt.x > cx ? 'start' : 'end'}>{label}</text>
          </g>
        )
      })}
      <line x1={cx} y1={cy} x2={end.x} y2={end.y} stroke="#f97316" strokeWidth="3" strokeLinecap="round" />
      <circle cx={end.x} cy={end.y} r="4" fill="#f97316" />
      <circle cx={cx} cy={cy} r="4" fill="white" opacity="0.8" />
    </svg>
  )
}

// ── Week plan card ─────────────────────────────────────────────────────────────
function WeekCard({ week }) {
  const [open, setOpen] = useState(week.week === 1)
  return (
    <div className="border border-gray-700 rounded-xl overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-800 hover:bg-gray-750 text-left transition"
        onClick={() => setOpen(o => !o)}
      >
        <div>
          <span className="text-indigo-400 font-bold text-sm">Week {week.week}</span>
          <span className="text-gray-300 text-sm ml-2">— {week.theme}</span>
        </div>
        <span className="text-gray-500 text-xs">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="px-4 py-3 space-y-3 bg-gray-900/50">
          <p className="text-gray-300 text-sm">{week.focus}</p>
          <p className="text-gray-500 text-xs">📋 Volume: {week.volume}</p>
          {week.drills.length > 0 && (
            <div className="space-y-2">
              {week.drills.map((d, i) => (
                <div key={i} className="bg-gray-800 rounded-lg p-3 border border-gray-700">
                  <p className="text-white font-medium text-sm">🏋️ {d.name}</p>
                  <p className="text-gray-400 text-xs mt-1">{d.how}</p>
                  <p className="text-indigo-400 text-xs mt-1 font-medium">{d.reps}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Fault card ─────────────────────────────────────────────────────────────────
function FaultCard({ fault, index }) {
  const [showDrills, setShowDrills] = useState(false)
  const isWarning = fault.warning
  const style = isWarning ? STATUS_STYLES.warning : STATUS_STYLES.fault
  return (
    <div className={`border ${style.border} ${style.bg} rounded-xl p-4 space-y-2`}>
      <div className="flex items-start gap-2">
        <span className="text-lg">{isWarning ? '⚠️' : '🔴'}</span>
        <div className="flex-1 min-w-0">
          <p className={`font-semibold text-sm ${style.text}`}>
            #{index + 1} Priority — {fault.label}
          </p>
          <p className="text-gray-300 text-sm mt-1">{fault.text}</p>
        </div>
      </div>
      {fault.drills && fault.drills.length > 0 && (
        <div>
          <button
            className="text-xs text-indigo-400 hover:text-indigo-300 transition mt-1"
            onClick={() => setShowDrills(o => !o)}
          >
            {showDrills ? '▲ Hide drills' : `▼ Show ${fault.drills.length} drill${fault.drills.length > 1 ? 's' : ''}`}
          </button>
          {showDrills && (
            <div className="mt-2 space-y-2">
              {fault.drills.map((d, i) => (
                <div key={i} className="bg-gray-800 border border-gray-700 rounded-lg p-3">
                  <p className="text-white font-medium text-sm">🏋️ {d.name}</p>
                  <p className="text-gray-400 text-xs mt-1">{d.how}</p>
                  <p className="text-indigo-400 text-xs mt-1.5 font-medium">{d.reps}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Behind-pitcher metric cards ────────────────────────────────────────────────
function BehindMetricBar({ label, value, max, unit = '', color = 'indigo' }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100))
  const colors = { indigo: 'bg-indigo-500', green: 'bg-green-500', orange: 'bg-orange-500', red: 'bg-red-500' }
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-gray-400">{label}</span>
        <span className="text-white font-mono">{value}{unit}</span>
      </div>
      <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
        <div className={`h-full ${colors[color] || colors.indigo} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function MechanicsAnalyzer() {
  const [state, setState] = useState('idle')
  const [result, setResult] = useState(null)
  const [errMsg, setErrMsg] = useState('')
  const [mediapipeOk, setMediapipeOk] = useState(null)
  const [progress, setProgress] = useState(0)
  const [activeTab, setActiveTab] = useState('faults')
  const [cameraAngle, setCameraAngle] = useState('side')
  const fileRef = useRef()
  const timerRef = useRef()

  const STEPS_SIDE = [
    'Reading video frames…',
    'Running pose detection…',
    'Finding release frame…',
    'Finding stride plant…',
    'Computing 9 metrics…',
    'Interpreting faults…',
    'Building training plan…',
  ]

  const STEPS_BEHIND = [
    'Reading video frames…',
    'Running pose detection…',
    'Finding release frame…',
    'Measuring arm circle…',
    'Measuring hip rotation…',
    'Checking follow-through…',
    'Building training plan…',
  ]

  const STEPS = cameraAngle === 'behind' ? STEPS_BEHIND : STEPS_SIDE

  useEffect(() => {
    axios.get(`${API}/mechanics/available`)
      .then(r => setMediapipeOk(r.data.available))
      .catch(() => setMediapipeOk(false))
  }, [])

  useEffect(() => {
    if (state === 'loading') {
      let step = 0
      timerRef.current = setInterval(() => {
        step = (step + 1) % STEPS.length
        setProgress(step)
      }, 2800)
    } else {
      clearInterval(timerRef.current)
    }
    return () => clearInterval(timerRef.current)
  }, [state])

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setState('loading')
    setProgress(0)
    const form = new FormData()
    form.append('file', file)
    try {
      const res = await axios.post(
        `${API}/mechanics/analyze?camera_angle=${cameraAngle}`,
        form,
        { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 180000 }
      )
      if (res.data.error) {
        setErrMsg(res.data.error)
        setState('error')
      } else {
        setResult(res.data)
        setState('results')
        setActiveTab('faults')
      }
    } catch (err) {
      setErrMsg(err.response?.data?.detail || 'Analysis failed. Check video angle and lighting.')
      setState('error')
    }
  }

  // ── MediaPipe not installed ───────────────────────────────────────────────────
  if (mediapipeOk === false) {
    return (
      <div className="bg-yellow-900/20 border border-yellow-700 rounded-2xl p-5 space-y-3">
        <p className="font-semibold text-yellow-300">⚙️ One-time setup required</p>
        <p className="text-gray-300 text-sm">MediaPipe needs to be installed to run automatic mechanics analysis.</p>
        <div className="bg-gray-900 rounded-lg px-4 py-3 font-mono text-sm text-green-400 select-all">
          bash setup.sh
        </div>
        <p className="text-gray-400 text-xs">Run this once in the project folder, then reload the page.</p>
      </div>
    )
  }

  // ── Loading ───────────────────────────────────────────────────────────────────
  if (state === 'loading') {
    return (
      <div className="flex flex-col items-center gap-6 py-10">
        <div className="w-16 h-16 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        <div className="space-y-1 text-center">
          {STEPS.map((s, i) => (
            <p key={i} className={`text-sm transition-all ${
              i === progress ? 'text-white font-medium' : i < progress ? 'text-gray-600 line-through' : 'text-gray-600'
            }`}>
              {i < progress ? '✓ ' : i === progress ? '⏳ ' : ''}{s}
            </p>
          ))}
        </div>
      </div>
    )
  }

  // ── Error ─────────────────────────────────────────────────────────────────────
  if (state === 'error') {
    return (
      <div className="space-y-4">
        <div className="bg-red-900/30 border border-red-700 rounded-xl p-4">
          <p className="text-red-300 font-medium">Analysis failed</p>
          <p className="text-gray-400 text-sm mt-1">{errMsg}</p>
        </div>
        <div className="bg-gray-800 rounded-xl p-4 text-sm space-y-1">
          <p className="text-gray-300 font-medium">Tips for best results:</p>
          <p className="text-gray-400">• Film from the side (3B-side for RHP, 1B-side for LHP)</p>
          <p className="text-gray-400">• Pitcher visible head-to-ankle in every frame</p>
          <p className="text-gray-400">• 3–10 second clip of one full delivery</p>
          <p className="text-gray-400">• Good lighting — avoid dark bullpens</p>
        </div>
        <button
          className="w-full bg-indigo-600 hover:bg-indigo-500 rounded-xl py-3 font-semibold transition"
          onClick={() => { setState('idle'); if (fileRef.current) fileRef.current.value = '' }}
        >Try Another Video</button>
      </div>
    )
  }

  // ── Results ───────────────────────────────────────────────────────────────────
  if (state === 'results' && result) {
    const plan = result.training_plan
    const interp = result.interpretation
    const faultCount = plan.fault_count
    const warnCount = plan.warning_count

    return (
      <div className="space-y-5 pb-6">

        {/* Summary banner */}
        <div className={`rounded-2xl p-4 border ${
          faultCount === 0 ? 'bg-green-900/30 border-green-700' : 'bg-gray-800 border-gray-700'
        }`}>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <p className="font-bold text-base">
                {faultCount === 0 && warnCount === 0
                  ? '✅ Mechanics look solid'
                  : faultCount === 0
                  ? `⚠️ ${warnCount} area${warnCount > 1 ? 's' : ''} to polish`
                  : `🔴 ${faultCount} priority fix${faultCount > 1 ? 'es' : ''} found`}
              </p>
              <p className="text-gray-400 text-xs mt-0.5">
                {result.throwing_side === 'R' ? 'Right-handed' : 'Left-handed'} pitcher
                {' · '}{result.total_frames_analyzed} frames analyzed
                {' · '}Release at {result.release_time_sec}s
              </p>
            </div>
            <button
              className="text-xs text-gray-500 hover:text-gray-300 transition"
              onClick={() => { setState('idle'); if (fileRef.current) fileRef.current.value = '' }}
            >↩ New video</button>
          </div>
        </div>

        {/* Annotated frames */}
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <p className="text-xs text-gray-500 text-center">
              {result.camera_angle === 'behind' ? 'Wind-Up' : 'Stride Plant'}
            </p>
            <img src={`data:image/jpeg;base64,${result.stride_frame_b64}`} className="w-full rounded-xl" alt="frame1" />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-gray-500 text-center">Release Point</p>
            <img src={`data:image/jpeg;base64,${result.release_frame_b64}`} className="w-full rounded-xl" alt="Release" />
          </div>
        </div>

        {/* Side view: arm slot diagram | Behind view: key metric bars */}
        {result.camera_angle !== 'behind' ? (
          <div className="flex items-center gap-4 bg-gray-800 rounded-xl p-4">
            <ArmSlotDiagram angle={result.metrics.arm_slot_angle} />
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Arm Slot</p>
              <p className="font-bold text-lg">{interp.arm_slot?.label}</p>
              <p className="text-gray-400 text-xs mt-1">{interp.arm_slot?.text}</p>
            </div>
          </div>
        ) : (
          <div className="bg-gray-800 rounded-xl p-4 space-y-3">
            <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">Behind-Pitcher Metrics</p>
            <BehindMetricBar label="Hip Rotation" value={result.metrics.hip_rotation_total || 0} max={100} unit="°"
              color={result.metrics.hip_rotation_total > 55 ? 'green' : result.metrics.hip_rotation_total > 35 ? 'indigo' : 'red'} />
            <BehindMetricBar label="Arm Backswing Height" value={result.metrics.backswing_height || 0} max={30}
              color={result.metrics.backswing_height > 15 ? 'green' : result.metrics.backswing_height > 5 ? 'indigo' : 'red'} />
            <BehindMetricBar label="Follow-Through Distance" value={Math.max(0, result.metrics.follow_through_dist || 0)} max={20}
              color={result.metrics.follow_through_crosses ? 'green' : 'red'} />
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-400">Head Stability</span>
              <span className={`font-medium ${result.metrics.head_stability < 2 ? 'text-green-400' : result.metrics.head_stability < 4.5 ? 'text-yellow-400' : 'text-red-400'}`}>
                {result.metrics.head_stability < 2 ? 'Stable ✓' : result.metrics.head_stability < 4.5 ? 'Minor drift' : 'Drifting ⚠️'}
              </span>
            </div>
          </div>
        )}

        {/* Tab bar */}
        <div className="flex gap-1 bg-gray-800 p-1 rounded-xl">
          {[
            ['faults',    `🔴 Priority Fixes (${faultCount + warnCount})`],
            ['positives', `✅ What's Good (${plan.positives.length})`],
            ['plan',      '📋 4-Week Plan'],
          ].map(([tab, label]) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-2 rounded-lg text-xs font-medium transition ${
                activeTab === tab ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >{label}</button>
          ))}
        </div>

        {/* Priority Fixes */}
        {activeTab === 'faults' && (
          <div className="space-y-3">
            {plan.priority_fixes.length === 0 ? (
              <p className="text-center text-gray-400 py-6">No major faults detected. Keep working on consistency.</p>
            ) : (
              plan.priority_fixes.map((f, i) => <FaultCard key={i} fault={f} index={i} />)
            )}
          </div>
        )}

        {/* What's Good */}
        {activeTab === 'positives' && (
          <div className="space-y-3">
            {plan.positives.length === 0 ? (
              <p className="text-center text-gray-400 py-6">Film from the side for full positives detection.</p>
            ) : (
              plan.positives.map((p, i) => (
                <div key={i} className="bg-green-900/20 border border-green-800 rounded-xl p-4 flex gap-3">
                  <span className="text-green-400 flex-shrink-0">✅</span>
                  <div>
                    <p className="text-green-300 font-semibold text-sm">{p.label}</p>
                    <p className="text-gray-300 text-sm mt-0.5">{p.text}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* Training Plan */}
        {activeTab === 'plan' && (
          <div className="space-y-4">

            {/* Mental cues */}
            {plan.mental_cues.length > 0 && (
              <div className="bg-indigo-900/20 border border-indigo-700 rounded-xl p-4">
                <p className="text-indigo-300 font-semibold text-sm mb-3">🧠 Mental Cues — pick ONE per outing</p>
                <div className="space-y-2">
                  {plan.mental_cues.map((c, i) => (
                    <div key={i} className="bg-indigo-900/30 rounded-lg px-3 py-2">
                      <p className="text-white font-medium text-sm italic">{c.cue}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {plan.week_plan.length > 0 ? (
              <div className="space-y-2">
                <p className="text-gray-400 text-sm font-medium">4-Week Progression</p>
                {plan.week_plan.map((w, i) => <WeekCard key={i} week={w} />)}
              </div>
            ) : (
              <p className="text-gray-400 text-sm text-center py-6">
                No faults detected — maintain your current routine and re-analyze in 2 weeks.
              </p>
            )}

            {/* Raw metrics (collapsed) */}
            <details className="bg-gray-800 rounded-xl overflow-hidden">
              <summary className="px-4 py-3 text-sm text-gray-400 cursor-pointer hover:text-white">
                Raw metrics (advanced)
              </summary>
              <div className="px-4 pb-4 grid grid-cols-2 gap-1.5 text-xs">
                {Object.entries(result.metrics).map(([k, v]) => (
                  <div key={k} className="bg-gray-900 rounded-lg px-3 py-2">
                    <p className="text-gray-500">{k.replace(/_/g, ' ')}</p>
                    <p className="text-white font-mono font-bold">{v}</p>
                  </div>
                ))}
              </div>
            </details>
          </div>
        )}
      </div>
    )
  }

  // ── Idle — upload screen ──────────────────────────────────────────────────────
  const ANGLE_INFO = {
    side: {
      emoji: '↔️',
      title: 'Side View',
      desc: 'Film from the 3B-side (RHP) or 1B-side (LHP), 15–30 feet back.',
      detects: ['Arm slot & elbow position', 'Pulling / early shoulder rotation', 'Hip-shoulder separation', 'Release height & trunk direction', 'Stride alignment'],
    },
    behind: {
      emoji: '🎯',
      title: 'Behind the Pitcher',
      desc: 'Camera behind the mound, slightly elevated, looking toward home plate.',
      detects: ['Arm circle completeness (short-arming)', 'Follow-through & arm deceleration', 'Hip rotation amount', 'Stride foot direction', 'Head stability & release consistency'],
    },
  }

  const info = ANGLE_INFO[cameraAngle]

  return (
    <div className="space-y-4">

      <div className="bg-gradient-to-br from-indigo-900/40 to-gray-800 border border-indigo-800/50 rounded-2xl p-4">
        <h2 className="text-lg font-bold mb-3">📐 Mechanics Analyzer</h2>

        {/* Camera angle selector */}
        <div className="flex gap-2 mb-4">
          {Object.entries(ANGLE_INFO).map(([angle, i]) => (
            <button
              key={angle}
              onClick={() => setCameraAngle(angle)}
              className={`flex-1 rounded-xl p-3 text-left border transition ${
                cameraAngle === angle
                  ? 'bg-indigo-600 border-indigo-500 text-white'
                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
              }`}
            >
              <p className="text-lg mb-0.5">{i.emoji}</p>
              <p className="font-semibold text-sm">{i.title}</p>
            </button>
          ))}
        </div>

        <p className="text-gray-400 text-xs mb-2">{info.desc}</p>
        <div className="space-y-0.5">
          {info.detects.map((d, i) => (
            <p key={i} className="text-gray-400 text-xs">✓ {d}</p>
          ))}
        </div>
      </div>

      <label className="block cursor-pointer">
        <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={handleFile} />
        <div className="border-2 border-dashed border-indigo-600 hover:border-indigo-400 rounded-2xl p-7 text-center transition group">
          <div className="text-3xl mb-2">{info.emoji}</div>
          <p className="font-semibold text-indigo-400 group-hover:text-indigo-300">
            Upload {info.title} video
          </p>
          <p className="text-gray-500 text-xs mt-1">MP4, MOV, AVI · 3–15 seconds</p>
        </div>
      </label>

      <div className="bg-gray-800 rounded-xl p-4 text-xs space-y-1.5">
        <p className="text-gray-300 font-medium text-sm">
          {cameraAngle === 'side' ? 'Side view tips:' : 'Behind-pitcher tips:'}
        </p>
        {cameraAngle === 'side' ? <>
          <p className="text-gray-400">📍 3B-side for RHP, 1B-side for LHP. Camera at hip height.</p>
          <p className="text-gray-400">📐 Pitcher fully visible head-to-ankle in every frame.</p>
          <p className="text-gray-400">⏱ Capture the full delivery — set position through follow-through.</p>
        </> : <>
          <p className="text-gray-400">📍 Set up directly behind the mound, slightly higher than catcher height.</p>
          <p className="text-gray-400">📐 Pitcher visible full-body — don't zoom in too tight.</p>
          <p className="text-gray-400">⏱ Best to capture from before the wind-up through follow-through.</p>
        </>}
      </div>
    </div>
  )
}
