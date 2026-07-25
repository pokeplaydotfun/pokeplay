/**
 * Bracket maths.
 *
 * Runs a whole tournament to completion for every size from 2 to 64 and
 * asserts exactly one winner emerges, nobody plays twice in a round, and
 * nobody is silently dropped. Odd sizes and byes are where brackets go wrong.
 */
import assert from 'node:assert'
import {
  advancesTo, autoWinner, bracketSize, firstRound, fullBracket, laterRounds, roundsFor,
} from './bracket.js'

let passed = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`✓ ${name}`) } catch (e) {
    console.error(`✗ ${name}\n  ${e.message}`)
    process.exitCode = 1
  }
}

const seeds = (n) =>
  Array.from({ length: n }, (_, i) => ({ address: `0x${String(i + 1).padStart(40, '0')}`, teamId: i + 1 }))

check('bracket size rounds up to a power of two', () => {
  assert.strictEqual(bracketSize(2), 2)
  assert.strictEqual(bracketSize(3), 4)
  assert.strictEqual(bracketSize(5), 8)
  assert.strictEqual(bracketSize(8), 8)
  assert.strictEqual(bracketSize(9), 16)
  assert.strictEqual(roundsFor(8), 3)
  assert.strictEqual(roundsFor(5), 3)
})

check('fewer than two players makes no bracket', () => {
  assert.deepStrictEqual(firstRound(seeds(0)), [])
  assert.deepStrictEqual(firstRound(seeds(1)), [])
})

check('every player appears exactly once in round one', () => {
  for (let n = 2; n <= 64; n++) {
    const r1 = firstRound(seeds(n))
    const placed = r1.flatMap((m) => [m.p0, m.p1]).filter(Boolean)
    assert.strictEqual(placed.length, n, `n=${n} placed ${placed.length}`)
    assert.strictEqual(new Set(placed).size, n, `n=${n} placed someone twice`)
  }
})

check('byes only ever go to one side of a match', () => {
  for (let n = 2; n <= 64; n++) {
    for (const m of firstRound(seeds(n))) {
      if (m.bye) {
        assert.ok(
          (m.p0 && !m.p1) || (!m.p0 && m.p1),
          `n=${n} bye match had ${JSON.stringify([m.p0, m.p1])}`,
        )
      }
      // A match with nobody in it should not exist in round one.
      assert.ok(m.p0 || m.p1, `n=${n} produced an empty round-one match`)
    }
  }
})

check('the number of byes is exactly the padding', () => {
  for (let n = 2; n <= 64; n++) {
    const byes = firstRound(seeds(n)).filter((m) => m.bye).length
    assert.strictEqual(byes, bracketSize(n) - n, `n=${n}`)
  }
})

check('the full bracket has one match fewer than the bracket size', () => {
  for (let n = 2; n <= 64; n++) {
    const all = fullBracket(seeds(n))
    assert.strictEqual(all.length, bracketSize(n) - 1, `n=${n} had ${all.length} matches`)
    const finals = all.filter((m) => m.round === roundsFor(n))
    assert.strictEqual(finals.length, 1, `n=${n} had ${finals.length} finals`)
  }
})

check('later rounds start empty and are correctly sized', () => {
  const later = laterRounds(8)
  assert.strictEqual(later.filter((m) => m.round === 2).length, 2)
  assert.strictEqual(later.filter((m) => m.round === 3).length, 1)
  assert.ok(later.every((m) => m.p0 === null && m.p1 === null))
})

check('winners feed the right side of the right match', () => {
  // Slots 0 and 1 in round 1 both feed slot 0 of round 2, on opposite sides.
  assert.deepStrictEqual(advancesTo(1, 0, 8), { round: 2, slot: 0, side: 'p0' })
  assert.deepStrictEqual(advancesTo(1, 1, 8), { round: 2, slot: 0, side: 'p1' })
  assert.deepStrictEqual(advancesTo(1, 2, 8), { round: 2, slot: 1, side: 'p0' })
  assert.deepStrictEqual(advancesTo(2, 0, 8), { round: 3, slot: 0, side: 'p0' })
  // The final advances nowhere.
  assert.strictEqual(advancesTo(3, 0, 8), null)
})

check('a bye needs no battle and advances its player', () => {
  assert.strictEqual(autoWinner({ p0: 'a', p1: null }), 'a')
  assert.strictEqual(autoWinner({ p0: null, p1: 'b' }), 'b')
  assert.strictEqual(autoWinner({ p0: 'a', p1: 'b' }), null)
})

/* ---- the real test: play every bracket to completion ---- */

check('every size from 2 to 64 produces exactly one champion', () => {
  for (let n = 2; n <= 64; n++) {
    const order = seeds(n)
    const matches = fullBracket(order)
    const key = (r, s) => `${r}:${s}`
    const byKey = new Map(matches.map((m) => [key(m.round, m.slot), m]))
    const rounds = roundsFor(n)
    const played = []

    for (let round = 1; round <= rounds; round++) {
      const inRound = matches.filter((m) => m.round === round)
      const seenThisRound = new Set()

      for (const m of inRound) {
        // Deterministic: the lower-numbered address always wins.
        const winner = autoWinner(m) ?? [m.p0, m.p1].filter(Boolean).sort()[0]
        assert.ok(winner, `n=${n} round ${round} slot ${m.slot} had nobody`)

        for (const p of [m.p0, m.p1].filter(Boolean)) {
          assert.ok(!seenThisRound.has(p), `n=${n} ${p} played twice in round ${round}`)
          seenThisRound.add(p)
        }
        if (m.p0 && m.p1) played.push(winner)

        const next = advancesTo(round, m.slot, n)
        if (next) {
          const target = byKey.get(key(next.round, next.slot))
          assert.ok(target, `n=${n} winner had nowhere to go`)
          target[next.side] = winner
        } else {
          assert.strictEqual(round, rounds, `n=${n} final was not the last round`)
          // The overall winner is the best seed, since lower addresses win.
          assert.strictEqual(winner, order[0].address, `n=${n} wrong champion`)
        }
      }
    }

    // A single-elimination bracket needs exactly n-1 decisive results.
    assert.strictEqual(played.length, n - 1, `n=${n} played ${played.length} real matches`)
  }
})

check('a bye in a later round can never happen once the bracket is full', () => {
  // Byes exist only because round one is padded. After that every slot is fed
  // by a real match, so a later-round match must always have two players.
  for (let n = 2; n <= 64; n++) {
    const order = seeds(n)
    const matches = fullBracket(order)
    const byKey = new Map(matches.map((m) => [`${m.round}:${m.slot}`, m]))
    for (let round = 1; round <= roundsFor(n); round++) {
      for (const m of matches.filter((x) => x.round === round)) {
        if (round > 1) {
          assert.ok(m.p0 && m.p1, `n=${n} round ${round} slot ${m.slot} was short a player`)
        }
        const winner = autoWinner(m) ?? [m.p0, m.p1].filter(Boolean).sort()[0]
        const next = advancesTo(round, m.slot, n)
        if (next) byKey.get(`${next.round}:${next.slot}`)[next.side] = winner
      }
    }
  }
})

console.log(`\n${passed} bracket checks passed${process.exitCode ? ' (with failures)' : ''}`)
process.exit(process.exitCode ?? 0)
