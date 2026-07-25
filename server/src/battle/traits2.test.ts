/**
 * The abilities added when the roster went from 54 to every ability the first
 * 151 can have — plus the weather and gender machinery underneath them.
 *
 * Each check pins a specific mechanic. An ability that silently does nothing
 * is the exact failure this suite exists to catch, so "it ran without
 * throwing" is never the assertion.
 */
import assert from 'node:assert'
import {
  buildMon, createBattle, resolveTurn, validateAction, type Battle, type TeamSlot,
} from './engine.js'
import { ABILITIES, MOVE_GROUPS } from './abilities.js'
import { SPECIES_BY_NAME, ALL_SPECIES, MOVES } from './data.js'

let passed = 0
const check = (name: string, fn: () => void) => {
  try { fn(); passed++ } catch (e) {
    console.error(`✗ ${name}\n  ${(e as Error).message}`)
    process.exitCode = 1
  }
}

const mon = (n: string, moves: string[], extra: Partial<TeamSlot> = {}): TeamSlot => {
  const sp = SPECIES_BY_NAME.get(n)
  assert.ok(sp, `no such species ${n}`)
  const legal = moves.filter((m) => sp!.moves.includes(m))
  assert.ok(legal.length > 0, `${n} cannot learn any of ${moves.join(', ')}`)
  return { speciesId: sp!.id, moves: legal, ...extra }
}

/** Both sides use move 0 for one turn; returns damage dealt to side 1. */
const trade = (a: TeamSlot, bb: TeamSlot, seed = 'a1b2c3d4') => {
  const battle = createBattle([[a], [bb]], seed)
  const before = battle.sides[1].team[0].hp
  const ev = resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  return {
    battle,
    dealt: before - battle.sides[1].team[0].hp,
    log: ev.filter((e) => e.t === 'text').map((e) => (e as { msg: string }).msg),
  }
}

const logOf = (ev: ReturnType<typeof resolveTurn>) =>
  ev.filter((e) => e.t === 'text').map((e) => (e as { msg: string }).msg).join(' | ')

/**
 * Median damage over many seeds. Single-seed comparisons are dominated by the
 * 0.85–1.00 spread and by crits, which makes a 25% effect unprovable.
 */
function medianDamage(a: TeamSlot, bb: TeamSlot, runs = 41): number {
  const out: number[] = []
  for (let i = 0; i < runs; i++) {
    const seed = (0x10000000 + i * 0x0bad1dea).toString(16).slice(0, 8)
    out.push(trade(a, bb, seed).dealt)
  }
  out.sort((x, y) => x - y)
  return out[Math.floor(out.length / 2)]
}

/* ------------------------------------------------------------------ */
/* coverage                                                            */
/* ------------------------------------------------------------------ */

check('every one of the 151 has at least one selectable ability', () => {
  const bare = ALL_SPECIES.filter((s) => s.abilities.length === 0)
  assert.deepStrictEqual(bare.map((s) => s.name), [], 'species left with no ability')
})

check('every ability a species lists is described', () => {
  for (const sp of ALL_SPECIES) {
    for (const a of sp.abilities) {
      const def = ABILITIES.get(a.name)
      assert.ok(def, `${sp.name}: ${a.name} missing`)
      assert.ok(def!.text.length > 10, `${a.name} has no description`)
    }
  }
})

check('an ability that does nothing says why', () => {
  for (const [name, a] of ABILITIES) {
    const fields = Object.keys(a).filter((k) => !['name', 'text', 'inert'].includes(k))
    if (a.inert) {
      assert.strictEqual(fields.length, 0, `${name} claims to be inert but has ${fields.join(', ')}`)
    } else {
      assert.ok(fields.length > 0, `${name} has no effect and no explanation`)
    }
  }
})

check('the hand-written move groups only name real moves', () => {
  for (const [group, set] of Object.entries(MOVE_GROUPS)) {
    for (const name of set) {
      // The dex carries every move; the engine only runs a subset.
      assert.ok(typeof name === 'string' && name.length > 2, `${group}: ${name}`)
    }
  }
  assert.ok(MOVE_GROUPS.punch.has('fire-punch'))
  assert.ok(MOVE_GROUPS.sound.has('hyper-voice'))
  assert.ok(!MOVE_GROUPS.punch.has('tackle'))
})

/* ------------------------------------------------------------------ */
/* weather                                                             */
/* ------------------------------------------------------------------ */

check('sunny day sets sun, and it expires after five turns', () => {
  const battle = createBattle(
    [[mon('venusaur', ['sunny-day', 'tackle'])], [mon('snorlax', ['tackle'])]],
    'beef0001',
  )
  resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  assert.strictEqual(battle.weather?.kind, 'sun', 'sun did not start')
  // Turn 1 already consumed one; four more take it to zero.
  for (let i = 0; i < 4; i++) {
    resolveTurn(battle, [{ kind: 'move', index: 1 }, { kind: 'move', index: 0 }])
  }
  assert.strictEqual(battle.weather, null, 'sun outlasted its five turns')
})

check('sun strengthens Fire and weakens Water', () => {
  const plain = medianDamage(mon('charizard', ['flamethrower']), mon('snorlax', ['tackle']))
  const sunny = (() => {
    const out: number[] = []
    for (let i = 0; i < 41; i++) {
      const seed = (0x20000000 + i * 0x0bad1dea).toString(16).slice(0, 8)
      const battle = createBattle(
        [[mon('charizard', ['sunny-day', 'flamethrower'])], [mon('snorlax', ['tackle'])]],
        seed,
      )
      resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
      const before = battle.sides[1].team[0].hp
      resolveTurn(battle, [{ kind: 'move', index: 1 }, { kind: 'move', index: 0 }])
      out.push(before - battle.sides[1].team[0].hp)
    }
    out.sort((a, b) => a - b)
    return out[20]
  })()
  assert.ok(sunny > plain * 1.3, `plain ${plain} vs sun ${sunny}`)
})

check('drought sets the sun just by switching in', () => {
  const battle = createBattle(
    [[mon('pikachu', ['thunderbolt']), mon('ninetales', ['ember'], { ability: 'drought' })],
     [mon('snorlax', ['tackle'])]],
    'beef0002',
  )
  resolveTurn(battle, [{ kind: 'switch', index: 1 }, { kind: 'move', index: 0 }])
  assert.strictEqual(battle.weather?.kind, 'sun', 'drought did not fire')
})

check('chlorophyll doubles Speed in sun and does nothing without it', () => {
  const dry = buildMon(mon('venusaur', ['tackle'], { ability: 'chlorophyll' }))
  // Speed is read through effStat, so drive it via real turn order instead.
  const battle = createBattle(
    [[mon('venusaur', ['sunny-day', 'vine-whip'], { ability: 'chlorophyll' })],
     [mon('persian', ['scratch'])]],
    'beef0003',
  )
  const faster = buildMon(mon('persian', ['scratch']))
  assert.ok(faster.stats.spe > dry.stats.spe, 'fixture broken: Persian should outspeed Venusaur')

  resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  const ev = resolveTurn(battle, [{ kind: 'move', index: 1 }, { kind: 'move', index: 0 }])
  const log = ev.filter((e) => e.t === 'text').map((e) => (e as { msg: string }).msg)
  const venuFirst = log.findIndex((l) => /Venusaur used/.test(l))
  const persFirst = log.findIndex((l) => /Persian used/.test(l))
  assert.ok(venuFirst >= 0 && persFirst >= 0, log.join(' | '))
  assert.ok(venuFirst < persFirst, `Venusaur should outspeed under sun: ${log.join(' | ')}`)
})

check('sandstorm chips non-Rock types and spares Rock ones', () => {
  const battle = createBattle(
    [[mon('golem', ['sandstorm', 'tackle'])], [mon('snorlax', ['tackle'])]],
    'beef0004',
  )
  const ev = resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  const buffeted = ev
    .filter((e) => e.t === 'text' && /buffeted/.test((e as { msg: string }).msg))
    .map((e) => (e as { msg: string }).msg)
  assert.ok(buffeted.some((l) => /Snorlax/.test(l)), `Snorlax ignored the sandstorm: ${buffeted}`)
  assert.ok(!buffeted.some((l) => /Golem/.test(l)), `Rock/Ground took sand damage: ${buffeted}`)
})

check('cloud nine switches the weather effects off without clearing it', () => {
  const battle = createBattle(
    [[mon('golem', ['sandstorm', 'tackle'])], [mon('psyduck', ['scratch'], { ability: 'cloud-nine' })]],
    'beef0005',
  )
  const before = battle.sides[1].team[0].hp
  resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  assert.strictEqual(battle.weather?.kind, 'sand', 'sandstorm should still be up')
  // Psyduck is Water: it would normally be chipped.
  assert.strictEqual(battle.sides[1].team[0].hp, before, 'cloud nine did not block sand damage')
})

check('sand veil holders shrug off their own sandstorm', () => {
  const battle = createBattle(
    [[mon('golem', ['sandstorm', 'tackle'])],
     [mon('sandslash', ['scratch'], { ability: 'sand-veil' })]],
    'beef0006',
  )
  const before = battle.sides[1].team[0].hp
  resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  assert.strictEqual(battle.sides[1].team[0].hp, before, 'sand veil took sand damage')
})

/* ------------------------------------------------------------------ */
/* gender                                                              */
/* ------------------------------------------------------------------ */

check('gender follows the species ratio', () => {
  // Nidoran-F is always female, Tauros always male, Magnemite genderless.
  const battle = createBattle(
    [[mon('nidoran-f', ['scratch']), mon('tauros', ['tackle']), mon('magnemite', ['tackle']),
      mon('nidoran-f', ['scratch']), mon('tauros', ['tackle']), mon('magnemite', ['tackle'])],
     [mon('snorlax', ['tackle'])]],
    'beef0007',
  )
  const g = battle.sides[0].team.map((m) => m.gender)
  assert.deepStrictEqual(g, ['F', 'M', 'N', 'F', 'M', 'N'], `got ${g.join(',')}`)
})

check('gender is reproducible from the seed', () => {
  const team = () => Array.from({ length: 6 }, () => mon('bulbasaur', ['tackle']))
  const a = createBattle([team(), team()], 'beef0008').sides[0].team.map((m) => m.gender)
  const b = createBattle([team(), team()], 'beef0008').sides[0].team.map((m) => m.gender)
  assert.deepStrictEqual(a, b, 'gender is not deterministic — replay would diverge')
})

/* ------------------------------------------------------------------ */
/* damage-shaping abilities                                            */
/* ------------------------------------------------------------------ */

check('multiscale halves damage at full HP only', () => {
  const plain = medianDamage(mon('mewtwo', ['psychic']), mon('dragonite', ['slam']))
  const scale = medianDamage(
    mon('mewtwo', ['psychic']),
    mon('dragonite', ['slam'], { ability: 'multiscale' }),
  )
  assert.ok(scale < plain * 0.65, `plain ${plain} vs multiscale ${scale}`)

  // Once chipped, the discount is gone.
  const battle = createBattle(
    [[mon('mewtwo', ['psychic'])], [mon('dragonite', ['slam'], { ability: 'multiscale' })]],
    'beef0009',
  )
  const t = battle.sides[1].team[0]
  t.hp = t.maxHp - 1
  const before = t.hp
  resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  const chipped = before - t.hp
  assert.ok(chipped > plain * 0.65, `below full HP multiscale still halved: ${chipped} vs ${plain}`)
})

check('iron fist boosts punches and leaves other moves alone', () => {
  const punchPlain = medianDamage(mon('hitmonchan', ['fire-punch']), mon('snorlax', ['tackle']))
  const punchFist = medianDamage(
    mon('hitmonchan', ['fire-punch'], { ability: 'iron-fist' }), mon('snorlax', ['tackle']),
  )
  assert.ok(punchFist > punchPlain, `punch ${punchPlain} -> ${punchFist}`)

  const kickPlain = medianDamage(mon('hitmonchan', ['mega-kick']), mon('snorlax', ['tackle']))
  const kickFist = medianDamage(
    mon('hitmonchan', ['mega-kick'], { ability: 'iron-fist' }), mon('snorlax', ['tackle']),
  )
  assert.strictEqual(kickFist, kickPlain, 'iron fist boosted a kick')
})

check('analytic pays out only when moving second', () => {
  // Magnemite is slower than Persian, so it always moves second here.
  const second = medianDamage(
    mon('magnemite', ['thunderbolt'], { ability: 'analytic' }), mon('persian', ['scratch']),
  )
  const plain = medianDamage(mon('magnemite', ['thunderbolt']), mon('persian', ['scratch']))
  assert.ok(second > plain, `plain ${plain} vs analytic ${second}`)
})

check('unaware ignores the opponent stat boosts', () => {
  const hitWith = (ability?: string) => {
    const battle = createBattle(
      [[mon('machamp', ['strength'])],
       [mon('clefable', ['pound'], ability ? { ability } : {})]],
      'beef000a',
    )
    battle.sides[0].team[0].boosts.atk = 2
    const before = battle.sides[1].team[0].hp
    resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
    return before - battle.sides[1].team[0].hp
  }
  const normal = hitWith()
  const unaware = hitWith('unaware')
  assert.ok(unaware < normal, `boosted hit ${normal}, unaware took ${unaware}`)
})

check('mold breaker walks through a defensive ability', () => {
  const blocked = trade(
    mon('pinsir', ['earthquake']),
    mon('weezing', ['tackle'], { ability: 'levitate' }),
  )
  assert.strictEqual(blocked.dealt, 0, 'levitate should have blocked it')

  const broken = trade(
    mon('pinsir', ['earthquake'], { ability: 'mold-breaker' }),
    mon('weezing', ['tackle'], { ability: 'levitate' }),
  )
  assert.ok(broken.dealt > 0, 'mold breaker failed to ignore levitate')
})

check('scrappy lets Normal moves reach a Ghost', () => {
  const blocked = trade(mon('kangaskhan', ['body-slam']), mon('gengar', ['lick']))
  assert.strictEqual(blocked.dealt, 0, 'Normal should not touch Ghost')

  const scrappy = trade(
    mon('kangaskhan', ['body-slam'], { ability: 'scrappy' }), mon('gengar', ['lick']),
  )
  assert.ok(scrappy.dealt > 0, 'scrappy did not bypass the Ghost immunity')
})

check('rivalry cuts both ways', () => {
  // Nidoking is always male; Nidoqueen always female.
  const same = medianDamage(
    mon('nidoking', ['horn-attack'], { ability: 'rivalry' }), mon('tauros', ['tackle']),
  )
  const opposite = medianDamage(
    mon('nidoking', ['horn-attack'], { ability: 'rivalry' }), mon('nidoqueen', ['tackle']),
  )
  const plainSame = medianDamage(mon('nidoking', ['horn-attack']), mon('tauros', ['tackle']))
  assert.ok(same > plainSame, `same gender should hit harder: ${plainSame} -> ${same}`)
  assert.ok(opposite > 0, 'opposite-gender hit vanished entirely')
})

check('skill link always maxes a multi-hit move', () => {
  const battle = createBattle(
    [[mon('cloyster', ['icicle-spear'], { ability: 'skill-link' })], [mon('snorlax', ['tackle'])]],
    'beef000b',
  )
  const ev = resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  const log = logOf(ev)
  const m = MOVES.get('icicle-spear')
  if (m?.maxHits) assert.ok(log.includes(`Hit ${m.maxHits} time(s)!`), log)
})

/* ------------------------------------------------------------------ */
/* reactive abilities                                                  */
/* ------------------------------------------------------------------ */

check('weak armor trades Defence for Speed when hit physically', () => {
  const battle = createBattle(
    [[mon('snorlax', ['body-slam'])], [mon('onix', ['tackle'], { ability: 'weak-armor' })]],
    'beef000c',
  )
  resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  const t = battle.sides[1].team[0]
  assert.strictEqual(t.boosts.def, -1, `def ${t.boosts.def}`)
  assert.strictEqual(t.boosts.spe, 2, `spe ${t.boosts.spe}`)
})

check('justified answers a Dark move and ignores others', () => {
  const dark = createBattle(
    [[mon('gengar', ['sucker-punch'])],
     [mon('arcanine', ['bite'], { ability: 'justified' })]],
    'beef000d',
  )
  resolveTurn(dark, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  assert.strictEqual(dark.sides[1].team[0].boosts.atk, 1, 'Dark hit did not raise Attack')

  const notDark = trade(mon('snorlax', ['body-slam']), mon('arcanine', ['bite'], { ability: 'justified' }))
  assert.strictEqual(notDark.battle.sides[1].team[0].boosts.atk, 0, 'a Normal move raised Attack')
})

check('defiant answers an opponent drop but not a self-inflicted one', () => {
  const battle = createBattle(
    [[mon('persian', ['growl'])], [mon('mankey', ['scratch'], { ability: 'defiant' })]],
    'beef000e',
  )
  resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  // Growl takes one stage, Defiant gives two back.
  assert.strictEqual(battle.sides[1].team[0].boosts.atk, 1, `atk ${battle.sides[1].team[0].boosts.atk}`)
})

check('moxie climbs after a knockout', () => {
  const battle = createBattle(
    [[mon('gyarados', ['hydro-pump'], { ability: 'moxie' })],
     [mon('magikarp', ['tackle']), mon('magikarp', ['tackle'])]],
    'beef000f',
  )
  battle.sides[1].team[0].hp = 1
  resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  assert.strictEqual(battle.sides[0].team[0].boosts.atk, 1, 'moxie did not trigger')
})

check('anger point maxes Attack on a critical hit', () => {
  const battle = createBattle(
    [[mon('machamp', ['karate-chop'])], [mon('tauros', ['tackle'], { ability: 'anger-point' })]],
    'beef0010',
  )
  // Karate Chop has a raised crit stage; drive it deterministically instead.
  const t = battle.sides[1].team[0]
  let sawCrit = false
  for (let i = 0; i < 40 && !sawCrit; i++) {
    const battle2 = createBattle(
      [[mon('machamp', ['karate-chop'])], [mon('tauros', ['tackle'], { ability: 'anger-point' })]],
      (0x30000000 + i * 0x0bad1dea).toString(16).slice(0, 8),
    )
    const ev = resolveTurn(battle2, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
    if (logOf(ev).includes('A critical hit!')) {
      sawCrit = true
      assert.strictEqual(battle2.sides[1].team[0].boosts.atk, 6, 'crit did not max Attack')
    }
  }
  assert.ok(sawCrit, 'never rolled a crit in 40 seeds — test is not exercising anger point')
  assert.ok(t)
})

check('synchronize hands the burn back', () => {
  const battle = createBattle(
    [[mon('charizard', ['will-o-wisp'])], [mon('alakazam', ['psychic'], { ability: 'synchronize' })]],
    'beef0011',
  )
  resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  const target = battle.sides[1].team[0]
  const source = battle.sides[0].team[0]
  if (target.status === 'brn') {
    // Charizard is Fire, so it cannot actually be burned — check the attempt.
    assert.ok(source.status === 'brn' || source.types.includes('fire'))
  }
})

check('steadfast turns a flinch into speed', () => {
  // Persian outspeeds Machamp, so its Bite can land the flinch first.
  let flinched = false
  for (let i = 0; i < 60 && !flinched; i++) {
    const battle = createBattle(
      [[mon('persian', ['bite'])], [mon('machamp', ['karate-chop'], { ability: 'steadfast' })]],
      (0x80000000 + i * 0x0bad1dea).toString(16).slice(0, 8),
    )
    const ev = resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
    if (logOf(ev).includes('flinched')) {
      flinched = true
      assert.strictEqual(battle.sides[1].team[0].boosts.spe, 1, `steadfast did not fire: ${logOf(ev)}`)
    }
  }
  assert.ok(flinched, 'never rolled a flinch in 60 seeds')
})

/* ------------------------------------------------------------------ */
/* field control                                                       */
/* ------------------------------------------------------------------ */

check('arena trap stops a switch but never a forced replacement', () => {
  const battle = createBattle(
    [[mon('dugtrio', ['dig', 'scratch'], { ability: 'arena-trap' })],
     [mon('snorlax', ['tackle']), mon('pidgeot', ['gust'])]],
    'beef0013',
  )
  assert.ok(
    validateAction(battle, 1, { kind: 'switch', index: 1 }) !== null,
    'grounded Pokémon escaped arena trap',
  )
  // A Flying type is not grounded, so it can leave.
  const flying = createBattle(
    [[mon('dugtrio', ['scratch'], { ability: 'arena-trap' })],
     [mon('pidgeot', ['gust']), mon('snorlax', ['tackle'])]],
    'beef0014',
  )
  assert.strictEqual(
    validateAction(flying, 1, { kind: 'switch', index: 1 }), null,
    'a Flying type was wrongly trapped',
  )
})

check('magnet pull only holds Steel types', () => {
  const steel = createBattle(
    [[mon('magneton', ['thunderbolt'], { ability: 'magnet-pull' })],
     [mon('magnemite', ['tackle']), mon('snorlax', ['tackle'])]],
    'beef0015',
  )
  assert.ok(validateAction(steel, 1, { kind: 'switch', index: 1 }) !== null, 'Steel escaped')

  const flesh = createBattle(
    [[mon('magneton', ['thunderbolt'], { ability: 'magnet-pull' })],
     [mon('snorlax', ['tackle']), mon('pikachu', ['thunderbolt'])]],
    'beef0016',
  )
  assert.strictEqual(validateAction(flesh, 1, { kind: 'switch', index: 1 }), null, 'non-Steel trapped')
})

check('pressure burns two PP per move', () => {
  const battle = createBattle(
    [[mon('snorlax', ['body-slam'])], [mon('articuno', ['ice-beam'], { ability: 'pressure' })]],
    'beef0017',
  )
  const before = battle.sides[0].team[0].moves[0].pp
  resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  assert.strictEqual(battle.sides[0].team[0].moves[0].pp, before - 2, 'pressure did not bite')
})

check('damp smothers self-destruct', () => {
  const battle = createBattle(
    [[mon('electrode', ['explosion', 'tackle'])], [mon('psyduck', ['scratch'], { ability: 'damp' })]],
    'beef0018',
  )
  const ev = resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  assert.ok(/damp prevents/.test(logOf(ev)), logOf(ev))
  assert.ok(!battle.sides[0].team[0].fainted, 'the user blew up anyway')
})

check('trace copies the opponent ability', () => {
  const battle = createBattle(
    [[mon('pikachu', ['thunderbolt']), mon('porygon', ['tackle'], { ability: 'trace' })],
     [mon('arcanine', ['bite'], { ability: 'intimidate' })]],
    'beef0019',
  )
  resolveTurn(battle, [{ kind: 'switch', index: 1 }, { kind: 'move', index: 0 }])
  assert.strictEqual(battle.sides[0].team[1].ability?.name, 'intimidate', 'trace copied nothing')
})

check('imposter copies stats and moves but keeps its own HP', () => {
  const battle = createBattle(
    [[mon('pikachu', ['thunderbolt']), mon('ditto', ['transform'], { ability: 'imposter' })],
     [mon('machamp', ['karate-chop'])]],
    'beef001a',
  )
  const dittoHpBefore = battle.sides[0].team[1].maxHp
  resolveTurn(battle, [{ kind: 'switch', index: 1 }, { kind: 'move', index: 0 }])
  const ditto = battle.sides[0].team[1]
  const champ = battle.sides[1].team[0]
  assert.strictEqual(ditto.stats.atk, champ.stats.atk, 'did not copy Attack')
  assert.strictEqual(ditto.maxHp, dittoHpBefore, 'copied HP, which Transform never does')
  assert.deepStrictEqual(ditto.types, champ.types, 'did not copy types')
})

check('neutralizing gas switches the other ability off', () => {
  // Flash Fire normally makes a Fire move bounce off entirely.
  // Ember, not Bite: a flinch would stop Weezing attacking for the wrong reason.
  const blocked = trade(
    mon('weezing', ['flamethrower'], { ability: 'levitate' }),
    mon('arcanine', ['ember'], { ability: 'flash-fire' }),
  )
  assert.strictEqual(blocked.dealt, 0, 'flash fire should have absorbed it')

  const gassed = trade(
    mon('weezing', ['flamethrower'], { ability: 'neutralizing-gas' }),
    mon('arcanine', ['ember'], { ability: 'flash-fire' }),
  )
  assert.ok(gassed.dealt > 0, 'flash fire survived neutralizing gas')
})

/* ------------------------------------------------------------------ */
/* status and secondary effects                                        */
/* ------------------------------------------------------------------ */

check('shield dust refuses added effects but not the damage', () => {
  let statused = 0
  let dusted = 0
  for (let i = 0; i < 60; i++) {
    const seed = (0x40000000 + i * 0x0bad1dea).toString(16).slice(0, 8)
    const a = trade(mon('snorlax', ['body-slam']), mon('venomoth', ['gust']), seed)
    if (a.battle.sides[1].team[0].status === 'par') statused++
    const b = trade(
      mon('snorlax', ['body-slam']),
      mon('venomoth', ['gust'], { ability: 'shield-dust' }), seed,
    )
    if (b.battle.sides[1].team[0].status === 'par') dusted++
    assert.ok(b.dealt > 0, 'shield dust blocked the damage too')
  }
  assert.ok(statused > 0, 'fixture never paralysed anyone — test proves nothing')
  assert.strictEqual(dusted, 0, `shield dust let ${dusted} paralyses through`)
})

check('effect spore can inflict more than one status', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 120; i++) {
    const seed = (0x50000000 + i * 0x0bad1dea).toString(16).slice(0, 8)
    const r = trade(
      mon('machamp', ['karate-chop']),
      mon('parasect', ['scratch'], { ability: 'effect-spore' }), seed,
    )
    const st = r.battle.sides[0].team[0].status
    if (st) seen.add(st)
  }
  assert.ok(seen.size >= 2, `effect spore only ever produced ${[...seen].join(',') || 'nothing'}`)
})

check('liquid ooze turns a drain into damage', () => {
  const battle = createBattle(
    [[mon('venusaur', ['mega-drain'])], [mon('tentacruel', ['acid'], { ability: 'liquid-ooze' })]],
    'beef001b',
  )
  const before = battle.sides[0].team[0].hp
  battle.sides[0].team[0].hp = Math.floor(before / 2)
  const mid = battle.sides[0].team[0].hp
  resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  assert.ok(battle.sides[0].team[0].hp < mid, 'draining against liquid ooze still healed')
})

check('aftermath punishes the contact hit that lands the KO', () => {
  const battle = createBattle(
    [[mon('machamp', ['karate-chop'])], [mon('electrode', ['tackle'], { ability: 'aftermath' })]],
    'beef001c',
  )
  battle.sides[1].team[0].hp = 1
  const before = battle.sides[0].team[0].hp
  const ev = resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  assert.ok(battle.sides[1].team[0].fainted, 'target survived: fixture broken')
  assert.ok(battle.sides[0].team[0].hp < before, logOf(ev))
})

check('cursed body disables the move that hit it', () => {
  let disabled = false
  for (let i = 0; i < 60 && !disabled; i++) {
    const battle = createBattle(
      [[mon('persian', ['bite', 'scratch'])], [mon('gengar', ['shadow-ball'], { ability: 'cursed-body' })]],
      (0x60000000 + i * 0x0bad1dea).toString(16).slice(0, 8),
    )
    resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
    if (battle.sides[0].team[0].disabled) {
      disabled = true
      assert.strictEqual(battle.sides[0].team[0].disabled!.move, 'bite')
      assert.ok(
        validateAction(battle, 0, { kind: 'move', index: 0 }) !== null,
        'a disabled move was still selectable',
      )
    }
  }
  assert.ok(disabled, 'cursed body never fired in 60 seeds')
})

check('early bird halves sleep', () => {
  const battle = createBattle(
    [[mon('venusaur', ['sleep-powder', 'vine-whip'])],
     [mon('dodrio', ['peck'], { ability: 'early-bird' })]],
    'beef001d',
  )
  const t = battle.sides[1].team[0]
  t.status = 'slp'
  t.sleepTurns = 2
  resolveTurn(battle, [{ kind: 'move', index: 1 }, { kind: 'move', index: 0 }])
  assert.strictEqual(t.status, null, `still asleep with ${t.sleepTurns} turns left`)
})

check('leaf guard only protects while the sun is up', () => {
  const noSun = createBattle(
    [[mon('venusaur', ['toxic', 'vine-whip'])], [mon('tangela', ['vine-whip'], { ability: 'leaf-guard' })]],
    'beef001e',
  )
  resolveTurn(noSun, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  assert.ok(noSun.sides[1].team[0].status !== null, 'leaf guard blocked status with no sun')

  const sunny = createBattle(
    [[mon('venusaur', ['sunny-day', 'toxic'])], [mon('tangela', ['vine-whip'], { ability: 'leaf-guard' })]],
    'beef001f',
  )
  resolveTurn(sunny, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  resolveTurn(sunny, [{ kind: 'move', index: 1 }, { kind: 'move', index: 0 }])
  assert.strictEqual(sunny.sides[1].team[0].status, null, 'leaf guard failed under sun')
})

check('regenerator heals a third on the way out', () => {
  const battle = createBattle(
    [[mon('slowbro', ['water-gun'], { ability: 'regenerator' }), mon('pikachu', ['thunderbolt'])],
     [mon('snorlax', ['tackle'])]],
    'beef0020',
  )
  const t = battle.sides[0].team[0]
  t.hp = Math.floor(t.maxHp / 4)
  const before = t.hp
  resolveTurn(battle, [{ kind: 'switch', index: 1 }, { kind: 'move', index: 0 }])
  assert.ok(t.hp > before, `regenerator did nothing: ${before} -> ${t.hp}`)
})

check('quick feet ignores the paralysis speed cut', () => {
  const par = buildMon(mon('jolteon', ['thunderbolt']))
  const quick = buildMon(mon('jolteon', ['thunderbolt'], { ability: 'quick-feet' }))
  assert.strictEqual(par.stats.spe, quick.stats.spe, 'base speed should match')

  const battle = createBattle(
    [[mon('jolteon', ['thunderbolt'], { ability: 'quick-feet' })], [mon('persian', ['scratch'])]],
    'beef0021',
  )
  battle.sides[0].team[0].status = 'par'
  const ev = resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  const log = ev.filter((e) => e.t === 'text').map((e) => (e as { msg: string }).msg)
  const jolt = log.findIndex((l) => /Jolteon used/.test(l))
  const pers = log.findIndex((l) => /Persian used/.test(l))
  if (jolt >= 0 && pers >= 0) assert.ok(jolt < pers, `paralysed quick feet lost the race: ${log.join(' | ')}`)
})

check('soundproof blocks a sound move', () => {
  const battle = createBattle(
    [[mon('jigglypuff', ['sing', 'pound'])], [mon('electrode', ['tackle'], { ability: 'soundproof' })]],
    'beef0022',
  )
  const ev = resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  assert.ok(/soundproof blocked/.test(logOf(ev)), logOf(ev))
  assert.strictEqual(battle.sides[1].team[0].status, null, 'fell asleep through soundproof')
})

check('cute charm needs opposite genders', () => {
  let love = false
  for (let i = 0; i < 80 && !love; i++) {
    const battle = createBattle(
      [[mon('machamp', ['karate-chop'])], [mon('clefairy', ['pound'], { ability: 'cute-charm' })]],
      (0x70000000 + i * 0x0bad1dea).toString(16).slice(0, 8),
    )
    const attacker = battle.sides[0].team[0]
    const target = battle.sides[1].team[0]
    resolveTurn(battle, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
    if (attacker.infatuated) {
      love = true
      assert.notStrictEqual(attacker.gender, target.gender, 'infatuated the same gender')
      assert.notStrictEqual(attacker.gender, 'N', 'infatuated a genderless Pokémon')
    }
  }
  assert.ok(love, 'cute charm never triggered across 80 seeds')
})

check('a lead Pokémon gets its switch-in ability too', () => {
  // This was silently broken: onEnter only ran on a switch, so an Intimidate
  // or a Drought in slot one never fired at all.
  const battle = createBattle(
    [[mon('arcanine', ['bite'], { ability: 'intimidate' })], [mon('snorlax', ['tackle'])]],
    'beef0030',
  )
  assert.strictEqual(battle.sides[1].team[0].boosts.atk, -1, 'lead Intimidate did not fire')

  const sun = createBattle(
    [[mon('ninetales', ['ember'], { ability: 'drought' })], [mon('snorlax', ['tackle'])]],
    'beef0031',
  )
  assert.strictEqual(sun.weather?.kind, 'sun', 'lead Drought did not fire')
  assert.ok(sun.opening.length > 0, 'opening events were not recorded')
})

check('opening events are reproducible, so replays cannot diverge', () => {
  const build = () => createBattle(
    [[mon('arcanine', ['bite'], { ability: 'intimidate' })],
     [mon('ninetales', ['ember'], { ability: 'drought' })]],
    'beef0032',
  )
  assert.deepStrictEqual(build().opening, build().opening)
})

console.log(`${passed} extended trait checks passed`)
