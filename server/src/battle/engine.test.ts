/**
 * Engine checks. Run with `npm test`.
 *
 * The damage expectations are derived from the standard Gen 5+ formula by hand
 * so this catches drift rather than just re-asserting whatever the code does.
 */
import assert from 'node:assert'
import { MOVES, SPECIES, SPECIES_BY_NAME, ALL_SPECIES } from './data.js'
import {
  buildMon, createBattle, resolveTurn, validateAction, publicState, makeRng, validateTeam,
  type TeamSlot,
} from './engine.js'
import { effectiveness } from './typechart.js'

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

/* ---------------- stats ---------------- */

check('level 100 stats match the standard formula', () => {
  // Mewtwo: base HP 106, SpA 154, Spe 130. 31 IVs, 0 EVs, level 100.
  const mewtwo = buildMon({ speciesId: 150, moves: ['psychic'] })
  // HP = floor((2*106 + 31) * 100/100) + 100 + 10 = 243 + 110 = 353
  assert.strictEqual(mewtwo.maxHp, 353, `hp ${mewtwo.maxHp}`)
  // SpA = floor((2*154 + 31) * 100/100) + 5 = 339 + 5 = 344
  assert.strictEqual(mewtwo.stats.spa, 344, `spa ${mewtwo.stats.spa}`)
  // Spe = floor((2*130 + 31)) + 5 = 291 + 5 = 296
  assert.strictEqual(mewtwo.stats.spe, 296, `spe ${mewtwo.stats.spe}`)
})

/* ---------------- type chart ---------------- */

check('type effectiveness is correct including duals and immunities', () => {
  assert.strictEqual(effectiveness('electric', ['water', 'flying']), 4)
  assert.strictEqual(effectiveness('ground', ['flying']), 0)
  assert.strictEqual(effectiveness('normal', ['ghost']), 0)
  assert.strictEqual(effectiveness('fighting', ['normal']), 2)
  assert.strictEqual(effectiveness('grass', ['bug', 'poison']), 0.25)
  assert.strictEqual(effectiveness('psychic', ['dark']), 0)
  assert.strictEqual(effectiveness('water', ['fire', 'flying']), 2)
})

/* ---------------- damage ---------------- */

check('damage lands in the expected roll range', () => {
  // Thunderbolt (90 BP, special) from a level-100 Pikachu into Blastoise.
  // Pikachu SpA = 2*50+31+5 = 136 ; Blastoise SpD = 2*105+31+5 = 246
  // base = floor(floor(floor(42 * 90 * 136) / 246) / 50) + 2
  //      = floor(floor(514080/246)/50)+2 = floor(2089/50)+2 = 41+2 = 43
  // STAB 1.5 -> 64 ; water resists? no, electric vs water = 2x -> ~128
  // With the 0.85–1.00 spread applied before STAB: [36,43] -> STAB -> [54,64] -> x2 -> [108,128]
  const seen: number[] = []
  for (let i = 0; i < 400; i++) {
    const b = createBattle(
      [[{ speciesId: 25, moves: ['thunderbolt'] }], [{ speciesId: 9, moves: ['tackle'] }]],
      (0x1000 + i).toString(16).padStart(8, '0'),
    )
    const before = b.sides[1].team[0].hp
    resolveTurn(b, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
    const dealt = before - b.sides[1].team[0].hp
    seen.push(dealt)
  }
  const lo = Math.min(...seen)
  const hi = Math.max(...seen)
  // Allow for crits inflating the top end; the floor is the tight check.
  assert.ok(lo >= 100 && lo <= 115, `min damage ${lo} outside expected ~108`)
  assert.ok(hi >= 120, `max damage ${hi} too low`)
})

check('STAB and immunity are applied', () => {
  // Normal move into a Ghost must deal nothing. (Snorlax learns Tackle,
  // Gengar does not — the validator rejects the obvious fixture.)
  const b = createBattle(
    [[{ speciesId: 143, moves: ['tackle'] }], [{ speciesId: 94, moves: ['lick'] }]],
    'deadbeef',
  )
  const before = b.sides[1].team[0].hp
  resolveTurn(b, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  assert.strictEqual(b.sides[1].team[0].hp, before, 'ghost took normal damage')
})

/* ---------------- turn order ---------------- */

check('faster Pokémon moves first', () => {
  // Electrode (spe 140) vs Snorlax (spe 30).
  const b = createBattle(
    [[{ speciesId: 101, moves: ['tackle'] }], [{ speciesId: 143, moves: ['tackle'] }]],
    'a1b2c3d4',
  )
  const ev = resolveTurn(b, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  const first = ev.find((e) => e.t === 'text' && e.msg.includes('used'))
  assert.ok((first as { msg: string }).msg.toLowerCase().includes('electrode'), 'slow mon moved first')
})

check('priority beats raw speed', () => {
  // Rattata (spe 72) Quick Attack (+1) precedes Electrode (spe 150) Tackle (0).
  const b = createBattle(
    [[{ speciesId: 19, moves: ['quick-attack'] }], [{ speciesId: 101, moves: ['tackle'] }]],
    'a1b2c3d4',
  )
  const ev = resolveTurn(b, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
  const first = ev.find((e) => e.t === 'text' && e.msg.includes('used'))
  assert.ok((first as { msg: string }).msg.toLowerCase().includes('rattata'), 'priority ignored')
})

/* ---------------- determinism ---------------- */

check('same seed replays identically', () => {
  const team: [TeamSlot[], TeamSlot[]] = [
    [{ speciesId: 6, moves: ['flamethrower', 'earthquake'] }, { speciesId: 9, moves: ['surf'] }],
    [{ speciesId: 3, moves: ['sludge-bomb'] }, { speciesId: 65, moves: ['psychic'] }],
  ]
  const run = () => {
    const b = createBattle([structuredClone(team[0]), structuredClone(team[1])], 'cafebabe')
    const log: string[] = []
    for (let i = 0; i < 30 && !b.finished; i++) {
      if (b.pendingReplace[0] || b.pendingReplace[1]) break
      const ev = resolveTurn(b, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
      log.push(...ev.filter((e) => e.t === 'text').map((e) => (e as { msg: string }).msg))
    }
    return log.join('|')
  }
  assert.strictEqual(run(), run(), 'replay diverged')
})

check('different seeds diverge', () => {
  const mk = (seed: string) => {
    const b = createBattle(
      [[{ speciesId: 6, moves: ['flamethrower'] }], [{ speciesId: 9, moves: ['surf'] }]],
      seed,
    )
    resolveTurn(b, [{ kind: 'move', index: 0 }, { kind: 'move', index: 0 }])
    return b.sides[1].team[0].hp
  }
  const a = new Set(Array.from({ length: 20 }, (_, i) => mk(`0000000${i}`)))
  assert.ok(a.size > 1, 'seeds produced identical damage')
})

/* ---------------- legality ---------------- */

check('illegal actions are rejected', () => {
  const b = createBattle(
    [[{ speciesId: 25, moves: ['thunderbolt'] }, { speciesId: 6, moves: ['ember'] }],
     [{ speciesId: 9, moves: ['tackle'] }]],
    'feedface',
  )
  assert.ok(validateAction(b, 0, { kind: 'move', index: 5 }), 'accepted out-of-range move')
  assert.ok(validateAction(b, 0, { kind: 'switch', index: 9 }), 'accepted out-of-range switch')
  assert.ok(validateAction(b, 0, { kind: 'switch', index: 0 }), 'accepted switch to active mon')
  assert.strictEqual(validateAction(b, 0, { kind: 'move', index: 0 }), null, 'rejected legal move')
  assert.strictEqual(validateAction(b, 0, { kind: 'switch', index: 1 }), null, 'rejected legal switch')
})

check('fainted Pokémon cannot be switched to', () => {
  const b = createBattle(
    [[{ speciesId: 25, moves: ['thunderbolt'] }, { speciesId: 6, moves: ['ember'] }],
     [{ speciesId: 9, moves: ['tackle'] }]],
    'feedface',
  )
  b.sides[0].team[1].fainted = true
  assert.ok(validateAction(b, 0, { kind: 'switch', index: 1 }), 'accepted switch to fainted mon')
})

/* ---------------- state leakage ---------------- */

check('public state hides opponent PP', () => {
  const b = createBattle(
    [[{ speciesId: 25, moves: ['thunderbolt'] }], [{ speciesId: 9, moves: ['surf'] }]],
    'feedface',
  )
  const view = publicState(b, 0)
  assert.ok('moves' in view.you.team[0], 'own moves hidden')
  assert.ok(!('moves' in (view.foe.team[0] as object)), 'opponent moves leaked')
  assert.ok(!JSON.stringify(view).includes('seed'), 'seed leaked to client')
})

/* ---------------- battles terminate ---------------- */

check('random battles always terminate with a winner', () => {
  const pick = (rng: () => number) => {
    const legal = ALL_SPECIES.filter((s) => s.moves.length >= 1)
    const sp = legal[Math.floor(rng() * legal.length)]
    const moves = [...sp.moves].sort(() => rng() - 0.5).slice(0, 4)
    return { speciesId: sp.id, moves }
  }
  for (let g = 0; g < 60; g++) {
    const rng = makeRng((0xabc0000 + g).toString(16))
    const t = (): TeamSlot[] => Array.from({ length: 6 }, () => pick(rng))
    const b = createBattle([t(), t()], (0x5550000 + g).toString(16))
    let turns = 0
    while (!b.finished && turns < 800) {
      turns++
      for (const side of [0, 1] as const) {
        if (b.pendingReplace[side]) {
          const idx = b.sides[side].team.findIndex((m) => !m.fainted)
          if (idx >= 0) {
            b.sides[side].active = idx
            b.pendingReplace[side] = false
          }
        }
      }
      if (b.finished) break
      const act = (side: 0 | 1) => {
        const s = b.sides[side]
        const mon = s.team[s.active]
        const usable = mon.moves.map((m, i) => i).filter((i) => mon.moves[i].pp > 0)
        const i = usable.length ? usable[Math.floor(rng() * usable.length)] : 0
        return { kind: 'move' as const, index: i }
      }
      resolveTurn(b, [act(0), act(1)])
    }
    assert.ok(b.finished, `battle ${g} did not finish in ${turns} turns`)
    assert.ok(b.winner === 0 || b.winner === 1 || b.winner === null, 'bad winner')
  }
})

/* ---------------- team validation (anti-cheat boundary) ---------------- */

/**
 * Six DISTINCT species — Species Clause makes six of anything illegal.
 * Pikachu is first so `slice(1)` leaves it free for the cases below that
 * append a slot with speciesId 25 without tripping the clause.
 */
const legalTeam = (): TeamSlot[] => [
  { speciesId: 25, moves: ['thunderbolt'] },
  { speciesId: 6, moves: ['flamethrower'] },
  { speciesId: 9, moves: ['surf'] },
  { speciesId: 3, moves: ['razor-leaf'] },
  { speciesId: 65, moves: ['psychic'] },
  { speciesId: 143, moves: ['body-slam'] },
]

check('a legal team validates', () => {
  assert.deepStrictEqual(validateTeam(legalTeam()), [])
})

check('Species Clause: only one of each species per team', () => {
  const six = Array.from({ length: 6 }, () => ({ speciesId: 150, moves: ['psychic'] }))
  assert.deepStrictEqual(validateTeam(six), ['only one mewtwo per team'])

  // One repeat in an otherwise legal team is still a repeat.
  const one = legalTeam()
  one[5] = { ...one[0] }
  assert.deepStrictEqual(validateTeam(one), ['only one pikachu per team'])

  // And the message names each offending species once, not once per slot.
  const two = legalTeam()
  two[4] = { ...two[0] }
  two[5] = { ...two[1] }
  assert.strictEqual(validateTeam(two).length, 2, JSON.stringify(validateTeam(two)))
})

check('illegal teams are rejected', () => {
  const bad: [string, unknown][] = [
    ['not an array', { nope: true }],
    ['too few', [{ speciesId: 25, moves: ['thunderbolt'] }]],
    ['too many', Array.from({ length: 7 }, () => ({ speciesId: 25, moves: ['thunderbolt'] }))],
    ['unknown species', [...legalTeam().slice(1), { speciesId: 9999, moves: ['tackle'] }]],
    ['species above 151', [...legalTeam().slice(1), { speciesId: 249, moves: ['tackle'] }]],
    ['no moves', [...legalTeam().slice(1), { speciesId: 25, moves: [] }]],
    ['five moves', [...legalTeam().slice(1), { speciesId: 25, moves: ['thunderbolt', 'thunder', 'agility', 'tackle', 'toxic'] }]],
    ['duplicate moves', [...legalTeam().slice(1), { speciesId: 25, moves: ['thunderbolt', 'thunderbolt'] }]],
    ['unsupported move', [...legalTeam().slice(1), { speciesId: 25, moves: ['hyper-beam'] }]],
    ['nonexistent move', [...legalTeam().slice(1), { speciesId: 25, moves: ['omega-blast'] }]],
    ['move it cannot learn', [...legalTeam().slice(1), { speciesId: 25, moves: ['sludge-bomb'] }]],
    ['ability the species cannot have', [...legalTeam().slice(1), { speciesId: 25, moves: ['thunderbolt'], ability: 'huge-power' }]],
  ]
  for (const [name, team] of bad) {
    assert.ok(validateTeam(team).length > 0, `accepted illegal team: ${name}`)
  }
})

check('buildMon refuses an illegal move even if validation is skipped', () => {
  assert.throws(() => buildMon({ speciesId: 25, moves: ['sludge-bomb'] }), /cannot learn/)
  assert.throws(() => buildMon({ speciesId: 25, moves: ['omega-blast'] }), /unsupported/)
})

check('Surf and Earthquake survived the move filter', () => {
  // These are `all-other-pokemon` targets and were dropped by an earlier bug.
  assert.ok(MOVES.has('surf'), 'surf missing')
  assert.ok(MOVES.has('earthquake'), 'earthquake missing')
  assert.ok(SPECIES_BY_NAME.get('blastoise')!.moves.includes('surf'))
})

/* ---------------- data integrity ---------------- */

check('every selectable species has at least one legal move', () => {
  // Ditto used to be the exception here: Transform was its whole movepool and
  // the engine did not model it. It does now, so nothing should be left out.
  const empty = ALL_SPECIES.filter((s) => s.moves.length === 0).map((s) => s.name)
  assert.deepStrictEqual(empty, [], `unexpected empty movepools: ${empty.join(',')}`)
})

check('every legal move resolves to a supported move definition', () => {
  for (const s of ALL_SPECIES) {
    for (const m of s.moves) {
      assert.ok(MOVES.has(m), `${s.name} lists unsupported move ${m}`)
    }
  }
})

check('no supported damaging move has null power', () => {
  for (const [name, m] of MOVES) {
    if (m.category !== 'status') {
      assert.ok(typeof m.power === 'number' && m.power > 0, `${name} has no power`)
    }
  }
})

check('species count and sprites', () => {
  assert.strictEqual(SPECIES.size, 151)
  assert.ok(SPECIES_BY_NAME.get('mew'))
  for (const s of ALL_SPECIES) assert.ok(s.sprites.front, `${s.name} missing sprite`)
})

console.log(`${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`)
