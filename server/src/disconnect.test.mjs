/**
 * Disconnect rules. The point of these is that quitting must never be a way
 * out of a losing position — and that a match which never started is not
 * awarded to anyone.
 */
import WebSocket from 'ws'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8096'
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

const login = (who) => api('/api/auth/dev-login', { method: 'POST', body: JSON.stringify({ who }) })
const dex = await api('/api/pokedex')
const pick = (n) => { const s = dex.species.find(x => x.name === n); return { speciesId: s.id, moves: s.moves.slice(0, 4) } }
const TEAM = ['charizard','blastoise','venusaur','alakazam','snorlax','gengar'].map(pick)

async function startMatch(aName, bName) {
  const a = await login(aName), b = await login(bName)
  const A = { authorization: `Bearer ${a.token}` }, B = { authorization: `Bearer ${b.token}` }
  const ta = await api('/api/teams', { method: 'POST', headers: A, body: JSON.stringify({ name: 'A', slots: TEAM }) })
  const tb = await api('/api/teams', { method: 'POST', headers: B, body: JSON.stringify({ name: 'B', slots: TEAM }) })
  const w = await api('/api/wagers', { method: 'POST', headers: A, body: JSON.stringify({ teamId: ta.id, stakeWei: '0' }) })
  const { roomId } = await api(`/api/wagers/${w.id}/accept`, { method: 'POST', headers: B, body: JSON.stringify({ teamId: tb.id }) })
  return { a, b, roomId }
}

const connect = (token) => {
  const ws = new WebSocket(`${BASE.replace('http','ws')}/ws?token=${token}`)
  const msgs = []
  ws.on('message', (raw) => msgs.push(JSON.parse(String(raw))))
  return { ws, msgs, ready: new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) }) }
}
const waitFor = async (c, type, ms = 45000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const m = c.msgs.find(x => x.type === type)
    if (m) return m
    await new Promise(r => setTimeout(r, 200))
  }
  return null
}
/** The most recent message of a type — `waitFor` returns the first, which
 *  goes stale as soon as another state arrives. */
const latest = (c, type) => [...c.msgs].reverse().find(x => x.type === type)

const playOneTurn = async (c) => {
  const st = await waitFor(c, 'state')
  const active = st.state.you.team[st.state.you.active]
  const mi = active.moves.findIndex(m => m.pp > 0)
  c.ws.send(JSON.stringify({ type: 'action', action: { kind: 'move', index: mi >= 0 ? mi : 0 } }))
}

/* ---- 1. quitting mid-match is a LOSS, not a refund ---- */
{
  const { a, b, roomId } = await startMatch('ash', 'gary')
  const A = connect(a.token), B = connect(b.token)
  await Promise.all([A.ready, B.ready])

  // Play a real turn so the match has genuinely started.
  await playOneTurn(A); await playOneTurn(B)
  await new Promise(r => setTimeout(r, 1200))

  const notice = latest(B, 'state')
  check('a turn resolved before the disconnect', notice.state.turn >= 1, `turn ${notice.state.turn}`)

  // Ash rage-quits.
  A.ws.close()
  const gone = await waitFor(B, 'opponentGone', 8000)
  check('opponent is told the quitter has gone', !!gone)
  check('countdown does NOT promise a void mid-match', gone && gone.voidsMatch === false)

  const ended = await waitFor(B, 'ended', 45000)
  B.ws.close()
  check('the quitter forfeits — opponent wins', ended && ended.youWon === true,
    ended ? `winner=${ended.winner} youWon=${ended.youWon}` : 'never ended')
  check('the result is a win, not a draw/refund', ended && ended.winner !== null)

  const rec = await api(`/api/replay/${roomId}`).catch(() => null)
  check('forfeit is recorded as forced', rec ? rec.forced === true : false)
}

/* ---- 2. connecting, seeing the matchup, then quitting is STILL a loss ---- */
{
  // The exploit this guards against: peek at the opponent's lead, dislike the
  // matchup, quit before turn 1 resolves, get your stake back and reroll.
  const { a, b } = await startMatch('brock', 'misty')
  const A = connect(a.token), B = connect(b.token)
  await Promise.all([A.ready, B.ready])
  await waitFor(A, 'state')
  await waitFor(B, 'state')

  // Brock has seen the board but nobody has moved. He bails.
  A.ws.close()
  const gone = await waitFor(B, 'opponentGone', 8000)
  check('quitting after connecting is not flagged as a void', gone && gone.voidsMatch === false)

  const ended = await waitFor(B, 'ended', 45000)
  B.ws.close()
  check('peeking then quitting forfeits — no free reroll',
    ended && ended.youWon === true, ended ? `winner=${ended.winner}` : 'never ended')
}

/* ---- 3. a player who never connects voids the match ---- */
{
  const { b } = await startMatch('ash', 'misty')
  // Only one side ever opens a socket; the other never shows up.
  const B = connect(b.token)
  await B.ready
  await waitFor(B, 'state')

  const ended = await waitFor(B, 'ended', 45000)
  B.ws.close()
  check('a no-show voids the match as a draw',
    ended && ended.winner === null, ended ? `winner=${ended.winner}` : 'never ended')
}

console.log(`\n${pass} disconnect checks passed${process.exitCode ? ' (with failures)' : ''}`)
process.exit(process.exitCode ?? 0)
