/**
 * End-to-end test against a live server process: sign in with a real wallet
 * signature, save teams, post and accept a wager, then play a full battle over
 * the websocket until someone wins.
 *
 * Run with `npm run test:e2e` (the script boots a server on a scratch DB).
 */
import assert from 'node:assert'
import { toHex } from 'viem'
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
import WebSocket from 'ws'

// anvil's public test accounts, derived from its standard mnemonic rather than
// hard-coded, so no literal private key sits in the repo. Worthless keys, funded
// only on a local test node — never a real one.
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'
const anvilKey = (index: number) =>
  toHex(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }).getHdKey().privateKey!)

const BASE = process.env.BASE ?? 'http://127.0.0.1:8099'
const WS = BASE.replace('http', 'ws')

/**
 * The species list as the LIVE server serves it, so a saved team is built from
 * exactly the moves the client would be offered and the server would accept.
 * Importing a dex module directly bound the test to one engine's learnsets —
 * which broke the moment validation moved to another (v1 offered Charizard
 * ancient-power; Showdown does not).
 */
const ALL_SPECIES: { id: number; name: string; moves: string[] }[] =
  (await (await fetch(`${BASE}/api/pokedex`)).json()).species

let passed = 0
const check = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn()
    passed++
    console.log(`✓ ${name}`)
  } catch (e) {
    console.error(`✗ ${name}\n  ${(e as Error).message}`)
    process.exitCode = 1
  }
}

const api = async (path: string, opts: RequestInit = {}) => {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

/** Full wallet login flow with a real secp256k1 signature. */
async function login(pk: `0x${string}`) {
  const account = privateKeyToAccount(pk)
  const { body: n } = await api('/api/auth/nonce', {
    method: 'POST',
    body: JSON.stringify({ address: account.address }),
  })
  const signature = await account.signMessage({ message: n.message })
  const { body: v } = await api('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ address: account.address, nonce: n.nonce, signature }),
  })
  assert.ok(v.token, `login failed: ${JSON.stringify(v)}`)
  return { token: v.token as string, address: account.address.toLowerCase() }
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

/** A legal 6-mon team of reasonably fast attackers so battles end quickly. */
function makeTeam() {
  const picks = ['pikachu', 'charizard', 'blastoise', 'venusaur', 'alakazam', 'snorlax']
  return picks.map((name) => {
    const sp = ALL_SPECIES.find((s) => s.name === name)!
    return { speciesId: sp.id, moves: sp.moves.slice(0, 4) }
  })
}

const A = anvilKey(1)
const B = anvilKey(5)

await check('unauthenticated requests are rejected', async () => {
  const r = await api('/api/teams')
  assert.strictEqual(r.status, 401)
})

const alice = await login(A)
const bob = await login(B)

await check('login returns distinct sessions', () => {
  assert.notStrictEqual(alice.token, bob.token)
  assert.notStrictEqual(alice.address, bob.address)
})

await check('a nonce cannot be reused', async () => {
  const account = privateKeyToAccount(A)
  const { body: n } = await api('/api/auth/nonce', {
    method: 'POST',
    body: JSON.stringify({ address: account.address }),
  })
  const signature = await account.signMessage({ message: n.message })
  const first = await api('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ address: account.address, nonce: n.nonce, signature }),
  })
  assert.strictEqual(first.status, 200)
  const second = await api('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ address: account.address, nonce: n.nonce, signature }),
  })
  assert.strictEqual(second.status, 401, 'nonce replay accepted')
})

await check("a signature from the wrong key is rejected", async () => {
  const victim = privateKeyToAccount(A)
  const attacker = privateKeyToAccount(B)
  const { body: n } = await api('/api/auth/nonce', {
    method: 'POST',
    body: JSON.stringify({ address: victim.address }),
  })
  // Attacker signs the victim's message with their own key.
  const signature = await attacker.signMessage({ message: n.message })
  const r = await api('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ address: victim.address, nonce: n.nonce, signature }),
  })
  assert.strictEqual(r.status, 401, 'accepted a forged signature')
})

let aliceTeam = 0
let bobTeam = 0

await check('teams save', async () => {
  const r1 = await api('/api/teams', {
    method: 'POST', headers: auth(alice.token),
    body: JSON.stringify({ name: 'Alice', slots: makeTeam() }),
  })
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.body))
  aliceTeam = r1.body.id

  const r2 = await api('/api/teams', {
    method: 'POST', headers: auth(bob.token),
    body: JSON.stringify({ name: 'Bob', slots: makeTeam() }),
  })
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.body))
  bobTeam = r2.body.id
})

await check('illegal teams are refused by the API', async () => {
  const bad = [
    makeTeam().slice(0, 5),
    makeTeam().map((s) => ({ ...s, speciesId: 900 })),
    makeTeam().map((s) => ({ ...s, moves: ['hyper-beam'] })),
    makeTeam().map((s) => ({ speciesId: 25, moves: ['sludge-bomb'] })),
  ]
  for (const slots of bad) {
    const r = await api('/api/teams', {
      method: 'POST', headers: auth(alice.token),
      body: JSON.stringify({ name: 'cheat', slots }),
    })
    assert.strictEqual(r.status, 400, `accepted illegal team: ${JSON.stringify(slots[0])}`)
  }
})

await check("a player cannot use another player's team", async () => {
  const r = await api('/api/wagers', {
    method: 'POST', headers: auth(bob.token),
    body: JSON.stringify({ teamId: aliceTeam, stakeWei: '0' }),
  })
  assert.strictEqual(r.status, 400, "accepted someone else's team")
})

await check('a paid wager without an on-chain id is refused', async () => {
  const r = await api('/api/wagers', {
    method: 'POST', headers: auth(alice.token),
    body: JSON.stringify({ teamId: aliceTeam, stakeWei: '1000000000000000000' }),
  })
  assert.strictEqual(r.status, 400, 'accepted an unbacked paid wager')
})

let wagerId = 0

await check('a free wager can be posted and appears on the board', async () => {
  const r = await api('/api/wagers', {
    method: 'POST', headers: auth(alice.token),
    body: JSON.stringify({ teamId: aliceTeam, stakeWei: '0' }),
  })
  assert.strictEqual(r.status, 200, JSON.stringify(r.body))
  wagerId = r.body.id

  const board = await api('/api/wagers')
  assert.ok(
    (board.body as { id: number }[]).some((w) => w.id === wagerId),
    'wager missing from board',
  )
})

await check('you cannot accept your own wager', async () => {
  const r = await api(`/api/wagers/${wagerId}/accept`, {
    method: 'POST', headers: auth(alice.token),
    body: JSON.stringify({ teamId: aliceTeam }),
  })
  assert.strictEqual(r.status, 400)
})

let roomId = ''

await check('accepting a wager starts a battle', async () => {
  const r = await api(`/api/wagers/${wagerId}/accept`, {
    method: 'POST', headers: auth(bob.token),
    body: JSON.stringify({ teamId: bobTeam }),
  })
  assert.strictEqual(r.status, 200, JSON.stringify(r.body))
  roomId = r.body.roomId
  assert.ok(roomId)
})

await check('the same wager cannot be accepted twice', async () => {
  const r = await api(`/api/wagers/${wagerId}/accept`, {
    method: 'POST', headers: auth(bob.token),
    body: JSON.stringify({ teamId: bobTeam }),
  })
  assert.ok(r.status >= 400, 'double accept succeeded')
})

/* ---------------- play the battle over websocket ---------------- */

type Msg = Record<string, unknown>

function connect(token: string) {
  const sock = new WebSocket(`${WS}/ws?token=${token}`)
  const queue: Msg[] = []
  const waiters: ((m: Msg) => void)[] = []

  sock.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as Msg
    const w = waiters.shift()
    if (w) w(m)
    else queue.push(m)
  })

  const next = (): Promise<Msg> =>
    queue.length ? Promise.resolve(queue.shift()!) : new Promise((r) => waiters.push(r))

  const until = async (type: string, limit = 400): Promise<Msg> => {
    for (let i = 0; i < limit; i++) {
      const m = await next()
      if (m.type === type) return m
    }
    throw new Error(`never received "${type}"`)
  }

  return {
    sock, next, until,
    open: new Promise<void>((r, j) => {
      sock.on('open', () => r())
      sock.on('error', j)
    }),
    send: (m: unknown) => sock.send(JSON.stringify(m)),
  }
}

await check('a stranger cannot connect to the battle socket', async () => {
  const carol = await login('0x' + 'c'.repeat(63) + '1' as `0x${string}`)
  const c = connect(carol.token)
  await c.open
  const m = await c.until('error')
  assert.match(String(m.error), /no active battle/)
  c.sock.close()
})

const wsA = connect(alice.token)
const wsB = connect(bob.token)
await Promise.all([wsA.open, wsB.open])

await check('both players receive the seed commitment on connect', async () => {
  const a = await wsA.until('hello')
  const b = await wsB.until('hello')
  assert.ok(a.seedHash, 'no seed hash')
  assert.strictEqual(a.seedHash, b.seedHash, 'players got different commitments')
  assert.notStrictEqual(a.you, b.you, 'both players got the same seat')
})

await check('the server rejects a malformed action', async () => {
  wsA.send({ type: 'action', action: { kind: 'move', index: 99 } })
  const m = await wsA.until('error')
  assert.ok(m.error, 'no error for out-of-range move')
})

await check('a full battle plays to completion and produces a winner', async () => {
  let ended: Msg | null = null
  let guard = 0

  const play = async (c: ReturnType<typeof connect>) => {
    while (!ended && guard < 4000) {
      guard++
      const m = await c.next()
      if (m.type === 'ended') { ended = m; return }
      if (m.type !== 'state') continue

      const st = m.state as {
        finished: boolean
        mustReplace: boolean
        you: { active: number; team: { fainted: boolean; moves: { pp: number }[] }[] }
      }
      if (st.finished) continue

      if (st.mustReplace) {
        const idx = st.you.team.findIndex((t) => !t.fainted)
        if (idx >= 0) c.send({ type: 'action', action: { kind: 'switch', index: idx } })
        continue
      }
      const active = st.you.team[st.you.active]
      const move = active.moves.findIndex((mv) => mv.pp > 0)
      c.send({ type: 'action', action: { kind: 'move', index: move >= 0 ? move : 0 } })
    }
  }

  await Promise.race([
    Promise.all([play(wsA), play(wsB)]),
    new Promise((_, rej) => setTimeout(() => rej(new Error('battle timed out')), 60_000)),
  ])

  assert.ok(ended, 'battle never ended')
  const e = ended as Msg
  assert.ok(e.winner === 0 || e.winner === 1 || e.winner === null, `bad winner ${e.winner}`)
  // The seed is only revealed once the match is over.
  assert.ok(e.seed, 'seed not revealed at the end')

  const { createHash } = await import('node:crypto')
  const check = createHash('sha256').update(String(e.seed)).digest('hex')
  assert.strictEqual(check, e.seedHash, 'revealed seed does not match the commitment')
})

wsA.sock.close()
wsB.sock.close()

await check('the result lands on both personal records', async () => {
  // The running totals on the user are the honest personal record and are
  // updated immediately, whatever the leaderboard chooses to rank.
  const a = await api('/api/me', { headers: auth(alice.token) })
  const b = await api('/api/me', { headers: auth(bob.token) })
  const total =
    a.body.wins + a.body.losses + a.body.draws + b.body.wins + b.body.losses + b.body.draws
  assert.strictEqual(total, 2, `records did not move: ${JSON.stringify([a.body, b.body])}`)
  const winners = [a.body, b.body].filter((x) => x.wins > 0)
  assert.strictEqual(winners.length, 1, 'expected exactly one winner')
})

await check('a single match against one opponent does not rank anyone', async () => {
  // Anti-farming: ranking needs several DISTINCT opponents, so two accounts
  // trading wins never reach the board.
  const { body: rules } = await api('/api/leaderboard/rules')
  const { body: rows } = await api('/api/leaderboard')
  assert.ok(Array.isArray(rows), 'leaderboard did not return a list')
  assert.strictEqual(
    rows.length, 0,
    `two players with one opponent each were ranked (min is ${rules.minOpponents})`,
  )
})

await check('battle seed is readable after the match, for replay', async () => {
  const r = await api(`/api/battle/${roomId}`)
  assert.strictEqual(r.status, 200)
  assert.ok(r.body.seed, 'seed withheld after the match ended')
})

await check('a hidden wallet stays hidden on the public replay and battle view', async () => {
  // Alice turns on "Hide my wallet". Bob does not.
  const priv = await api('/api/me/privacy', {
    method: 'POST',
    headers: auth(alice.token),
    body: JSON.stringify({ hideWallet: true }),
  })
  assert.strictEqual(priv.status, 200)
  assert.strictEqual(priv.body.hideWallet, true)

  const bothSides = (body: { p0: string | null; p1: string | null }) =>
    `${body.p0 ?? ''} ${body.p1 ?? ''}`.toLowerCase()

  // A replay link is public and shareable — alice's address must not be in it,
  // while bob's still is, and alice is still identifiable by her hidden flag.
  const replay = await api(`/api/replay/${roomId}`)
  assert.strictEqual(replay.status, 200)
  const rBlob = bothSides(replay.body)
  assert.ok(!rBlob.includes(alice.address), 'a hidden wallet leaked on the replay')
  assert.ok(rBlob.includes(bob.address), "the visible player's address went missing")
  const aliceSide = replay.body.p0 === null || replay.body.p0Hidden ? 0 : 1
  assert.strictEqual(
    aliceSide === 0 ? replay.body.p0Hidden : replay.body.p1Hidden, true,
    'the hidden player was not flagged as hidden',
  )

  // The raw, unauthenticated battle view must withhold it too.
  const battle = await api(`/api/battle/${roomId}`)
  assert.strictEqual(battle.status, 200)
  assert.ok(!bothSides(battle.body).includes(alice.address), 'a hidden wallet leaked on /api/battle')

  // Undo, so this test does not colour anything that runs after it.
  await api('/api/me/privacy', {
    method: 'POST',
    headers: auth(alice.token),
    body: JSON.stringify({ hideWallet: false }),
  })
})

console.log(`\n${passed} integration checks passed${process.exitCode ? ' (with failures)' : ''}`)
process.exit(process.exitCode ?? 0)
