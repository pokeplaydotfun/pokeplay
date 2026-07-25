/**
 * Tests for the AI the server actually runs (v2).
 *
 * Mirrors the guarantees v1's AI test enforces, because they are the ones that
 * matter for a wagered match: every action it returns must be legal, it must
 * never touch the battle's RNG (that would break replay verification), and
 * "normal" must genuinely play better than "easy".
 */
import assert from 'node:assert/strict'
import { ready, SPECIES } from './dex2.js'
import {
  createBattle, resolveTurn, replaceFainted, validateAction, type TeamSlot,
} from './engine2.js'
import { chooseAction } from './ai2.js'

await ready

let passed = 0
const check = (name: string, fn: () => void) => {
  fn()
  passed++
  console.log(`✓ ${name}`)
}

/** A sensible six, so "the best move" is a meaningful idea. */
const ELITE: TeamSlot[] = [
  { speciesId: 143, moves: ['body-slam', 'earthquake', 'crunch', 'rest'], nature: 'adamant', ability: 'thick-fat' },
  { speciesId: 94, moves: ['shadow-ball', 'sludge-bomb', 'thunderbolt', 'substitute'], nature: 'timid', ability: 'cursed-body' },
  { speciesId: 130, moves: ['waterfall', 'crunch', 'ice-fang', 'dragon-dance'], nature: 'adamant', ability: 'intimidate' },
  { speciesId: 65, moves: ['psychic', 'shadow-ball', 'energy-ball', 'recover'], nature: 'timid', ability: 'synchronize' },
  { speciesId: 68, moves: ['cross-chop', 'earthquake', 'rock-slide', 'fire-punch'], nature: 'adamant', ability: 'no-guard' },
  { speciesId: 6, moves: ['flamethrower', 'air-slash', 'dragon-pulse', 'roost'], nature: 'timid', ability: 'blaze' },
]

/** Runs a match between two difficulties and returns the winner. */
function play(
  seed: string, d0: 'easy' | 'normal', d1: 'easy' | 'normal',
  onAction?: (side: 0 | 1, ok: string | null) => void,
): 0 | 1 | null {
  const b = createBattle([ELITE, ELITE], seed)
  let guard = 0
  while (!b.finished && guard++ < 800) {
    if (b.pendingReplace[0] || b.pendingReplace[1]) {
      for (const side of [0, 1] as const) {
        if (!b.pendingReplace[side]) continue
        const a = chooseAction(b, side, side === 0 ? d0 : d1)
        replaceFainted(b, side, a.kind === 'switch' ? a.index : 0)
      }
      continue
    }
    const a0 = chooseAction(b, 0, d0)
    const a1 = chooseAction(b, 1, d1)
    if (onAction) {
      onAction(0, validateAction(b, 0, a0))
      onAction(1, validateAction(b, 1, a1))
    }
    resolveTurn(b, [a0, a1])
  }
  assert.ok(b.finished, `battle on seed ${seed} never finished`)
  return b.winner
}

/* ------------------------------------------------------------------ */

check('picks a super-effective move over a neutral one', () => {
  // Machamp vs Snorlax: Cross Chop (Fighting, 2x on Normal) beats Rock Slide.
  const b = createBattle(
    [
      [{ speciesId: 68, moves: ['rock-slide', 'cross-chop'], nature: 'adamant', ability: 'no-guard' }],
      [{ speciesId: 143, moves: ['body-slam'], nature: 'adamant', ability: 'thick-fat' }],
    ],
    'super-effective',
  )
  const a = chooseAction(b, 0, 'normal', () => 0.99)
  assert.equal(a.kind, 'move')
  assert.equal((a as { index: number }).index, 1, 'should pick Cross Chop')
})

check('never picks a move the target is immune to', () => {
  // Normal does nothing to Ghost; Earthquake connects.
  const b = createBattle(
    [
      [{ speciesId: 143, moves: ['body-slam', 'earthquake'], nature: 'adamant', ability: 'thick-fat' }],
      [{ speciesId: 94, moves: ['shadow-ball'], nature: 'timid', ability: 'cursed-body' }],
    ],
    'immunity',
  )
  const a = chooseAction(b, 0, 'normal', () => 0.99)
  assert.equal((a as { index: number }).index, 1, 'should avoid the Normal move into a Ghost')
})

check('every action the AI returns is legal', () => {
  let checked = 0
  for (let g = 0; g < 6; g++) {
    play(`legal-${g}`, 'normal', 'easy', (side, err) => {
      assert.equal(err, null, `illegal AI action on side ${side}: ${err}`)
      checked++
    })
  }
  assert.ok(checked > 50, `expected plenty of actions, saw ${checked}`)
})

check('the AI never consumes the battle RNG', () => {
  // If the AI drew from the sim's PRNG, the published seed commitment would
  // stop matching the replay and every wager would be unverifiable.
  const run = (callAi: boolean) => {
    const b = createBattle([ELITE, ELITE], 'rng-safety')
    if (callAi) for (let i = 0; i < 25; i++) chooseAction(b, 1, 'normal', Math.random)
    resolveTurn(b, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
    return b.sides.map((s) => s.team.map((m) => m.hp).join(',')).join('|')
  }
  assert.equal(run(false), run(true), 'AI calls changed the battle RNG stream')
})

check('a forced replacement is never the Pokémon already on the field', () => {
  // The pivot-move deadlock: U-turn raises the same flag a faint does, and
  // offering the active Pokémon back hangs the battle forever.
  const b = createBattle(
    [
      [
        { speciesId: 143, moves: ['u-turn'], nature: 'adamant', ability: 'thick-fat' },
        { speciesId: 94, moves: ['shadow-ball'], nature: 'timid', ability: 'cursed-body' },
      ],
      [{ speciesId: 143, moves: ['body-slam'], nature: 'adamant', ability: 'thick-fat' }],
    ],
    'pivot-ai',
  )
  resolveTurn(b, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  assert.equal(b.pendingReplace[0], true, 'U-turn asked for a switch')
  const a = chooseAction(b, 0, 'normal')
  assert.equal(a.kind, 'switch')
  assert.notEqual((a as { index: number }).index, b.sides[0].active, 'must not re-pick the active one')
})

check('normal beats easy over a long series', () => {
  // Same team both sides, so this isolates decision quality alone.
  const GAMES = 60
  let normalWins = 0
  for (let g = 0; g < GAMES; g++) {
    if (play(`series-${g}`, 'normal', 'easy') === 0) normalWins++
  }
  const rate = normalWins / GAMES
  assert.ok(
    rate >= 0.5,
    `normal won only ${normalWins}/${GAMES} (${(rate * 100).toFixed(0)}%) against easy`,
  )
})

// The practice presets are validated against the live dex; building them here
// proves they are still legal after any dex change.
const { buildOpponents } = await import('./opponents.js')
check('the practice presets are all legal against the live dex', () => {
  const list = buildOpponents()
  assert.equal(list.length, 3, 'three presets')
  for (const o of list) {
    assert.equal(o.team.length, 6, `${o.name} has six`)
    for (const t of o.team) {
      assert.ok(t.moves.length > 0 && t.moves.length <= 4, `${o.name}: 1-4 moves`)
      assert.ok(t.ability, `${o.name}: every slot has an ability`)
      assert.ok(SPECIES.has(t.speciesId), `${o.name}: species is in the dex`)
    }
  }
})

console.log(`\n${passed} AI v2 checks passed`)
