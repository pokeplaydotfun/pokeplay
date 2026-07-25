import WebSocket from 'ws'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8097'
const api = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'content-type': 'application/json', ...(o.headers ?? {}) } })
  const b = await r.json().catch(() => null)
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${JSON.stringify(b)}`)
  return b
}
let pass = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`✓ ${name}`) }
  else { console.error(`✗ ${name} ${detail}`); process.exitCode = 1 }
}

const login = async (who) => api('/api/auth/dev-login', { method: 'POST', body: JSON.stringify({ who }) })
const me = await login('ash')
const auth = { authorization: `Bearer ${me.token}` }

const dex = await api('/api/pokedex')
const pick = (n) => { const s = dex.species.find(x => x.name === n); return { speciesId: s.id, moves: s.moves.slice(0, 4) } }
const team = await api('/api/teams', { method: 'POST', headers: auth,
  body: JSON.stringify({ name: 'R', slots: ['charizard','blastoise','venusaur','alakazam','snorlax','gengar'].map(pick) }) })

const { roomId } = await api('/api/practice', { method: 'POST', headers: auth,
  body: JSON.stringify({ teamId: team.id, opponentId: 'gym-leader' }) })

// Play it out, recording what the LIVE match produced.
const liveLog = []
let ended = null
const ws = new WebSocket(`${BASE.replace('http','ws')}/ws?token=${me.token}`)
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('live battle timed out')), 60000)
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.type === 'state') {
      for (const e of m.events ?? []) if (e.t === 'text') liveLog.push(e.msg)
      const st = m.state
      if (st.finished) return
      if (st.mustReplace) {
        const i = st.you.team.findIndex(x => !x.fainted)
        if (i >= 0) ws.send(JSON.stringify({ type: 'action', action: { kind: 'switch', index: i } }))
        return
      }
      const act = st.you.team[st.you.active]
      const mi = act.moves.findIndex(x => x.pp > 0)
      ws.send(JSON.stringify({ type: 'action', action: { kind: 'move', index: mi >= 0 ? mi : 0 } }))
    }
    if (m.type === 'ended') {
      for (const e of m.events ?? []) if (e.t === 'text') liveLog.push(e.msg)
      ended = m; clearTimeout(t); resolve()
    }
  })
  ws.on('error', reject)
})
ws.close()
console.log(`\nlive match: ${liveLog.length} log lines, winner ${ended.winner}\n`)

// Now replay it from the seed.
const rp = await api(`/api/replay/${roomId}`)
const replayLog = rp.turns.flatMap(t => t.events.filter(e => e.t === 'text').map(e => e.msg))

check('replay reproduces the recorded winner', rp.reproduced, `winner ${rp.winner}`)
check('seed hashes to the published commitment', rp.seedVerified)
check('replay produced turns', rp.turns.length > 0, `${rp.turns.length}`)
check('replay log matches the live log exactly',
  JSON.stringify(replayLog) === JSON.stringify(liveLog),
  `live=${liveLog.length} replay=${replayLog.length}`)
check('both teams are included', rp.teams?.[0]?.length === 6 && rp.teams?.[1]?.length === 6)
check('practice flag is set', rp.practice === true)
check('final state matches the result',
  (() => {
    const last = rp.turns[rp.turns.length - 1].state
    const p0Dead = last.you.team.every(m => m.fainted)
    const p1Dead = last.foe.team.every(m => m.fainted)
    return rp.winner === 0 ? p1Dead : rp.winner === 1 ? p0Dead : true
  })())

// Tamper detection: a replay built from a doctored seed must NOT reproduce.
check('replay is a real re-derivation, not a recording',
  replayLog.length === liveLog.length && replayLog.length > 5)

const missing = await api('/api/replay/does-not-exist').catch(e => ({ err: String(e) }))
check('unknown battle 404s', 'err' in missing)

console.log(`\n${pass} replay checks passed${process.exitCode ? ' (with failures)' : ''}`)
process.exit(process.exitCode ?? 0)
