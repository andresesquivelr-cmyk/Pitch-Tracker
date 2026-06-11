import React, { useState, useEffect } from 'react'
import axios from 'axios'
import StrikeZone from './components/StrikeZone'
import VideoAnnotator from './components/VideoAnnotator'
import LiveCamera from './components/LiveCamera'
import OutingSummary from './components/OutingSummary'
import MechanicsAnalyzer from './components/MechanicsAnalyzer'
import BullpenCamera from './components/BullpenCamera'
import BullpenSession from './components/BullpenSession'
import Login from './components/Login'
import TrendView from './components/TrendView'
import TrackManSummary from './components/TrackManSummary'
import { supabase } from './supabase'

const API = import.meta.env.VITE_API_URL || '/api'

const PITCH_TYPES = ['Fastball', 'Two-Seam', 'Cutter', 'Slider', 'Curveball', 'Changeup', 'Sinker', 'Splitter']
const RESULTS     = ['Strike', 'Called Strike', 'Swinging Strike', 'Ball', 'Foul', 'Hit', 'Out', 'HBP']

// Count auto-advance rules
function nextCount(balls, strikes, result) {
  if (['Hit', 'Out', 'HBP'].includes(result)) return { balls: 0, strikes: 0 }
  if (result === 'Ball') {
    const b = balls + 1
    return b >= 4 ? { balls: 0, strikes: 0 } : { balls: b, strikes }
  }
  if (['Strike', 'Called Strike', 'Swinging Strike'].includes(result)) {
    const s = strikes + 1
    return s >= 3 ? { balls: 0, strikes: 0 } : { balls, strikes: s }
  }
  if (result === 'Foul') {
    // Foul can't strike out
    const s = strikes < 2 ? strikes + 1 : strikes
    return { balls, strikes: s }
  }
  return { balls, strikes }
}

export default function App() {
  // ── Auth ─────────────────────────────────────────────────────────────────
  const [session, setSession] = useState(undefined) // undefined = loading, null = signed out

  useEffect(() => {
    // Check for existing session
    supabase.auth.getSession().then(({ data }) => {
      const s = data.session
      setSession(s ?? null)
      if (s) {
        axios.defaults.headers.common['Authorization'] = `Bearer ${s.access_token}`
      }
    })
    // Listen for auth state changes (sign in / sign out / token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s ?? null)
      if (s) {
        axios.defaults.headers.common['Authorization'] = `Bearer ${s.access_token}`
      } else {
        delete axios.defaults.headers.common['Authorization']
      }
    })
    return () => subscription.unsubscribe()
  }, [])

  const handleLogin = (s) => {
    setSession(s)
    axios.defaults.headers.common['Authorization'] = `Bearer ${s.access_token}`
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    setSession(null)
    delete axios.defaults.headers.common['Authorization']
  }

  // ── App state (ALL hooks must be before any early returns) ──────────────────
  const [screen, setScreen]           = useState('start')
  const [outing, setOuting]           = useState(null)
  const [pitcherName, setPitcherName] = useState('')
  const [error, setError]             = useState('')
  const [pastOutings, setPastOutings] = useState([])

  // Pitch form
  const [pitchType,   setPitchType]   = useState('Fastball')
  const [velocity,    setVelocity]    = useState('')
  const [inning,      setInning]      = useState('1')
  const [batterHand,  setBatterHand]  = useState('R')
  const [result,      setResult]      = useState('Strike')
  const [notes,       setNotes]       = useState('')
  const [intended,    setIntended]    = useState(null)
  const [actual,      setActual]      = useState(null)
  const [zoneMode,    setZoneMode]    = useState('intended')

  // Count tracking
  const [balls,   setBalls]   = useState(0)
  const [strikes, setStrikes] = useState(0)

  const [outingType,  setOutingType]  = useState('bullpen')
  const [opponent,    setOpponent]    = useState('')

  const [logging,     setLogging]     = useState(false)
  const [lastLogged,  setLastLogged]  = useState(null)
  const [pitchCount,  setPitchCount]  = useState(0)
  const [showVideo,   setShowVideo]   = useState(false)
  const [inputMode,   setInputMode]   = useState('upload')
  const [logTab,      setLogTab]      = useState('pitch')
  const [spinRate,    setSpinRate]    = useState('')
  const [breakH,      setBreakH]      = useState('')
  const [breakV,      setBreakV]      = useState('')
  const [showTrackman, setShowTrackman] = useState(false)

  React.useEffect(() => {
    if (screen === 'start') {
      axios.get(`${API}/outings`).then(r => setPastOutings(r.data.outings || [])).catch(() => {})
    }
  }, [screen])

  // Show nothing while checking session (avoids flash of login screen)
  if (session === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="text-gray-500 text-sm">Loading…</div>
      </div>
    )
  }

  // Not signed in — show login screen
  if (!session) {
    return <Login onLogin={handleLogin} />
  }

  const startOuting = async () => {
    if (!pitcherName.trim()) { setError('Enter a pitcher name'); return }
    setError('')
    try {
      const res = await axios.post(`${API}/outing/start`, {
        pitcher_name: pitcherName.trim(),
        outing_type:  outingType,
        opponent:     opponent.trim() || null,
      })
      setOuting(res.data)
      setPitchCount(0)
      setBalls(0); setStrikes(0)
      setScreen('log')
    } catch {
      setError('Could not connect to backend. Is the server running?')
    }
  }

  const resumeOuting = async (o) => {
    try {
      const res = await axios.get(`${API}/outing/${o.id}`)
      setOuting({ outing_id: o.id, pitcher_name: o.pitcher_name })
      setPitchCount(res.data.pitches?.length || 0)
      setScreen('log')
    } catch { setError('Could not load outing.') }
  }

  const logPitch = async () => {
    if (!intended) { setError('Set the target location on the zone'); return }
    if (!actual)   { setError('Set the actual pitch location on the zone'); return }
    setError('')
    setLogging(true)
    try {
      const res = await axios.post(`${API}/pitch/log`, {
        outing_id:    outing.outing_id,
        pitcher_name: outing.pitcher_name,
        pitch_type:   pitchType,
        intended_x:   intended.x,
        intended_y:   intended.y,
        actual_x:     actual.x,
        actual_y:     actual.y,
        velocity:     velocity ? parseFloat(velocity) : null,
        inning:       inning   ? parseInt(inning)     : null,
        batter_hand:  batterHand,
        result,
        notes:        notes.trim() || null,
        balls,
        strikes,
        spin_rate:    spinRate  ? parseFloat(spinRate)  : null,
        break_h:      breakH    ? parseFloat(breakH)    : null,
        break_v:      breakV    ? parseFloat(breakV)    : null,
      })
      setLastLogged(res.data)
      setPitchCount(c => c + 1)

      // Auto-advance count
      const next = nextCount(balls, strikes, result)
      setBalls(next.balls)
      setStrikes(next.strikes)

      // Reset location, keep pitch type / velocity / inning / batter
      setIntended(null); setActual(null)
      setZoneMode('intended')
      setNotes('')
      setResult('Strike')
      setShowVideo(false)
      setSpinRate(''); setBreakH(''); setBreakV('')
    } catch {
      setError('Failed to log pitch.')
    } finally {
      setLogging(false)
    }
  }

  // ── Trends screen ────────────────────────────────────────────────────────
  if (screen === 'trends') {
    return (
      <div className="min-h-screen p-4 max-w-lg mx-auto pb-10">
        <TrendView onBack={() => setScreen('start')} />
      </div>
    )
  }

  // ── Summary screen ────────────────────────────────────────────────────────
  if (screen === 'summary') {
    return (
      <div className="min-h-screen p-4 max-w-lg mx-auto">
        <OutingSummary outingId={outing.outing_id} onBack={() => setScreen('log')} />
      </div>
    )
  }

  // ── Start screen ──────────────────────────────────────────────────────────
  if (screen === 'start') {
    return (
      <div className="min-h-screen p-6 max-w-sm mx-auto space-y-8 pt-12">
        <div className="text-center relative">
          <h1 className="text-3xl font-bold tracking-tight">⚾ Pitch Tracker</h1>
          <p className="text-gray-400 text-sm mt-1">Command analysis for college pitchers</p>
          <div className="absolute right-0 top-1 flex items-center gap-3">
            <button onClick={() => setScreen('trends')}
              className="text-xs text-indigo-400 hover:text-indigo-300 transition font-medium">
              📈 Trends
            </button>
            <button onClick={handleSignOut}
              className="text-xs text-gray-500 hover:text-gray-300 transition">
              Sign out
            </button>
          </div>
        </div>

        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">New Outing</h2>
          <input
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-indigo-500"
            placeholder="Pitcher name"
            value={pitcherName}
            onChange={e => setPitcherName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && startOuting()}
          />

          {/* Outing type toggle */}
          <div className="flex bg-gray-800 p-1 rounded-xl">
            {[['bullpen','🎯 Bullpen'],['game','⚾ Game']].map(([t, label]) => (
              <button key={t} onClick={() => setOutingType(t)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${
                  outingType === t ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'
                }`}>{label}</button>
            ))}
          </div>

          {/* Opponent — only relevant for games, but show always */}
          <input
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500"
            placeholder={`Opponent${outingType === 'game' ? '' : ' (optional)'}`}
            value={opponent}
            onChange={e => setOpponent(e.target.value)}
          />

          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            className="w-full bg-indigo-600 hover:bg-indigo-500 rounded-xl py-3 font-semibold text-base transition"
            onClick={startOuting}
          >Start Outing</button>
        </div>

        {pastOutings.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">Past Outings</h2>
            <div className="space-y-2">
              {pastOutings.map(o => (
                <div key={o.id} className="flex items-center gap-3 bg-gray-800 rounded-xl px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{o.pitcher_name}</p>
                    <p className="text-xs text-gray-500">
                      <span className={o.outing_type === 'game' ? 'text-amber-400' : 'text-indigo-400'}>
                        {o.outing_type === 'game' ? 'Game' : 'Bullpen'}
                      </span>
                      {o.opponent && ` vs ${o.opponent}`}
                      {' · '}{o.pitch_count} pitch{o.pitch_count !== 1 ? 'es' : ''}
                      {o.created_at && ` · ${new Date(o.created_at + 'Z').toLocaleDateString()}`}
                    </p>
                  </div>
                  <div className="flex gap-1.5">
                    <button onClick={() => resumeOuting(o)}
                      className="px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 rounded-lg text-xs font-medium transition">
                      Resume
                    </button>
                    <button onClick={() => { setOuting({ outing_id: o.id, pitcher_name: o.pitcher_name }); setScreen('summary') }}
                      className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs font-medium transition">
                      Summary
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── Log screen ────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen p-4 max-w-lg mx-auto space-y-4 pb-10">

      {/* Header */}
      <div className="flex items-center justify-between pt-2">
        <div>
          <h1 className="text-lg font-bold">{outing.pitcher_name}</h1>
          <p className="text-xs text-gray-400">{pitchCount} pitch{pitchCount !== 1 ? 'es' : ''} logged</p>
        </div>
        <button
          className="px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 rounded-lg text-sm font-medium transition"
          onClick={() => setScreen('summary')}
        >View Summary →</button>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-800 p-1 rounded-xl overflow-x-auto">
        {[['pitch','⚾ Log Pitch'],['bullpen','📹 Bullpen'],['mechanics','📐 Mechanics'],['trackman','📡 TrackMan']].map(([tab, label]) => (
          <button key={tab} onClick={() => setLogTab(tab)}
            className={`flex-1 py-2 rounded-lg text-xs font-medium transition whitespace-nowrap ${
              logTab === tab ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'
            }`}>{label}</button>
        ))}
      </div>

      {logTab === 'bullpen'   && <BullpenSession />}
      {logTab === 'mechanics' && <MechanicsAnalyzer />}
      {logTab === 'trackman'  && <TrackManSummary outingId={outing?.outing_id} />}

      {logTab === 'pitch' && <>

        {/* Last pitch feedback */}
        {lastLogged && (
          <div className="bg-green-900/40 border border-green-700 rounded-xl px-4 py-2.5 text-sm flex items-center justify-between">
            <span>
              <span className="text-green-300 font-medium">{lastLogged.pitch_type}</span>
              <span className="text-gray-300"> · </span>
              <span className={lastLogged.miss_distance < 0.1 ? 'text-green-400' : lastLogged.miss_distance < 0.3 ? 'text-yellow-300' : 'text-red-400'}>
                {lastLogged.miss_description}
              </span>
            </span>
            <button className="text-gray-500 text-xs ml-2" onClick={() => setLastLogged(null)}>✕</button>
          </div>
        )}

        {/* ── COUNT DISPLAY ── */}
        <div className="bg-gray-800 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-gray-400 font-medium uppercase tracking-wide">Count</span>
            <button className="text-xs text-gray-600 hover:text-gray-400"
              onClick={() => { setBalls(0); setStrikes(0) }}>Reset</button>
          </div>
          <div className="flex gap-4 items-center justify-center">
            {/* Balls */}
            <div className="flex-1 text-center">
              <p className="text-xs text-gray-500 mb-2">Balls</p>
              <div className="flex gap-1.5 justify-center">
                {[0,1,2,3].map(n => (
                  <button key={n} onClick={() => setBalls(n)}
                    className={`w-9 h-9 rounded-full text-sm font-bold border-2 transition ${
                      n < balls
                        ? 'bg-green-500 border-green-400 text-white'
                        : n === balls
                        ? 'bg-green-600 border-green-400 text-white ring-2 ring-green-300'
                        : 'bg-gray-700 border-gray-600 text-gray-500'
                    }`}>{n}</button>
                ))}
              </div>
            </div>

            {/* Big count display */}
            <div className="text-center px-3">
              <p className="text-4xl font-black tabular-nums tracking-tight">
                <span className="text-green-400">{balls}</span>
                <span className="text-gray-600">-</span>
                <span className="text-red-400">{strikes}</span>
              </p>
              <p className="text-xs text-gray-600 mt-0.5">B - S</p>
            </div>

            {/* Strikes */}
            <div className="flex-1 text-center">
              <p className="text-xs text-gray-500 mb-2">Strikes</p>
              <div className="flex gap-1.5 justify-center">
                {[0,1,2].map(n => (
                  <button key={n} onClick={() => setStrikes(n)}
                    className={`w-9 h-9 rounded-full text-sm font-bold border-2 transition ${
                      n < strikes
                        ? 'bg-red-500 border-red-400 text-white'
                        : n === strikes
                        ? 'bg-red-600 border-red-400 text-white ring-2 ring-red-300'
                        : 'bg-gray-700 border-gray-600 text-gray-500'
                    }`}>{n}</button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Pitch type */}
        <div>
          <label className="text-xs text-gray-400 mb-1.5 block">Pitch Type</label>
          <div className="flex flex-wrap gap-1.5">
            {PITCH_TYPES.map(pt => (
              <button key={pt} onClick={() => setPitchType(pt)}
                className={`px-3 py-1 rounded-full text-sm transition ${
                  pitchType === pt ? 'bg-indigo-600 text-white font-medium' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}>{pt}</button>
            ))}
          </div>
        </div>

        {/* Details row */}
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">MPH</label>
            <input type="number" placeholder="88"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              value={velocity} onChange={e => setVelocity(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Inning</label>
            <input type="number" placeholder="1"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              value={inning} onChange={e => setInning(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Batter</label>
            <div className="flex gap-1">
              {['L','R'].map(h => (
                <button key={h} onClick={() => setBatterHand(h)}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${
                    batterHand === h ? 'bg-indigo-600' : 'bg-gray-800 hover:bg-gray-700'
                  }`}>{h}</button>
              ))}
            </div>
          </div>
        </div>

        {/* Strike Zone */}
        <div>
          <div className="flex gap-1 mb-2">
            {['intended','actual'].map(m => (
              <button key={m} onClick={() => setZoneMode(m)}
                className={`flex-1 py-1.5 rounded-lg text-sm font-medium transition ${
                  zoneMode === m ? 'bg-indigo-600' : 'bg-gray-800 hover:bg-gray-700'
                }`}>
                {m === 'intended' ? '🎯 Target' : '⚾ Actual'}
                {m === 'intended' && intended ? ' ✓' : ''}
                {m === 'actual'   && actual   ? ' ✓' : ''}
              </button>
            ))}
          </div>
          <StrikeZone intended={intended} actual={actual} mode={zoneMode}
            onPick={(x, y) => {
              if (zoneMode === 'intended') { setIntended({ x, y }); setZoneMode('actual') }
              else setActual({ x, y })
            }}
          />
        </div>

        {/* Result */}
        <div>
          <label className="text-xs text-gray-400 mb-1.5 block">Result</label>
          <div className="flex flex-wrap gap-1.5">
            {RESULTS.map(r => (
              <button key={r} onClick={() => setResult(r)}
                className={`px-2.5 py-1 rounded-full text-xs transition ${
                  result === r ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}>{r}</button>
            ))}
          </div>
        </div>

        {/* Notes */}
        <input
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
          placeholder="Notes (optional) — e.g. bounced in dirt, batter swung early"
          value={notes}
          onChange={e => setNotes(e.target.value)}
        />

        {/* TrackMan data — collapsible optional */}
        <div>
          <button
            className="text-xs text-gray-500 hover:text-gray-400 transition flex items-center gap-1"
            onClick={() => setShowTrackman(v => !v)}
          >
            {showTrackman ? '▾' : '▸'} 📡 TrackMan data (optional)
          </button>
          {showTrackman && (
            <div className="mt-2 grid grid-cols-3 gap-2">
              <div>
                <label className="text-xs text-gray-500 block mb-1">Spin Rate (rpm)</label>
                <input
                  type="number"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-indigo-500"
                  placeholder="e.g. 2400"
                  value={spinRate}
                  onChange={e => setSpinRate(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">H-Break (in)</label>
                <input
                  type="number"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-indigo-500"
                  placeholder="e.g. 8.5"
                  value={breakH}
                  onChange={e => setBreakH(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">V-Break (in)</label>
                <input
                  type="number"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-indigo-500"
                  placeholder="e.g. -12"
                  value={breakV}
                  onChange={e => setBreakV(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        {/* Video input — clearly optional */}
        <div>
          <button className="text-xs text-gray-500 hover:text-gray-400 transition flex items-center gap-1"
            onClick={() => setShowVideo(v => !v)}>
            {showVideo ? '▲' : '▼'} Use video to set location (optional)
          </button>
          {showVideo && (
            <div className="mt-2 bg-gray-900 rounded-xl p-3 border border-gray-800 space-y-3">
              <div className="flex gap-1 bg-gray-800 p-1 rounded-lg">
                {[['upload','🎬 Upload Video'],['bullpen','⚾ Bullpen Cam'],['camera','📷 Live Camera (experimental)']].map(([mode, label]) => (
                  <button key={mode} onClick={() => setInputMode(mode)}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition ${
                      inputMode === mode ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'
                    }`}>{label}</button>
                ))}
              </div>
              {inputMode === 'upload' && (
                <VideoAnnotator onLocationPicked={pos => { setActual(pos); setZoneMode('actual') }} />
              )}
              {inputMode === 'bullpen' && (
                <BullpenCamera onLocationPicked={pos => { setActual(pos); setZoneMode('actual'); setShowVideo(false) }} />
              )}
              {inputMode === 'camera' && (
                <div className="space-y-2">
                  <p className="text-xs text-yellow-400/80 bg-yellow-900/20 border border-yellow-800 rounded-lg px-3 py-2">
                    ⚠️ Live detection works best in controlled lighting. Results may be unreliable in real bullpen conditions.
                  </p>
                  <LiveCamera onPitchDetected={pos => { setActual(pos); setZoneMode('actual'); setShowVideo(false) }} />
                </div>
              )}
            </div>
          )}
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button onClick={logPitch} disabled={logging}
          className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-xl py-3.5 font-semibold text-base transition">
          {logging ? 'Logging...' : `Log Pitch  ${balls}-${strikes}`}
        </button>

      </>}
    </div>
  )
}
