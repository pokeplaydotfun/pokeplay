/**
 * Checks the practice AI plays sensibly and — critically — that it never
 * touches the battle's RNG, which would break replay verification.
 */
import assert from 'node:assert'
import { chooseAction } from './ai.js'

import {
  createBattle, resolveTurn, validateAction, estimateDamage, makeRng,
  type Battle, type TeamSlot,
} from './engine.js'
import { MOVES, SPECIES_BY_NAME, ALL_SPECIES } from './data.js'

/**
 * A v1-legal six built straight from v1's own dex.
 *
 * This used to borrow a practice preset, but those are now built against the
 * live (v2) dex and only exist after it loads asynchronously. v1's tests must
 * not depend on v2 being ready, so the team is assembled here from whatever
 * v1 itself considers legal.
 */
function v1Team(names: string[]): TeamSlot[] {
  return names.map((n) => {
    const sp = SPECIES_BY_NAME.get(n)
    if (!sp) throw new Error(`v1 dex has no ${n}`)
    return {
      speciesId: sp.id,
      moves: sp.moves.slice(0, 4),
      nature: 'serious',
      ability: sp.abilities[0]?.name,
    }
  })
}

let passed = 0
const check = (name: string, fn: () => void) => {
  try {
    fn()
    passed++
  } catch (e) {
    console.error(`✗ ${name}\n  ${(e as Error).message}`)
    process.exitCode = 1
  }
}

const mon = (name: string, moves: string[], extra: Partial<TeamSlot> = {}): TeamSlot => {
  const sp = SPECIES_BY_NAME.get(name)!
  const legal = moves.filter((m) => sp.moves.includes(m))
  assert.ok(legal.length > 0, `${name} cannot learn any of ${moves.join(',')}`)
  return { speciesId: sp.id, moves: legal, ...extra }
}

/* ---------------- move choice ---------------- */

check('picks the super-effective move over a neutral one', () => {
  // Blastoise vs Charizard: Surf (4x-ish into Fire/Flying) beats Body Slam.
  const b = createBattle(
    [[mon('blastoise', ['surf', 'body-slam'])], [mon('charizard', ['flamethrower'])]],
    'aaaa1111',
  )
  const a = chooseAction(b, 0, 'normal', () => 0.99)
  assert.strictEqual(a.kind, 'move')
  const chosen = b.sides[0].team[0].moves[(a as { index: number }).index].name
  assert.strictEqual(chosen, 'surf', `chose ${chosen}`)
})

check('does not use a move the target is immune to', () => {
  // Gengar is immune to Normal. Lick (Ghost) is the only thing that connects.
  const b = createBattle(
    [[mon('snorlax', ['body-slam', 'earthquake'])], [mon('gengar', ['shadow-ball'])]],
    'bbbb2222',
  )
  const a = chooseAction(b, 0, 'normal', () => 0.99)
  const chosen = b.sides[0].team[0].moves[(a as { index: number }).index].name
  // Earthquake also fails into Flying-less Ghost? No — Ground hits Ghost fine.
  assert.strictEqual(chosen, 'earthquake', `chose ${chosen} (Normal is 0x into Ghost)`)
})

check('takes a guaranteed KO when one is available', () => {
  const b = createBattle(
    [[mon('alakazam', ['psychic', 'calm-mind'])], [mon('machamp', ['cross-chop'])]],
    'cccc3333',
  )
  // Leave the foe on a sliver so any hit finishes it.
  b.sides[1].team[0].hp = 1
  const a = chooseAction(b, 0, 'normal', () => 0.99)
  const chosen = b.sides[0].team[0].moves[(a as { index: number }).index].name
  assert.strictEqual(chosen, 'psychic', `chose ${chosen} instead of the KO`)
})

/* ---------------- legality ---------------- */

check('every action the AI returns is legal', () => {
  const rng = makeRng('d00dfeed')
  for (let g = 0; g < 40; g++) {
    const pick = (): TeamSlot => {
      const legal = ALL_SPECIES.filter((s) => s.moves.length >= 1)
      const sp = legal[Math.floor(rng() * legal.length)]
      return { speciesId: sp.id, moves: [...sp.moves].sort(() => rng() - 0.5).slice(0, 4) }
    }
    const team = (): TeamSlot[] => Array.from({ length: 6 }, pick)
    const b = createBattle([team(), team()], (0x9990000 + g).toString(16))

    let turns = 0
    while (!b.finished && turns < 400) {
      turns++
      for (const side of [0, 1] as const) {
        if (b.pendingReplace[side]) {
          const a = chooseAction(b, side, 'normal', rng)
          assert.strictEqual(a.kind, 'switch', 'must switch when replacing')
          const t = b.sides[side].team[a.index]
          assert.ok(t && !t.fainted, 'AI chose a fainted replacement')
          b.sides[side].active = a.index
          b.pendingReplace[side] = false
        }
      }
      if (b.finished) break
      const a0 = chooseAction(b, 0, 'normal', rng)
      const a1 = chooseAction(b, 1, 'easy', rng)
      for (const [side, a] of [[0, a0], [1, a1]] as const) {
        const err = validateAction(b, side, a)
        assert.strictEqual(err, null, `illegal AI action on side ${side}: ${err}`)
      }
      resolveTurn(b, [a0, a1])
    }
    assert.ok(b.finished, `AI battle ${g} did not finish in ${turns} turns`)
  }
})

/* ---------------- determinism / seed safety ---------------- */

check('the AI never consumes the battle RNG', () => {
  // Advancing the AI must not change what the engine rolls next. If the AI
  // drew from battle.rng, the seed commitment would stop matching the replay.
  const team: [TeamSlot[], TeamSlot[]] = [
    [mon('charizard', ['flamethrower', 'earthquake'])],
    [mon('blastoise', ['surf', 'ice-beam'])],
  ]
  const run = (callAi: boolean) => {
    const b = createBattle([structuredClone(team[0]), structuredClone(team[1])], 'seed0seed')
    if (callAi) {
      // Hammer the AI before the turn resolves.
      for (let i = 0; i < 25; i++) chooseAction(b, 1, 'normal', Math.random)
    }
    resolveTurn(b, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
    return `${b.sides[0].team[0].hp}/${b.sides[1].team[0].hp}`
  }
  assert.strictEqual(run(false), run(true), 'AI calls changed the battle RNG stream')
})

/* ---------------- difficulty ---------------- */

check('normal beats easy over a long series', () => {
  let normalWins = 0
  const rng = makeRng('12345678')
  // Same team on both sides, so only decision quality differs.
  const elite = v1Team(['alakazam', 'gengar', 'jolteon', 'dragonite', 'starmie', 'mewtwo'])
  const teamA = elite
  const teamB = elite

  const GAMES = 80
  for (let g = 0; g < GAMES; g++) {
    const b = createBattle(
      [structuredClone(teamA), structuredClone(teamB)],
      (0x7770000 + g).toString(16),
    )
    let turns = 0
    while (!b.finished && turns < 400) {
      turns++
      for (const side of [0, 1] as const) {
        if (b.pendingReplace[side]) {
          const a = chooseAction(b, side, side === 0 ? 'normal' : 'easy', rng)
          if (a.kind === 'switch' && !b.sides[side].team[a.index].fainted) {
            b.sides[side].active = a.index
            b.pendingReplace[side] = false
          } else {
            const idx = b.sides[side].team.findIndex((m) => !m.fainted)
            if (idx >= 0) { b.sides[side].active = idx; b.pendingReplace[side] = false }
          }
        }
      }
      if (b.finished) break
      resolveTurn(b, [
        chooseAction(b, 0, 'normal', rng),
        chooseAction(b, 1, 'easy', rng),
      ])
    }
    if (b.winner === 0) normalWins++
  }
  // Same team on both sides, so this isolates decision quality alone.
  // 80 games keeps the noise band tight enough for a 60% floor to mean something.
  const rate = normalWins / GAMES
  assert.ok(rate >= 0.6, `normal won only ${normalWins}/${GAMES} (${(rate * 100).toFixed(0)}%) against easy`)
})

/* ---------------- damage estimator ---------------- */

check('estimateDamage tracks the real formula', () => {
  const b = createBattle(
    [[mon('pikachu', ['thunderbolt'])], [mon('blastoise', ['surf'])]],
    'eeee4444',
  )
  const est = estimateDamage(b.sides[0].team[0], b.sides[1].team[0], MOVES.get('thunderbolt')!)
  // Earlier engine test pinned the real spread at roughly 108–128.
  assert.ok(est >= 105 && est <= 130, `estimate ${est} outside the real damage range`)
})

check('estimateDamage returns 0 for immunities and status moves', () => {
  const b = createBattle(
    [[mon('snorlax', ['body-slam', 'amnesia'])], [mon('gengar', ['shadow-ball'])]],
    'ffff5555',
  )
  const me = b.sides[0].team[0]
  const foe = b.sides[1].team[0]
  assert.strictEqual(estimateDamage(me, foe, MOVES.get('body-slam')!), 0, 'Normal into Ghost')
  assert.strictEqual(estimateDamage(me, foe, MOVES.get('amnesia')!), 0, 'status move')
})

/* ---------------- ability awareness ---------------- */

check('the AI will not pick a move the target is immune to by ability', () => {
  // Ground into Levitate: zero damage, but it used to score as the best option
  // and the bot would repeat it every turn for the whole match.
  const b = createBattle(
    [[mon('golem', ['earthquake', 'rock-slide'])],
     [mon('weezing', ['sludge-bomb'], { ability: 'levitate' })]],
    'a0a01111',
  )
  for (let i = 0; i < 20; i++) {
    const a = chooseAction(b, 0, 'normal', () => 0.99)
    assert.ok(a.kind !== 'move' || a.index !== 0, `picked earthquake into levitate (try ${i})`)
  }
})

check('estimateDamage respects every ability immunity', () => {
  const cases: [string, string, string, string][] = [
    ['golem', 'earthquake', 'weezing', 'levitate'],
    ['blastoise', 'surf', 'lapras', 'water-absorb'],
    ['pikachu', 'thunderbolt', 'lapras', 'shell-armor'],
    ['charizard', 'flamethrower', 'arcanine', 'flash-fire'],
    ['pikachu', 'thunderbolt', 'jolteon', 'volt-absorb'],
    ['blastoise', 'surf', 'tentacruel', 'clear-body'],
  ]
  for (const [atk, move, def, ability] of cases) {
    // Whatever the defender can actually learn; it never gets to attack here.
    const defMoves = SPECIES_BY_NAME.get(def)!.moves.slice(0, 1)
    const b = createBattle(
      [[mon(atk, [move])], [mon(def, defMoves, { ability })]],
      'a0a02222',
    )
    const est = estimateDamage(b.sides[0].team[0], b.sides[1].team[0], MOVES.get(move)!)
    const blocking = ['levitate', 'water-absorb', 'flash-fire', 'volt-absorb'].includes(ability)
    if (blocking) assert.strictEqual(est, 0, `${ability} did not zero out ${move}`)
    else assert.ok(est > 0, `${ability} wrongly zeroed ${move}`)
  }
})

check('mold breaker lets the AI see through an immunity again', () => {
  const b = createBattle(
    [[mon('pinsir', ['earthquake'], { ability: 'mold-breaker' })],
     [mon('weezing', ['sludge-bomb'], { ability: 'levitate' })]],
    'a0a03333',
  )
  const est = estimateDamage(b.sides[0].team[0], b.sides[1].team[0], MOVES.get('earthquake')!)
  assert.ok(est > 0, 'mold breaker estimate still zero')
})

check('the estimator agrees with the damage the engine actually deals', () => {
  // The two used to be separate implementations; this pins them together.
  const pairs: [string, string, string, string | undefined][] = [
    ['charizard', 'flamethrower', 'snorlax', undefined],
    ['charizard', 'flamethrower', 'snorlax', 'thick-fat'],
    ['mewtwo', 'psychic', 'dragonite', 'multiscale'],
    ['machamp', 'karate-chop', 'snorlax', 'thick-fat'],
  ]
  for (const [atk, move, def, ability] of pairs) {
    const rolls: number[] = []
    for (let i = 0; i < 40; i++) {
      const b = createBattle(
        [[mon(atk, [move])], [mon(def, ['body-slam'], ability ? { ability } : {})]],
        (0x90000000 + i * 0x0bad1dea).toString(16).slice(0, 8),
      )
      const before = b.sides[1].team[0].hp
      resolveTurn(b, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
      rolls.push(before - b.sides[1].team[0].hp)
    }
    const b2 = createBattle(
      [[mon(atk, [move])], [mon(def, ['body-slam'], ability ? { ability } : {})]], 'a0a04444',
    )
    const est = estimateDamage(b2.sides[0].team[0], b2.sides[1].team[0], MOVES.get(move)!)
    rolls.sort((x, y) => x - y)
    const lo = rolls[2]
    const hi = rolls[rolls.length - 3]
    assert.ok(
      est >= lo * 0.8 && est <= hi * 1.2,
      `${atk} ${move} vs ${def}${ability ? ' ' + ability : ''}: estimate ${est}, real ${lo}-${hi}`,
    )
  }
})

check('the AI reads the weather', () => {
  const b = createBattle(
    [[mon('charizard', ['flamethrower'])], [mon('snorlax', ['body-slam'])]],
    'a0a05555',
  )
  const dry = estimateDamage(b.sides[0].team[0], b.sides[1].team[0], MOVES.get('flamethrower')!)
  const sunny = estimateDamage(
    b.sides[0].team[0], b.sides[1].team[0], MOVES.get('flamethrower')!, 'sun',
  )
  assert.ok(sunny > dry, `sun ignored: ${dry} -> ${sunny}`)
})

console.log(`${passed} AI checks passed${process.exitCode ? ' (with failures)' : ''}`)
