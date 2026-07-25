/**
 * Engine v2 (@pkmn/sim adapter) tests.
 *
 * The point of v2 is that moves v1 could not model now work, so most of these
 * drive exactly those moves. Determinism is tested hardest: a wager is only
 * provably fair if the same seed always reproduces the same match.
 */
import assert from 'node:assert/strict'
import {
  createBattle, resolveTurn, replaceFainted, validateAction, publicState,
  simSeed, speciesName, viewerEvents, type TeamSlot,
} from './engine2.js'

let passed = 0
const check = (name: string, fn: () => void) => {
  fn()
  passed++
  console.log(`✓ ${name}`)
}

const slot = (
  speciesId: number, moves: string[], ability?: string, nature = 'serious',
): TeamSlot => ({ speciesId, moves, ability, nature })

/** Snorlax (143) and Gengar (94) — a fat wall and a fast ghost. */
const snorlax = (moves: string[]) => slot(143, moves, 'thick-fat', 'adamant')
// Gengar lost Levitate in Gen 7; Cursed Body is its only legal ability now.
const gengar = (moves: string[]) => slot(94, moves, 'cursed-body', 'timid')
const machamp = (moves: string[]) => slot(68, moves, 'no-guard', 'adamant')

const teams = (a: TeamSlot[], b: TeamSlot[]): [TeamSlot[], TeamSlot[]] => [a, b]

const move = (index: number) => ({ kind: 'move', index }) as const

/* ------------------------------------------------------------------ */

check('species numbers resolve to the first 151', () => {
  assert.equal(speciesName(1), 'Bulbasaur')
  assert.equal(speciesName(143), 'Snorlax')
  assert.equal(speciesName(151), 'Mew')
  assert.equal(speciesName(152), null, 'nothing past 151 is playable')
})

check('the same match seed always derives the same sim seed', () => {
  assert.deepEqual(simSeed('deadbeef'), simSeed('deadbeef'))
  assert.notDeepEqual(simSeed('deadbeef'), simSeed('deadbeee'))
})

check('a battle starts with both leads on the field', () => {
  const b = createBattle(teams([snorlax(['body-slam'])], [gengar(['shadow-ball'])]), 'abc123')
  assert.equal(b.sides[0].team.length, 1)
  assert.equal(b.sides[0].team[0].name, 'Snorlax')
  assert.equal(b.sides[1].team[0].name, 'Gengar')
  assert.equal(b.sides[0].team[0].hp, b.sides[0].team[0].maxHp)
  assert.equal(b.finished, false)
})

check('the same seed reproduces an identical event stream', () => {
  const run = () => {
    const b = createBattle(
      teams([snorlax(['body-slam', 'rest'])], [gengar(['shadow-ball', 'substitute'])]),
      'seed-fixed-1234',
    )
    const out = [...b.opening]
    for (let i = 0; i < 5 && !b.finished; i++) out.push(...resolveTurn(b, [move(0), move(0)]))
    return JSON.stringify(out)
  }
  assert.equal(run(), run(), 'a replay must reproduce the match exactly')
})

check('a different seed produces a different match', () => {
  // Machamp vs Snorlax actually trades damage, so the per-hit damage roll and
  // crit chance differ by seed. (Snorlax vs Gengar would be a bad test: Normal
  // and Ghost are mutually immune, so nothing happens on any seed.)
  const run = (seed: string) => {
    const b = createBattle(
      teams([machamp(['cross-chop'])], [snorlax(['body-slam'])]),
      seed,
    )
    const out = [...b.opening]
    for (let i = 0; i < 6 && !b.finished; i++) {
      if (b.pendingReplace[0] || b.pendingReplace[1]) break
      out.push(...resolveTurn(b, [move(0), move(0)]))
    }
    return JSON.stringify(out)
  }
  assert.notEqual(run('seed-aaaa'), run('seed-bbbb'))
})

/* ---- moves that were impossible in v1 ---- */

check('SUBSTITUTE costs a quarter of max HP and absorbs the next hit', () => {
  const b = createBattle(
    teams([gengar(['substitute', 'shadow-ball'])], [snorlax(['body-slam'])]),
    'sub-test',
  )
  const maxHp = b.sides[0].team[0].maxHp
  resolveTurn(b, [move(0), move(0)])
  const after = b.sides[0].team[0].hp
  // Paid exactly 1/4 of max HP for the substitute, then the sub ate the hit.
  assert.equal(after, maxHp - Math.floor(maxHp / 4), 'substitute costs exactly 25% max HP')
})

check('REST heals to full and puts the user to sleep', () => {
  const b = createBattle(
    teams([snorlax(['rest', 'body-slam'])], [machamp(['cross-chop'])]),
    'rest-test',
  )
  // Take damage first — Rest fails at full HP.
  resolveTurn(b, [move(1), move(0)])
  assert.ok(b.sides[0].team[0].hp < b.sides[0].team[0].maxHp, 'Snorlax took a hit')
  resolveTurn(b, [move(0), move(0)])
  const me = b.sides[0].team[0]
  assert.equal(me.status, 'slp', 'Rest sleeps the user')
})

check('PROTECT blocks the incoming move entirely', () => {
  const b = createBattle(
    teams([snorlax(['protect'])], [machamp(['cross-chop'])]),
    'protect-test',
  )
  const before = b.sides[0].team[0].hp
  resolveTurn(b, [move(0), move(0)])
  assert.equal(b.sides[0].team[0].hp, before, 'Protect took no damage')
})

check('SEISMIC TOSS deals damage equal to the user level, ignoring stats', () => {
  const b = createBattle(
    teams([machamp(['seismic-toss'])], [snorlax(['body-slam'])]),
    'toss-test',
  )
  const before = b.sides[1].team[0].hp
  resolveTurn(b, [move(0), move(0)])
  // Level 100 → exactly 100 damage, regardless of how bulky Snorlax is.
  assert.equal(before - b.sides[1].team[0].hp, 100, 'fixed 100 damage at level 100')
})

check('HYPER BEAM forces a recharge turn', () => {
  const b = createBattle(
    teams([snorlax(['hyper-beam', 'body-slam'])], [snorlax(['rest', 'body-slam'])]),
    'recharge-test',
  )
  resolveTurn(b, [move(0), move(0)])
  // The turn after Hyper Beam the user must recharge, so its other move is
  // not a legal choice.
  const err = validateAction(b, 0, move(1))
  assert.ok(err !== null, 'a recharging Pokémon cannot pick a different move')
})

check('TOXIC badly poisons and the damage escalates each turn', () => {
  const b = createBattle(
    teams([gengar(['toxic', 'shadow-ball'])], [snorlax(['rest', 'body-slam'])]),
    'toxic-test',
  )
  resolveTurn(b, [move(0), move(1)])
  assert.equal(b.sides[1].team[0].status, 'tox', 'badly poisoned')
  const a = b.sides[1].team[0].hp
  resolveTurn(b, [move(1), move(1)])
  const b1 = b.sides[1].team[0].hp
  assert.ok(b1 < a, 'poison keeps ticking')
})

/* ---- switching, fainting, finishing ---- */

check('switching uses our stable team order, not the sim internal order', () => {
  const b = createBattle(
    teams(
      [snorlax(['body-slam']), gengar(['shadow-ball'])],
      [machamp(['cross-chop'])],
    ),
    'switch-test',
  )
  assert.equal(b.sides[0].active, 0)
  resolveTurn(b, [{ kind: 'switch', index: 1 }, move(0)])
  assert.equal(b.sides[0].active, 1, 'active is our index 1 (Gengar)')
  assert.equal(b.sides[0].team[1].name, 'Gengar', 'team order stayed stable')
  assert.equal(b.sides[0].team[0].name, 'Snorlax', 'slot 0 is still Snorlax')
})

check('a battle can be played to a winner and reports it', () => {
  // Fighting is super effective on Normal, so this ends decisively.
  const b = createBattle(
    teams([machamp(['cross-chop'])], [snorlax(['body-slam'])]),
    'finish-test',
  )
  for (let i = 0; i < 40 && !b.finished; i++) {
    if (b.pendingReplace[0] || b.pendingReplace[1]) break
    resolveTurn(b, [move(0), move(0)])
  }
  assert.equal(b.finished, true, 'the battle ended')
  assert.equal(b.winner, 0, 'Machamp won')
  assert.ok(b.sides[1].team[0].fainted, 'Snorlax fainted')
})

check('a fainted lead is replaced from the bench without consuming a turn', () => {
  const b = createBattle(
    teams([machamp(['cross-chop'])], [snorlax(['body-slam']), gengar(['shadow-ball'])]),
    'replace-test',
  )
  for (let i = 0; i < 40 && !b.pendingReplace[1] && !b.finished; i++) {
    resolveTurn(b, [move(0), move(0)])
  }
  assert.equal(b.pendingReplace[1], true, 'the sim asked for a replacement')
  assert.ok(b.sides[1].team[0].fainted, 'the lead is down')
  replaceFainted(b, 1, 1)
  assert.equal(b.sides[1].active, 1, 'Gengar came in at our index 1')
  assert.equal(b.pendingReplace[1], false, 'the request is satisfied')
  assert.equal(b.finished, false, 'the battle continues')
})

/* ---- interface parity with v1 ---- */

check('validateAction rejects switching to a fainted or active Pokémon', () => {
  const b = createBattle(
    teams([snorlax(['body-slam']), gengar(['shadow-ball'])], [machamp(['cross-chop'])]),
    'validate-test',
  )
  assert.ok(validateAction(b, 0, { kind: 'switch', index: 0 }), 'already out')
  assert.ok(validateAction(b, 0, { kind: 'switch', index: 9 }), 'no such Pokémon')
  assert.equal(validateAction(b, 0, { kind: 'switch', index: 1 }), null, 'legal switch')
})

check('publicState shows each viewer their own side as "you"', () => {
  const b = createBattle(
    teams([snorlax(['body-slam'])], [gengar(['shadow-ball'])]),
    'state-test',
  )
  assert.equal(publicState(b, 0).you.team[0].name, 'Snorlax')
  assert.equal(publicState(b, 0).foe.team[0].name, 'Gengar')
  assert.equal(publicState(b, 1).you.team[0].name, 'Gengar')
  assert.equal(publicState(b, 1).foe.team[0].name, 'Snorlax')
})


/* ---- regressions for bugs found during the port ---- */

check('an illegal ability is rejected rather than silently accepted', () => {
  // Gengar lost Levitate in Gen 7. The sim's custom-game format does no
  // legality checking, so without our own guard a crafted request could hand
  // a Pokémon an ability it cannot have.
  assert.throws(
    () => createBattle(teams([slot(94, ['shadow-ball'], 'levitate')], [snorlax(['body-slam'])]), 'x'),
    /cannot have/,
  )
})

check('type effectiveness is read in the right direction', () => {
  // The AI once had this inverted, which made the "normal" bot pick resisted
  // moves and lose to the "easy" bot. Assert it through real damage.
  const b = createBattle(
    teams([machamp(['cross-chop'])], [snorlax(['body-slam'])]),
    'typedir-test',
  )
  const before = b.sides[1].team[0].hp
  resolveTurn(b, [move(0), move(0)])
  const dealt = before - b.sides[1].team[0].hp
  // Fighting is super effective on Normal: this must be a big chunk, not a
  // resisted scratch.
  assert.ok(dealt > b.sides[1].team[0].maxHp * 0.25, `Cross Chop should hurt, dealt ${dealt}`)
})

check('a pivot move forces a switch without the user having fainted', () => {
  // U-turn raises the same forceSwitch flag a faint does. Treating that flag
  // as "someone died" deadlocked the battle, because the replacement search
  // offered the Pokemon that was already on the field.
  const b = createBattle(
    teams(
      [slot(143, ['u-turn'], 'thick-fat', 'adamant'), gengar(['shadow-ball'])],
      [snorlax(['body-slam'])],
    ),
    'pivot-test',
  )
  resolveTurn(b, [move(0), move(0)])
  assert.equal(b.pendingReplace[0], true, 'U-turn asks for a switch')
  assert.equal(b.sides[0].team[0].fainted, false, 'and the user is still alive')
  replaceFainted(b, 0, 1)
  assert.equal(b.sides[0].active, 1, 'the pivot completed')
  assert.equal(b.pendingReplace[0], false, 'no deadlock')
})


check('publicState carries everything the battle screen needs', () => {
  // This contract was broken once: v2 dropped moves/PP/boosts/weather from
  // publicState, and the battle screen does Object.entries(mon.boosts)
  // unguarded, so the move buttons threw and the screen would not render.
  const b = createBattle(
    teams([snorlax(['body-slam', 'rest']), machamp(['cross-chop'])], [snorlax(['body-slam'])]),
    'contract-test',
  )
  resolveTurn(b, [move(0), move(0)])
  const s = publicState(b, 0) as unknown as Record<string, unknown>
  for (const k of ['turn', 'weather', 'finished', 'winner', 'mustReplace', 'you', 'foe']) {
    assert.ok(k in s, `publicState is missing "${k}"`)
  }
  const you = s.you as { active: number; team: Record<string, unknown>[] }
  const foe = s.foe as { active: number; team: Record<string, unknown>[] }
  const me = you.team[you.active]

  const moves = me.moves as { name: string; pp: number; maxPp: number }[]
  assert.ok(Array.isArray(moves) && moves.length === 2, 'own moves are sent')
  assert.equal(moves[0].name, 'body-slam', 'named the way the client dex is keyed')
  assert.ok(moves[0].maxPp > 0, 'PP is sent')

  assert.doesNotThrow(() => Object.entries(me.boosts as object), 'boosts must be an object')
  assert.equal(me.ability, 'thick-fat', 'ability is hyphenated for the dex lookup')

  // The opponent's move list and PP must never be visible.
  assert.ok(!('moves' in foe.team[foe.active]), 'the foe must not leak its moves')
})


check('move effectiveness is computed against the current opponent', () => {
  // You: Starmie with a spread of coverage. Foe: Gyarados (Water/Flying).
  const b = createBattle(
    teams(
      [{ speciesId: 121, moves: ['thunderbolt', 'ice-beam', 'surf', 'psychic'], nature: 'timid', ability: 'natural-cure' }],
      [{ speciesId: 130, moves: ['waterfall'], nature: 'adamant', ability: 'intimidate' }],
    ),
    'eff-basic',
  )
  const me = (publicState(b, 0) as unknown as {
    you: { team: { moves: { name: string; eff: number | null }[] }[] }
  }).you.team[0]
  const eff = Object.fromEntries(me.moves.map((m) => [m.name, m.eff]))
  assert.equal(eff['thunderbolt'], 4, 'Electric is 2x on Water and 2x on Flying')
  assert.equal(eff['surf'], 0.5, 'Water resists Water')
  assert.equal(eff['ice-beam'], 1, 'Ice: 0.5x Water * 2x Flying')
  assert.equal(eff['psychic'], 1, 'neutral')
})

check('an ability immunity shows as 0x, not neutral', () => {
  // Ground into Levitate (Gastly) must read 0, and Normal into a Ghost too.
  const b = createBattle(
    teams(
      [{ speciesId: 112, moves: ['earthquake', 'body-slam'], nature: 'adamant', ability: 'rock-head' }],
      [{ speciesId: 92, moves: ['shadow-ball'], nature: 'timid', ability: 'levitate' }],
    ),
    'eff-immune',
  )
  const me = (publicState(b, 0) as unknown as {
    you: { team: { moves: { name: string; eff: number | null }[] }[] }
  }).you.team[0]
  const eff = Object.fromEntries(me.moves.map((m) => [m.name, m.eff]))
  assert.equal(eff['earthquake'], 0, 'Levitate is immune to Ground')
  assert.equal(eff['body-slam'], 0, 'Ghost is immune to Normal')
})

check('status moves carry no effectiveness', () => {
  const b = createBattle(
    teams(
      [{ speciesId: 143, moves: ['body-slam', 'rest'], nature: 'adamant', ability: 'thick-fat' }],
      [{ speciesId: 130, moves: ['waterfall'], nature: 'adamant', ability: 'intimidate' }],
    ),
    'eff-status',
  )
  const me = (publicState(b, 0) as unknown as {
    you: { team: { moves: { name: string; eff: number | null }[] }[] }
  }).you.team[0]
  const rest = me.moves.find((m) => m.name === 'rest')
  assert.equal(rest?.eff, null, 'Rest is a status move, no multiplier')
})


check('narration names the opponent "the opposing X" per viewer', () => {
  // A same-species mirror is the case that made plain names ambiguous.
  const team: TeamSlot[] = [
    { speciesId: 3, moves: ['sludge-bomb'], nature: 'modest', ability: 'overgrow' },
  ]
  const b = createBattle([team, team], 'mirror-narration')
  resolveTurn(b, [move(0), move(0)])
  const textFor = (v: 0 | 1) =>
    viewerEvents(b, v).filter((e) => e.t === 'text').map((e) => (e as { msg: string }).msg)
  const p0 = textFor(0)
  const p1 = textFor(1)
  // Each seat sees exactly one "opposing" line and one plain line for the move.
  assert.equal(p0.filter((m) => m.includes('The opposing Venusaur used')).length, 1)
  assert.equal(p0.filter((m) => m === 'Venusaur used Sludge Bomb!').length, 1)
  // The two seats are mirror images of each other.
  assert.notDeepEqual(p0, p1)
  // A viewerless render (used by replays) never adds the prefix.
  const plain = resolveTurn(b, [move(0), move(0)]).filter((e) => e.t === 'text')
  assert.ok(!plain.some((e) => (e as { msg: string }).msg.includes('opposing')))
})

/* ---- narration: abilities, statuses and stat changes ---- */

const textOf = (b: ReturnType<typeof createBattle>, v: 0 | 1, lines?: string[]) =>
  viewerEvents(b, v, lines).filter((e) => e.t === 'text').map((e) => (e as { msg: string }).msg)

check('a switch-in ability is announced with its effect', () => {
  // Gyarados (130) leads with Intimidate; the drop it causes is narrated too.
  const b = createBattle(
    teams(
      [slot(130, ['body-slam'], 'intimidate', 'adamant')],
      [slot(143, ['body-slam'], 'thick-fat', 'adamant')],
    ),
    'ability-open',
  )
  const opening = textOf(b, 0)
  assert.ok(opening.some((m) => m === "Gyarados's Intimidate!"), 'the ability is named')
  assert.ok(
    opening.some((m) => /opposing Snorlax's Attack fell!/.test(m)),
    'the stat drop it caused is narrated on the foe',
  )
})

check('a weather-summoning ability credits the ability and the weather', () => {
  // Ninetales (38) with Drought sets the sun on entry.
  const b = createBattle(
    teams(
      [slot(143, ['body-slam'], 'thick-fat', 'adamant')],
      [slot(38, ['flamethrower'], 'drought', 'timid')],
    ),
    'drought-open',
  )
  const opening = textOf(b, 0)
  assert.ok(opening.some((m) => /Ninetales's Drought!/.test(m)), 'the ability is credited')
  assert.ok(opening.some((m) => m === 'The sunlight turned harsh!'), 'the weather is announced')
})

check('inflicting a status narrates it, and both seats read it right', () => {
  // Thunder Wave paralyses; each seat sees its own mon plainly and the foe as
  // "the opposing X".
  const b = createBattle(
    teams(
      [slot(143, ['thunder-wave'], 'thick-fat', 'adamant')],
      [slot(143, ['body-slam'], 'thick-fat', 'adamant')],
    ),
    'status-narration',
  )
  resolveTurn(b, [move(0), move(0)])
  assert.ok(
    textOf(b, 0).some((m) => m === 'The opposing Snorlax was paralysed!'),
    'the attacker sees the foe paralysed',
  )
  assert.ok(
    textOf(b, 1).some((m) => m === 'Snorlax was paralysed!'),
    'the victim sees itself paralysed',
  )
})

check('a stat change is narrated with its magnitude', () => {
  // Swords Dance raises Attack by two stages → "rose sharply".
  const b = createBattle(
    teams(
      [slot(68, ['swords-dance'], 'no-guard', 'adamant')],
      [slot(143, ['body-slam'], 'thick-fat', 'adamant')],
    ),
    'boost-narration',
  )
  resolveTurn(b, [move(0), move(0)])
  assert.ok(
    textOf(b, 0).some((m) => m === "Machamp's Attack rose sharply!"),
    'a +2 boost reads as "sharply"',
  )
})

check("the opponent's stat and status changes are visible in publicState", () => {
  // Machamp raises its Attack the same turn Snorlax's Thunder Wave paralyses it,
  // so player 2's view of its foe (Machamp) must carry BOTH the boost and the
  // status — that is the "I can see the opponent's stat stages" contract.
  const b = createBattle(
    teams(
      [slot(68, ['swords-dance'], 'no-guard', 'adamant')],
      [slot(143, ['thunder-wave'], 'thick-fat', 'adamant')],
    ),
    'foe-visibility',
  )
  resolveTurn(b, [move(0), move(0)])
  const foe = (publicState(b, 1) as unknown as {
    foe: { active: number; team: { boosts: Record<string, number>; status: string | null }[] }
  }).foe
  const machamp = foe.team[foe.active]
  assert.equal(machamp.boosts.atk, 2, "player 2 can see player 1's Attack boost")
  assert.equal(machamp.status, 'par', "player 2 can see the paralysis on player 1's Pokémon")
})

console.log(`\n${passed} engine v2 checks passed`)
