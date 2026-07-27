/**
 * Replay dispatches to the engine a match was PLAYED on.
 *
 * The bug this guards: replay used to re-derive every match on whatever engine is
 * current. After the v1 → v2 (Showdown) swap, a match played on v1 would be
 * re-run on v2, diverge, and fail its own reproduction check — silently breaking
 * the provably-fair guarantee for every historical wager.
 *
 * These play real battles on each engine, store them with the right `engine`
 * tag, and assert the replay reproduces them — and that changing the tag changes
 * what runs, so the routing is doing real work.
 */
import assert from 'node:assert'
import { createHash, randomUUID } from 'node:crypto'

process.env.DB_PATH = `/tmp/pp-replay-${randomUUID()}.db`

const v1 = await import('./battle/engine.js')
const v2 = await import('./battle/active.js') // the current engine (Showdown adapter)
await v2.dexReady
const { ALL_SPECIES } = await import('./battle/data.js')
const { db } = await import('./db.js')
const { buildReplay } = await import('./replay.js')

let passed = 0
const check = (name, fn) => {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}\n      ${e.message}`)
    process.exitCode = 1
  }
}

// v1's createBattle validates learnsets, so build from its own dex — each mon's
// first four legal moves. v2 (custom-game, no legality check) accepts them too.
// Six full attackers gives a long battle that the two engines resolve differently.
const team = () =>
  [3, 6, 9, 25, 65, 143].map((id) => {
    const sp = ALL_SPECIES.find((s) => s.id === id)
    return { speciesId: id, moves: sp.moves.slice(0, 4) }
  })

/** Drive an engine to the end the way rooms.ts does, recording the step list. */
function playAndRecord(engine, teams, seed) {
  const b = engine.createBattle([structuredClone(teams[0]), structuredClone(teams[1])], seed)
  const steps = []
  let guard = 0
  while (!b.finished && guard++ < 2000) {
    for (const side of [0, 1]) {
      if (b.pendingReplace[side]) {
        const index = b.sides[side].team.findIndex((m) => !m.fainted)
        steps.push({ k: 'replace', side, index })
        engine.replaceFainted(b, side, index)
      }
    }
    if (b.finished) break
    // v2 exposes firstLegalAction; v1 keeps moves on the team member. Only
    // matters while recording — replay just applies the recorded actions.
    const act = (side) => {
      if (typeof engine.firstLegalAction === 'function') return engine.firstLegalAction(b, side)
      const mon = b.sides[side].team[b.sides[side].active]
      const i = mon.moves.findIndex((m) => m.pp > 0)
      return { kind: 'move', index: i >= 0 ? i : 0 }
    }
    const a = [act(0), act(1)]
    steps.push({ k: 'turn', a })
    engine.resolveTurn(b, a)
  }
  return { steps, winner: b.winner }
}

/** Store a finished battle row with a given engine tag; return its id. */
function store(rec, teams, seed, engine) {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO battles
       (id, p0, p1, seed, seed_hash, winner, started_at, ended_at, p0_team, p1_team, steps, forced, engine)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    id, '0xaaaa', '0xbbbb', seed, createHash('sha256').update(seed).digest('hex'),
    rec.winner, 1, 2, JSON.stringify(teams[0]), JSON.stringify(teams[1]),
    JSON.stringify(rec.steps), engine,
  )
  return id
}

const seed = '0xrep1ayd15patchf1xture0001'
const teams = [team(), team()]

const onV1 = playAndRecord(v1, teams, seed)
const onV2 = playAndRecord(v2, teams, seed)

console.log('\nreplay engine dispatch')

// Test integrity: the two engines must actually produce different battles, or
// none of the routing below would prove anything.
check('the two engines diverge for this fixture', () => {
  const same =
    onV1.winner === onV2.winner &&
    JSON.stringify(onV1.steps) === JSON.stringify(onV2.steps)
  assert.ok(!same, 'v1 and v2 produced an identical battle — choose a less trivial fixture')
})

check('a v1 match tagged engine=1 reproduces (routed to v1)', () => {
  const r = buildReplay(store(onV1, teams, seed, 1))
  assert.ok(r, 'no replay built')
  assert.strictEqual(r.reproduced, true, 'v1 match did not reproduce on v1')
  assert.strictEqual(r.winner, onV1.winner, 'winner mismatch')
})

check('a v2 match tagged engine=2 reproduces (routed to v2)', () => {
  const r = buildReplay(store(onV2, teams, seed, 2))
  assert.ok(r, 'no replay built')
  assert.strictEqual(r.reproduced, true, 'v2 match did not reproduce on v2')
  assert.strictEqual(r.winner, onV2.winner, 'winner mismatch')
})

check('a legacy row (engine=null) still reproduces via fallback', () => {
  // A row from before the engine column existed: replay tries the current engine,
  // then the frozen one, and accepts whichever reproduces. This one was v1.
  const r = buildReplay(store(onV1, teams, seed, null))
  assert.ok(r, 'no replay built')
  assert.strictEqual(r.reproduced, true, 'legacy v1 match did not reproduce via fallback')
})

check('the engine tag actually changes what replay runs', () => {
  // The SAME v1 battle, tagged v1 vs v2. Routing to the wrong engine must produce
  // a different (diverged or truncated) playback — proving the tag is load-bearing
  // and not decoration. This is the exact misroute the old code always did.
  const asV1 = buildReplay(store(onV1, teams, seed, 1))
  const asV2 = buildReplay(store(onV1, teams, seed, 2))
  const differ =
    asV1.reproduced !== asV2.reproduced ||
    asV1.turns.length !== asV2.turns.length ||
    JSON.stringify(asV1.turns) !== JSON.stringify(asV2.turns)
  assert.ok(differ, 'routing a v1 battle through v2 produced the same replay — tag is not being used')
  // And the honest outcome: the v1 battle does NOT cleanly reproduce on v2.
  assert.strictEqual(asV2.reproduced, false, 'a v1 battle unexpectedly reproduced on v2')
})

console.log(`\n${passed} replay dispatch checks passed`)
