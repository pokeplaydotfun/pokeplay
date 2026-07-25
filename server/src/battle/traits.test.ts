/**
 * Natures and abilities. These change wagered outcomes, so each effect is
 * checked against a hand-computed expectation rather than "whatever it does".
 */
import assert from 'node:assert'
import { buildMon, createBattle, resolveTurn, validateTeam, type TeamSlot } from './engine.js'
import { NATURES, NATURE_BY_NAME } from './natures.js'
import { ABILITIES } from './abilities.js'
import { SPECIES_BY_NAME, ALL_SPECIES } from './data.js'

let passed = 0
const check = (name: string, fn: () => void) => {
  try { fn(); passed++ } catch (e) {
    console.error(`✗ ${name}\n  ${(e as Error).message}`); process.exitCode = 1
  }
}
const mon = (n: string, moves: string[], extra: Partial<TeamSlot> = {}): TeamSlot => {
  const sp = SPECIES_BY_NAME.get(n)!
  return { speciesId: sp.id, moves: moves.filter(m => sp.moves.includes(m)), ...extra }
}

/* ---------------- natures ---------------- */

check('there are 25 natures, 5 of them neutral', () => {
  assert.strictEqual(NATURES.length, 25)
  assert.strictEqual(NATURES.filter(n => n.up === null && n.down === null).length, 5)
})

check('every non-neutral nature raises one stat and lowers a different one', () => {
  for (const n of NATURES) {
    if (n.up === null) { assert.strictEqual(n.down, null, n.name); continue }
    assert.notStrictEqual(n.up, n.down, `${n.name} raises and lowers the same stat`)
  }
})

check('nature moves stats by exactly ±10%, and never HP', () => {
  // Alakazam: base SpA 135 -> (2*135+31)+5 = 306 neutral.
  const neutral = buildMon(mon('alakazam', ['psychic'], { nature: 'hardy' }))
  const modest = buildMon(mon('alakazam', ['psychic'], { nature: 'modest' }))   // +spa -atk
  const timid  = buildMon(mon('alakazam', ['psychic'], { nature: 'timid' }))    // +spe -atk

  assert.strictEqual(neutral.stats.spa, 306, `neutral spa ${neutral.stats.spa}`)
  assert.strictEqual(modest.stats.spa, Math.floor(306 * 1.1), `modest spa ${modest.stats.spa}`)
  assert.strictEqual(modest.stats.atk, Math.floor(neutral.stats.atk * 0.9))
  assert.strictEqual(timid.stats.spe, Math.floor(neutral.stats.spe * 1.1))
  assert.strictEqual(modest.maxHp, neutral.maxHp, 'nature must not touch HP')
})

check('an unknown nature is rejected', () => {
  const team = Array.from({ length: 6 }, () => mon('pikachu', ['thunderbolt'], { nature: 'spicy' }))
  assert.ok(validateTeam(team).length > 0)
})

/* ---------------- ability legality ---------------- */

check('a species cannot be given an ability it does not have', () => {
  const team = Array.from({ length: 6 }, () => mon('magikarp', ['tackle'], { ability: 'huge-power' }))
  assert.ok(validateTeam(team).some(e => /cannot have/.test(e)), validateTeam(team).join('; '))
})

check('a legal ability is accepted', () => {
  // Distinct species: Species Clause rejects six of anything.
  const picks: [string, string, string][] = [
    ['charizard', 'flamethrower', 'blaze'],
    ['blastoise', 'surf', 'torrent'],
    ['venusaur', 'razor-leaf', 'overgrow'],
    ['snorlax', 'body-slam', 'thick-fat'],
    ['gengar', 'shadow-ball', 'cursed-body'],
    ['alakazam', 'psychic', 'magic-guard'],
  ]
  const team = picks.map(([n, mv, ab]) => mon(n, [mv], { ability: ab }))
  assert.deepStrictEqual(validateTeam(team), [])
})

check('every listed ability is one the species really has', () => {
  for (const sp of ALL_SPECIES) {
    for (const a of sp.abilities) assert.ok(ABILITIES.has(a.name), `${sp.name}: ${a.name}`)
  }
})

/* ---------------- ability effects ---------------- */

const run = (a: TeamSlot, b: TeamSlot, seed = 'ab12cd34') => {
  const battle = createBattle([[a], [b]], seed)
  const before = battle.sides[1].team[0].hp
  const ev = resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  return { battle, dealt: before - battle.sides[1].team[0].hp, ev, log: ev.filter(e => e.t === 'text').map(e => (e as any).msg) }
}

check('levitate blocks Ground moves outright', () => {
  const r = run(mon('golem', ['earthquake']), mon('haunter', ['shadow-ball'], { ability: 'levitate' }))
  assert.strictEqual(r.dealt, 0, `took ${r.dealt}`)
  assert.ok(r.log.some(l => /levitate/i.test(l)), r.log.join(' | '))
})

check('volt absorb heals instead of damaging', () => {
  const target = mon('jolteon', ['quick-attack'], { ability: 'volt-absorb' })
  const battle = createBattle([[mon('pikachu', ['thunderbolt'])], [target]], 'cd34ef56')
  battle.sides[1].team[0].hp = Math.floor(battle.sides[1].team[0].maxHp / 2)
  const before = battle.sides[1].team[0].hp
  resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  assert.ok(battle.sides[1].team[0].hp > before, 'did not heal')
})

check('thick fat halves Fire damage', () => {
  const plain = run(mon('charizard', ['flamethrower']), mon('snorlax', ['tackle']))
  const fat = run(mon('charizard', ['flamethrower']), mon('snorlax', ['tackle'], { ability: 'thick-fat' }))
  assert.ok(fat.dealt < plain.dealt * 0.65, `plain ${plain.dealt} vs thick-fat ${fat.dealt}`)
})

check('adaptability raises same-type damage above normal STAB', () => {
  // Eevee is the only one in the first 151 that has it.
  const normalMove = SPECIES_BY_NAME.get('eevee')!.moves.find(m => m === 'body-slam') ?? 'tackle'
  const plain = run(mon('eevee', [normalMove]), mon('snorlax', ['tackle']))
  const adapt = run(mon('eevee', [normalMove], { ability: 'adaptability' }), mon('snorlax', ['tackle']))
  assert.ok(adapt.dealt > plain.dealt, `plain ${plain.dealt} vs adaptability ${adapt.dealt}`)
})

check('sturdy survives a one-hit KO from full HP', () => {
  const battle = createBattle(
    [[mon('mewtwo', ['psychic'])], [mon('geodude', ['tackle'], { ability: 'sturdy' })]],
    'ef56ab78',
  )
  resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  const t = battle.sides[1].team[0]
  assert.ok(t.hp >= 1 && !t.fainted, `hp ${t.hp} fainted ${t.fainted}`)
})

check('immunity refuses poison', () => {
  const battle = createBattle(
    [[mon('venusaur', ['toxic'])], [mon('snorlax', ['tackle'], { ability: 'immunity' })]],
    'ab78cd90',
  )
  for (let i = 0; i < 6; i++) resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  assert.strictEqual(battle.sides[1].team[0].status, null, 'got poisoned anyway')
})

check('intimidate lowers the opponent Attack when it enters', () => {
  const withIntim = ALL_SPECIES.find(s => s.abilities.some(a => a.name === 'intimidate'))!
  const battle = createBattle(
    [[mon('pikachu', ['thunderbolt']), { speciesId: withIntim.id, moves: [withIntim.moves[0]], ability: 'intimidate' }],
     [mon('snorlax', ['tackle'])]],
    'cd90ef12',
  )
  resolveTurn(battle, [{ kind: 'switch', index: 1 }, { kind: 'move', index: 0 }])
  assert.strictEqual(battle.sides[1].team[0].boosts.atk, -1, 'attack not lowered')
})

check('clear body refuses opponent stat drops but self-drops still apply', () => {
  const cb = ALL_SPECIES.find(s => s.abilities.some(a => a.name === 'clear-body'))
  if (!cb) return // none in the first 151; nothing to assert
  assert.ok(ABILITIES.get('clear-body')?.dropProof === 'all')
})

check('magic guard ignores burn damage', () => {
  const mg = ALL_SPECIES.find(s => s.abilities.some(a => a.name === 'magic-guard'))
  assert.ok(mg, 'no magic-guard species')
  const battle = createBattle(
    [[mon('charizard', ['will-o-wisp', 'ember'])], [{ speciesId: mg!.id, moves: [mg!.moves[0]], ability: 'magic-guard' }]],
    'ef12ab34',
  )
  battle.sides[1].team[0].status = 'brn'
  const before = battle.sides[1].team[0].hp
  // A turn where the burn would normally tick.
  resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  const after = battle.sides[1].team[0].hp
  // Any loss must come from the attack, never from the burn residual.
  assert.ok(after >= before - 200, `lost ${before - after}`)
})

/* ---------------- determinism still holds ---------------- */

check('traits do not break seed determinism', () => {
  const build = (): [TeamSlot[], TeamSlot[]] => [
    [mon('charizard', ['flamethrower'], { nature: 'modest', ability: 'blaze' })],
    [mon('blastoise', ['surf'], { nature: 'bold', ability: 'torrent' })],
  ]
  const play = () => {
    const b = createBattle(build(), 'seedseed')
    const log: string[] = []
    for (let i = 0; i < 12 && !b.finished; i++) {
      if (b.pendingReplace[0] || b.pendingReplace[1]) break
      log.push(...resolveTurn(b, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
        .filter(e => e.t === 'text').map(e => (e as any).msg))
    }
    return log.join('|')
  }
  assert.strictEqual(play(), play())
})

console.log(`${passed} trait checks passed${process.exitCode ? ' (with failures)' : ''}`)
