/**
 * Server-authoritative battle engine.
 *
 * Nothing here reads from the client beyond an action index. All state, all
 * randomness and all legality checks live on this side — a tampered client can
 * at most send an illegal action, which is rejected.
 *
 * Randomness comes from a seeded PRNG. The server publishes `hash(seed)` when
 * the battle starts and reveals `seed` when it ends, so either player can
 * replay the whole match afterwards and confirm nothing was fudged.
 */
import { MOVES, SPECIES, type Move, type Species } from './data.js'
import { effectiveness, type PokeType } from './typechart.js'
import { ABILITIES, NO_ABILITY, inGroup, type Ability, type Weather } from './abilities.js'

export type { Weather }
import { NATURE_BY_NAME, DEFAULT_NATURE, natureMultiplier, type NatureStat } from './natures.js'

export const LEVEL = 100
const IV = 31
const EV = 0

export type StatKey = 'atk' | 'def' | 'spa' | 'spd' | 'spe'
export type BoostKey = StatKey | 'acc' | 'eva'
export type Status = 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz' | null

export type TeamSlot = {
  speciesId: number
  moves: string[]
  /** Nature name; defaults to a neutral one when absent. */
  nature?: string
  /** Ability name, or 'none'. Must be one the species can legally have. */
  ability?: string
}

export type BattleMon = {
  speciesId: number
  name: string
  types: PokeType[]
  level: number
  maxHp: number
  hp: number
  stats: Record<StatKey, number>
  moves: { name: string; pp: number; maxPp: number }[]
  status: Status
  /** Remaining forced-sleep turns. */
  sleepTurns: number
  /** Accumulating badly-poison counter. */
  toxCounter: number
  confusionTurns: number
  boosts: Record<BoostKey, number>
  flinched: boolean
  fainted: boolean
  nature: string
  ability: Ability | null
  /** The ability it started with, restored if Trace or Imposter overwrote it. */
  baseAbility: Ability | null
  /** True while Neutralizing Gas is switching this ability off. */
  suppressed: boolean
  /** Set once a draw-in ability has absorbed its type this battle. */
  drawnIn: boolean
  /** 'N' for the genderless. Cute Charm and Rivalry are the only readers. */
  gender: 'M' | 'F' | 'N'
  /** Infatuated Pokémon fail to move half the time. */
  infatuated: boolean
  /** Move locked out by Cursed Body, and how many turns remain. */
  disabled: { move: string; turns: number } | null
  /** Set while Imposter is wearing another Pokémon's shape. */
  transformed: boolean
  /** What to put back when a transformation ends. */
  preTransform: { types: PokeType[]; stats: Record<StatKey, number>; moves: BattleMon['moves'] } | null

  /* -------- scripted-move state -------- */

  /** Remaining HP of an active Substitute; 0 when there is none. */
  substituteHp: number
  /** True for the turn a Protect/Detect succeeded. */
  protecting: boolean
  /** True for the turn an Endure succeeded. */
  enduring: boolean
  /**
   * Consecutive successful Protect-family uses. Each one makes the next
   * attempt fail more often (1/3, 1/9, …), which is what stops it locking a
   * match up forever.
   */
  protectStreak: number
  /** Bide charges for two turns, then hits back for double what it stored. */
  bide: { turns: number; damage: number } | null
  /**
   * A move the Pokémon is committed to for the next few turns (Bide, and the
   * Thrash family). While set, the chosen action is ignored and this runs
   * instead, without spending further PP.
   */
  lockedMove: { move: string; turns: number } | null
  /** Rage raises Attack every time the user is hit while it is up. */
  raging: boolean
  /** The last move this Pokémon successfully used — Mimic copies it. */
  lastMove: string | null
  /** Damage this Pokémon took this turn, and from which category. */
  tookThisTurn: { physical: number; special: number }
  /** Ghost-type Curse drains a quarter of max HP every turn. */
  cursed: boolean
}

export type Side = {
  player: 0 | 1
  team: BattleMon[]
  active: number
}

export type Action =
  | { kind: 'move'; index: number }
  | { kind: 'switch'; index: number }

export type BattleEvent =
  // `side` marks which trainer a line is about, so the log can label it "You"
  // vs the opponent. Omitted for neutral lines (weather, "super effective",
  // turn dividers). v1 never sets it; it is filled in by the v2 translator.
  | { t: 'text'; msg: string; side?: 0 | 1 }
  | { t: 'damage'; side: 0 | 1; slot: number; hp: number; maxHp: number }
  | { t: 'heal'; side: 0 | 1; slot: number; hp: number; maxHp: number }
  | { t: 'faint'; side: 0 | 1; slot: number }
  | { t: 'switch'; side: 0 | 1; slot: number }
  | { t: 'status'; side: 0 | 1; slot: number; status: Status }
  | { t: 'boost'; side: 0 | 1; slot: number; stat: BoostKey; by: number }
  | { t: 'weather'; kind: Weather | null }
  | { t: 'end'; winner: 0 | 1 | null }

export type Battle = {
  sides: [Side, Side]
  turn: number
  rng: () => number
  seed: string
  finished: boolean
  winner: 0 | 1 | null
  /** Set when a side must switch after a faint before the next turn runs. */
  pendingReplace: [boolean, boolean]
  /** Active weather and the turns it has left, or null for clear skies. */
  weather: { kind: Weather; turns: number } | null
  /**
   * What the two leads' switch-in abilities did before turn 1.
   *
   * Produced inside createBattle so a live match and a replay derive it from
   * the same seed in the same order, and never disagree.
   */
  opening: BattleEvent[]
}

/* ------------------------------------------------------------------ */
/* RNG                                                                 */
/* ------------------------------------------------------------------ */

/** mulberry32 — small, fast, and reproducible from a 32-bit seed. */
export function makeRng(seedHex: string): () => number {
  let a = parseInt(seedHex.slice(0, 8), 16) >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const randInt = (rng: () => number, min: number, max: number) =>
  min + Math.floor(rng() * (max - min + 1))

/* ------------------------------------------------------------------ */
/* Construction                                                        */
/* ------------------------------------------------------------------ */

function calcStats(base: Species['stats'], natureName: string) {
  const nature = NATURE_BY_NAME.get(natureName)
  // Nature is applied after the base calculation and truncated, exactly as the
  // games do — applying it earlier would round differently.
  const other = (b: number, key: NatureStat) =>
    Math.floor(
      (Math.floor(((2 * b + IV + Math.floor(EV / 4)) * LEVEL) / 100) + 5) *
        natureMultiplier(nature, key),
    )
  return {
    // HP is never touched by nature.
    hp: Math.floor(((2 * base.hp + IV + Math.floor(EV / 4)) * LEVEL) / 100) + LEVEL + 10,
    atk: other(base.atk, 'atk'),
    def: other(base.def, 'def'),
    spa: other(base.spa, 'spa'),
    spd: other(base.spd, 'spd'),
    spe: other(base.spe, 'spe'),
  }
}

export const TEAM_SIZE = 6
export const MAX_MOVES = 4

/**
 * Rejects anything the engine cannot faithfully run: unknown species, moves the
 * species cannot learn, duplicate moves, wrong team size. Returns a list of
 * problems (empty means the team is legal).
 *
 * This is the only thing standing between a crafted request and a team of six
 * Mewtwo with moves they cannot learn, so the server must call it on every
 * team it stores and again before every battle.
 */
export function validateTeam(team: unknown): string[] {
  const errs: string[] = []
  if (!Array.isArray(team)) return ['team must be an array']
  if (team.length !== TEAM_SIZE) errs.push(`team must have exactly ${TEAM_SIZE} Pokémon`)

  // Species Clause: one of each. Without it the whole format collapses into
  // six of whatever is strongest, which is why every competitive ruleset has
  // this. It is enforced here rather than only in the builder because the
  // builder is a convenience — this is the boundary a crafted request hits.
  const seen = new Set<number>()
  const repeated = new Set<number>()
  for (const slot of team as Partial<TeamSlot>[]) {
    const id = slot?.speciesId
    if (typeof id !== 'number') continue
    if (seen.has(id)) repeated.add(id)
    seen.add(id)
  }
  for (const id of repeated) {
    errs.push(`only one ${SPECIES.get(id)?.name ?? `species ${id}`} per team`)
  }

  team.forEach((slot: unknown, i: number) => {
    const at = `slot ${i + 1}`
    if (typeof slot !== 'object' || slot === null) return errs.push(`${at}: malformed`)
    const s = slot as Partial<TeamSlot>

    const sp = typeof s.speciesId === 'number' ? SPECIES.get(s.speciesId) : undefined
    if (!sp) return errs.push(`${at}: unknown species`)
    if (sp.moves.length === 0) return errs.push(`${at}: ${sp.name} has no usable moves`)

    if (!Array.isArray(s.moves) || s.moves.length < 1 || s.moves.length > MAX_MOVES) {
      return errs.push(`${at}: needs 1–${MAX_MOVES} moves`)
    }
    if (new Set(s.moves).size !== s.moves.length) errs.push(`${at}: duplicate moves`)

    for (const mv of s.moves) {
      if (typeof mv !== 'string' || !MOVES.has(mv)) {
        errs.push(`${at}: unsupported move "${mv}"`)
      } else if (!sp.moves.includes(mv)) {
        errs.push(`${at}: ${sp.name} cannot learn ${mv}`)
      }
    }

    if (s.nature !== undefined) {
      if (typeof s.nature !== 'string' || !NATURE_BY_NAME.has(s.nature)) {
        errs.push(`${at}: unknown nature "${s.nature}"`)
      }
    }

    // An ability must be one this species can actually have, or none at all —
    // otherwise a crafted request could hand Magikarp Huge Power.
    if (s.ability !== undefined && s.ability !== NO_ABILITY) {
      if (typeof s.ability !== 'string' || !ABILITIES.has(s.ability)) {
        errs.push(`${at}: unsupported ability "${s.ability}"`)
      } else if (!sp.abilities.some((a) => a.name === s.ability)) {
        errs.push(`${at}: ${sp.name} cannot have ${s.ability}`)
      }
    }
  })

  return errs
}

export function buildMon(slot: TeamSlot): BattleMon {
  const sp = SPECIES.get(slot.speciesId)
  if (!sp) throw new Error(`unknown species ${slot.speciesId}`)
  for (const mv of slot.moves) {
    // Defence in depth: validateTeam should have caught this already.
    if (!MOVES.has(mv)) throw new Error(`unsupported move ${mv}`)
    if (!sp.moves.includes(mv)) throw new Error(`${sp.name} cannot learn ${mv}`)
  }
  if (slot.ability && slot.ability !== NO_ABILITY) {
    if (!ABILITIES.has(slot.ability)) throw new Error(`unsupported ability ${slot.ability}`)
    if (!sp.abilities.some((a) => a.name === slot.ability)) {
      throw new Error(`${sp.name} cannot have ${slot.ability}`)
    }
  }

  const nature = slot.nature ?? DEFAULT_NATURE
  const ability = slot.ability && slot.ability !== NO_ABILITY
    ? ABILITIES.get(slot.ability) ?? null
    : null

  const s = calcStats(sp.stats, nature)
  return {
    nature,
    ability,
    baseAbility: ability,
    suppressed: false,
    drawnIn: false,
    // Overwritten with a real roll in createBattle, which owns the RNG.
    gender: 'N',
    infatuated: false,
    disabled: null,
    transformed: false,
    preTransform: null,
    speciesId: sp.id,
    name: sp.name,
    types: sp.types,
    level: LEVEL,
    maxHp: s.hp,
    hp: s.hp,
    stats: { atk: s.atk, def: s.def, spa: s.spa, spd: s.spd, spe: s.spe },
    moves: slot.moves.map((n) => {
      const m = MOVES.get(n)!
      return { name: n, pp: m.pp, maxPp: m.pp }
    }),
    status: null,
    sleepTurns: 0,
    toxCounter: 0,
    confusionTurns: 0,
    boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 },
    flinched: false,
    fainted: false,
    substituteHp: 0,
    protecting: false,
    enduring: false,
    protectStreak: 0,
    bide: null,
    lockedMove: null,
    raging: false,
    lastMove: null,
    tookThisTurn: { physical: 0, special: 0 },
    cursed: false,
  }
}

export function createBattle(teams: [TeamSlot[], TeamSlot[]], seed: string): Battle {
  const rng = makeRng(seed)
  const b: Battle = {
    sides: [
      { player: 0, team: teams[0].map(buildMon), active: 0 },
      { player: 1, team: teams[1].map(buildMon), active: 0 },
    ],
    turn: 0,
    rng,
    seed,
    finished: false,
    winner: null,
    pendingReplace: [false, false],
    weather: null,
    opening: [],
  }

  // Gender is rolled from the seed rather than chosen, so it stays out of team
  // building but still reproduces exactly on replay.
  for (const side of [0, 1] as const) {
    for (const mon of b.sides[side].team) {
      const rate = SPECIES.get(mon.speciesId)?.genderRate ?? -1
      mon.gender = rate < 0 ? 'N' : rng() < rate / 8 ? 'F' : 'M'
    }
  }

  // Leads get their switch-in abilities too. Without this, an Intimidate or a
  // Drought in slot one would silently never fire — only ones brought in by a
  // later switch would. Faster Pokémon go first, as in the games.
  refreshSuppression(b)
  const order: (0 | 1)[] =
    effStat(b.sides[0].team[0], 'spe') >= effStat(b.sides[1].team[0], 'spe') ? [0, 1] : [1, 0]
  for (const side of order) onEnter(b, side, b.opening)

  return b
}

/* ------------------------------------------------------------------ */
/* Abilities in force                                                  */
/* ------------------------------------------------------------------ */

/**
 * The ability actually doing anything right now.
 *
 * Neutralizing Gas switches every other ability on the field off, so nothing
 * may read `mon.ability` directly — going through here is what keeps that
 * honest. `suppressed` is recomputed whenever the actives change.
 */
const A = (mon: BattleMon): Ability | null => (mon.suppressed ? null : mon.ability)

function refreshSuppression(b: Battle) {
  const gas = ([0, 1] as const).some((s) => {
    const m = b.sides[s].team[b.sides[s].active]
    return !m.fainted && m.ability?.neutralizingGas
  })
  for (const s of [0, 1] as const) {
    for (const m of b.sides[s].team) {
      m.suppressed = gas && !m.ability?.neutralizingGas
    }
  }
}

/** Weather as far as the battle is concerned — Cloud Nine blanks it out. */
function sky(b: Battle): Weather | null {
  if (!b.weather) return null
  for (const s of [0, 1] as const) {
    const m = b.sides[s].team[b.sides[s].active]
    if (!m.fainted && A(m)?.suppressWeather) return null
  }
  return b.weather.kind
}

/* ------------------------------------------------------------------ */
/* Stat helpers                                                        */
/* ------------------------------------------------------------------ */

const BOOST_MULT = [2 / 8, 2 / 7, 2 / 6, 2 / 5, 2 / 4, 2 / 3, 1, 3 / 2, 4 / 2, 5 / 2, 6 / 2, 7 / 2, 8 / 2]
const ACC_MULT = [3 / 9, 3 / 8, 3 / 7, 3 / 6, 3 / 5, 3 / 4, 1, 4 / 3, 5 / 4, 6 / 5, 7 / 6, 8 / 7, 9 / 3]

const boostMult = (stage: number) => BOOST_MULT[Math.max(-6, Math.min(6, stage)) + 6]
const accMult = (stage: number) => ACC_MULT[Math.max(-6, Math.min(6, stage)) + 6]

/** Effective stat, optionally ignoring boosts (crits ignore unfavourable ones). */
function effStat(
  mon: BattleMon, key: StatKey, ignoreBoost = false, weather: Weather | null = null,
): number {
  let v = mon.stats[key] * (ignoreBoost ? 1 : boostMult(mon.boosts[key]))
  const ab = A(mon)

  if (key === 'atk') {
    // Guts turns a burn into an advantage, so it also cancels the burn's own
    // Attack cut rather than stacking with it.
    const guts = ab?.atkMult?.when === 'statused' && mon.status !== null
    if (mon.status === 'brn' && !guts) v *= 0.5
    if (guts) v *= ab!.atkMult!.value
    if (ab?.atkMult?.when === 'always') v *= ab.atkMult.value
    if (ab?.hustle) v *= 1.5
  }
  if (key === 'def' && ab?.defMult?.when === 'statused' && mon.status !== null) {
    v *= ab.defMult.value
  }
  if (key === 'spa' && ab?.solarPower && weather === 'sun') v *= 1.5
  if (key === 'spe') {
    // Quick Feet reads paralysis as a boost, so it also ignores the speed cut.
    if (ab?.quickFeet && mon.status !== null) v *= 1.5
    else if (mon.status === 'par') v *= 0.5
    if (ab?.speedX2In && weather === ab.speedX2In) v *= 2
  }

  return Math.max(1, Math.floor(v))
}

/** Type effectiveness, with Scrappy letting Normal and Fighting reach Ghost. */
function typeEff(m: Move, attacker: BattleMon, defender: BattleMon): number {
  const base = effectiveness(m.type, defender.types)
  if (
    base === 0 && A(attacker)?.scrappy &&
    (m.type === 'normal' || m.type === 'fighting') && defender.types.includes('ghost')
  ) {
    // Only the Ghost immunity is bypassed; everything else still applies.
    return effectiveness(m.type, defender.types.filter((t) => t !== 'ghost') as PokeType[])
  }
  return base
}

/** Does this move's added effect exist at all? Sheer Force trades them away. */
const hasSecondary = (m: Move) =>
  (m.ailment !== null && m.ailmentChance > 0) || m.flinchChance > 0 ||
  (m.statChanges.length > 0 && m.statChance > 0)

/** Moves that set weather, and what they set. */
const WEATHER_MOVES: Record<string, Weather> = {
  'sunny-day': 'sun',
  'rain-dance': 'rain',
  sandstorm: 'sand',
  hail: 'hail',
  snowscape: 'hail',
}

/** Moves Damp shuts down. */
const SELF_DESTRUCT = new Set(['self-destruct', 'explosion', 'misty-explosion'])

const STRUGGLE: Move = {
  name: 'struggle', type: 'normal', category: 'physical', power: 50, accuracy: null, pp: 1,
  priority: 0, target: 'selected-pokemon', ailment: null, ailmentChance: 0, critRate: 0,
  drain: -25, healing: 0, flinchChance: 0, statChance: 0, minHits: null, maxHits: null,
  statChanges: [],
}

/* ------------------------------------------------------------------ */
/* Damage                                                              */
/* ------------------------------------------------------------------ */

function isCrit(rng: () => number, m: Move, attacker: BattleMon, defender: BattleMon): boolean {
  // Mold Breaker walks straight through Shell Armor and Battle Armor.
  if (A(defender)?.critProof && !A(attacker)?.moldBreaker) return false
  const stage = (m.critRate ?? 0) + (A(attacker)?.critStage ?? 0)
  const odds = stage <= 0 ? 24 : stage === 1 ? 8 : stage === 2 ? 2 : 1
  return odds === 1 ? true : rng() < 1 / odds
}

function damage(
  rng: () => number,
  attacker: BattleMon,
  defender: BattleMon,
  m: Move,
  crit: boolean,
  weather: Weather | null = null,
  movingLast = false,
): { dmg: number; eff: number } {
  // The only difference between a real hit and an estimate is the roll.
  return computeDamage(attacker, defender, m, {
    crit, rollPct: randInt(rng, 85, 100), weather, movingLast,
  })
}

/**
 * One hit's damage, with every modifier the engine knows about.
 *
 * `estimateDamage` runs through here too, on a fixed average roll. Keeping the
 * AI on the same path is deliberate: a second, simplified copy of this drifted
 * out of sync once already and left the bot unable to see ability immunities.
 */
/**
 * Base power for moves whose power is not a constant.
 *
 * Anything not listed here returns the move's own power unchanged. Keeping it
 * in one place means the builder's damage preview and the battle itself can
 * never disagree about what a move hits for.
 */
function variablePower(m: Move, attacker: BattleMon, defender: BattleMon): number {
  const base = m.power ?? 0
  switch (m.name) {
    // Doubles while the user is burned, poisoned or paralysed (and the burn's
    // own Attack cut does not apply to it).
    case 'facade':
      return attacker.status && attacker.status !== 'slp' && attacker.status !== 'frz'
        ? base * 2
        : base
    // Doubles against a target that already has a status condition.
    case 'hex':
      return defender.status ? base * 2 : base
    // Doubles against a poisoned target.
    case 'venoshock':
      return defender.status === 'psn' || defender.status === 'tox' ? base * 2 : base
    // Doubles once the target is under half health.
    case 'brine':
      return defender.hp * 2 <= defender.maxHp ? base * 2 : base
    default:
      return base
  }
}

function computeDamage(
  attacker: BattleMon,
  defender: BattleMon,
  m: Move,
  opts: { crit: boolean; rollPct: number; weather: Weather | null; movingLast: boolean },
): { dmg: number; eff: number } {
  const { crit, rollPct, weather, movingLast } = opts
  const eff = typeEff(m, attacker, defender)
  if (eff === 0) return { dmg: 0, eff }

  const physical = m.category === 'physical'
  const atkAb = A(attacker)
  // Mold Breaker ignores whatever the target's ability would have done to
  // blunt the hit — but not the attacker's own half of the calculation.
  const defAb = atkAb?.moldBreaker ? null : A(defender)

  // Unaware on either side blanks out the other's stat stages.
  const ignoreDefBoosts = Boolean(atkAb?.unaware)
  const ignoreAtkBoosts = Boolean(defAb?.unaware)

  // On a crit, ignore the attacker's drops and the defender's boosts.
  const a = effStat(
    attacker, physical ? 'atk' : 'spa',
    ignoreAtkBoosts || (crit && attacker.boosts[physical ? 'atk' : 'spa'] < 0), weather,
  )
  const d = effStat(
    defender, physical ? 'def' : 'spd',
    ignoreDefBoosts || (crit && defender.boosts[physical ? 'def' : 'spd'] > 0), weather,
  )

  let power = variablePower(m, attacker, defender)
  if (atkAb?.technicianCap && power <= atkAb.technicianCap) power = Math.floor(power * 1.5)
  if (atkAb?.pinchType === m.type && attacker.hp * 3 <= attacker.maxHp) power = Math.floor(power * 1.5)
  if (atkAb?.drawsIn === m.type && attacker.drawnIn) power = Math.floor(power * 1.5)
  if (atkAb?.sheerForce && hasSecondary(m)) power = Math.floor(power * 1.3)
  if (atkAb?.recoilBoost && m.drain < 0) power = Math.floor(power * atkAb.recoilBoost)
  if (atkAb?.moveGroup && inGroup(m.name, atkAb.moveGroup.group)) {
    power = Math.floor(power * atkAb.moveGroup.mult)
  }
  if (atkAb?.analytic && movingLast) power = Math.floor(power * 1.3)
  if (atkAb?.sandForce && weather === 'sand' && ['rock', 'ground', 'steel'].includes(m.type)) {
    power = Math.floor(power * 1.3)
  }
  // Rivalry reads gender; two genderless Pokémon are simply neutral.
  if (atkAb?.rivalry && attacker.gender !== 'N' && defender.gender !== 'N') {
    power = Math.floor(power * (attacker.gender === defender.gender ? 1.25 : 0.75))
  }

  // Sun and rain each strengthen one type and weaken the other.
  if (weather === 'sun') {
    if (m.type === 'fire') power = Math.floor(power * 1.5)
    if (m.type === 'water') power = Math.floor(power * 0.5)
  } else if (weather === 'rain') {
    if (m.type === 'water') power = Math.floor(power * 1.5)
    if (m.type === 'fire') power = Math.floor(power * 0.5)
  }

  let dmg = Math.floor(
    Math.floor((Math.floor((2 * attacker.level) / 5 + 2) * power * a) / d) / 50,
  ) + 2

  if (crit) dmg = Math.floor(dmg * (atkAb?.critDamage ?? 1.5))
  // Random spread is applied before STAB/type in the real games.
  dmg = Math.floor((dmg * rollPct) / 100)
  if (attacker.types.includes(m.type)) dmg = Math.floor(dmg * (atkAb?.stab ?? 1.5))
  dmg = Math.floor(dmg * eff)

  if (eff > 1 && defAb?.superEffectiveTaken) dmg = Math.floor(dmg * defAb.superEffectiveTaken)
  if (eff < 1 && atkAb?.notVeryEffectiveDealt) dmg = Math.floor(dmg * atkAb.notVeryEffectiveDealt)
  if (defAb?.resists?.includes(m.type)) dmg = Math.floor(dmg * 0.5)
  // Dry Skin is a weakness to Fire as well as a Water immunity.
  if (defAb?.drySkin && m.type === 'fire') dmg = Math.floor(dmg * 1.25)
  if (defAb?.multiscale && defender.hp === defender.maxHp) dmg = Math.floor(dmg * 0.5)

  return { dmg: Math.max(1, dmg), eff }
}

/**
 * Does the target's ability stop this move dead, before damage is rolled?
 *
 * Mirrors the immunity block in `performMove`. Anything listed here deals
 * exactly zero, so the AI must treat it as worthless rather than as its best
 * option — the reason a bot would otherwise Earthquake a Levitate Pokémon
 * every turn, forever.
 */
export function abilityNullifies(attacker: BattleMon, defender: BattleMon, m: Move): boolean {
  if (m.category === 'status') return false
  const fab = A(attacker)?.moldBreaker ? null : A(defender)
  if (!fab) return false
  if (fab.immuneTo === m.type) return true
  if (fab.absorbs === m.type) return true
  if (fab.drawsIn === m.type) return true
  if (fab.liftsOnHit?.type === m.type) return true
  if (fab.soundproof && inGroup(m.name, 'sound') && m.target !== 'user') return true
  return false
}

/**
 * Damage with the randomness taken out — the average roll, never a crit.
 *
 * Exposed so the AI can compare options without consuming the battle's RNG.
 * Drawing from `b.rng` here would desync the seed and break replay
 * verification, so this deliberately takes no rng at all.
 */
export function estimateDamage(
  attacker: BattleMon,
  defender: BattleMon,
  m: Move,
  weather: Weather | null = null,
  movingLast = false,
): number {
  if (m.category === 'status' || !m.power) return 0
  if (abilityNullifies(attacker, defender, m)) return 0

  // 92.5 is the midpoint of the 85–100 spread.
  const { dmg, eff } = computeDamage(attacker, defender, m, {
    crit: false, rollPct: 92.5, weather, movingLast,
  })
  if (eff === 0) return 0

  const hits = m.minHits && m.maxHits
    ? (A(attacker)?.skillLink ? m.maxHits : (m.minHits + m.maxHits) / 2)
    : 1
  return Math.max(1, Math.floor(dmg * hits))
}

/**
 * Type multiplier of a move type against a Pokémon, for matchup scoring.
 * Ability immunities count: a Ground attacker is no threat to Levitate.
 */
export function typeMultiplier(moveType: PokeType, target: BattleMon): number {
  const ab = A(target)
  if (ab) {
    if (ab.immuneTo === moveType || ab.absorbs === moveType) return 0
    if (ab.drawsIn === moveType || ab.liftsOnHit?.type === moveType) return 0
    if (ab.resists?.includes(moveType)) return effectiveness(moveType, target.types) * 0.5
  }
  return effectiveness(moveType, target.types)
}

/** The weather the battle is actually operating under, for callers outside. */
export const currentWeather = (b: Battle): Weather | null => sky(b)

/* ------------------------------------------------------------------ */
/* Turn resolution                                                     */
/* ------------------------------------------------------------------ */

const label = (m: BattleMon) => m.name.charAt(0).toUpperCase() + m.name.slice(1)

/**
 * Readable stat names for the battle log.
 *
 * The internal keys leaked straight into player-facing text — "Pikachu's spe
 * rose sharply!" — which is both ugly and ambiguous, since "spe" and "spd"
 * are one character apart and mean very different things.
 */
const STAT_NAME: Record<BoostKey, string> = {
  atk: 'Attack',
  def: 'Defence',
  spa: 'Sp. Atk',
  spd: 'Sp. Def',
  spe: 'Speed',
  acc: 'accuracy',
  eva: 'evasiveness',
}

function applyBoost(
  b: Battle, side: 0 | 1, mon: BattleMon, stat: BoostKey, by: number, ev: BattleEvent[],
  fromOpponent = false,
) {
  // Clear Body and friends only refuse drops the opponent causes; a move that
  // lowers your own stats as a cost still applies.
  const ab = A(mon)
  const proof = ab?.dropProof
  if (by < 0 && fromOpponent && proof && (proof === 'all' || proof.includes(stat as never))) {
    ev.push({
      t: 'text',
      msg: `${label(mon)}'s ${ab!.name.replace(/-/g, ' ')} kept its ${STAT_NAME[stat]} steady!`,
    })
    return
  }
  const before = mon.boosts[stat]
  mon.boosts[stat] = Math.max(-6, Math.min(6, before + by))
  const delta = mon.boosts[stat] - before
  if (delta === 0) {
    ev.push({
      t: 'text',
      msg: `${label(mon)}'s ${STAT_NAME[stat]} won't go ${by > 0 ? 'higher' : 'lower'}!`,
    })
    return
  }
  ev.push({ t: 'boost', side, slot: b.sides[side].active, stat, by: delta })
  ev.push({
    t: 'text',
    msg: `${label(mon)}'s ${STAT_NAME[stat]} ${delta > 0 ? 'rose' : 'fell'}${Math.abs(delta) > 1 ? ' sharply' : ''}!`,
  })

  // Defiant and Competitive answer a drop the opponent caused, never a cost the
  // Pokémon paid itself.
  if (by < 0 && fromOpponent && ab?.onDrop) {
    ev.push({ t: 'text', msg: `${label(mon)} bristles!` })
    applyBoost(b, side, mon, ab.onDrop.stat, ab.onDrop.by, ev)
  }
}

function trySetStatus(
  b: Battle, side: 0 | 1, mon: BattleMon, status: Status, ev: BattleEvent[],
  source?: { side: 0 | 1; mon: BattleMon },
): boolean {
  if (mon.status !== null || mon.fainted) return false
  const ab = A(mon)
  if (status && ab?.statusImmune?.includes(status)) return false
  // Leaf Guard only holds while the sun is actually out.
  if (ab?.leafGuard && sky(b) === 'sun') return false
  // Type immunities to the major statuses.
  if (status === 'brn' && mon.types.includes('fire')) return false
  if ((status === 'psn' || status === 'tox') && (mon.types.includes('poison') || mon.types.includes('steel'))) return false
  if (status === 'par' && mon.types.includes('electric')) return false
  if (status === 'frz' && mon.types.includes('ice')) return false

  mon.status = status
  if (status === 'slp') mon.sleepTurns = randInt(b.rng, 1, 3)
  if (status === 'tox') mon.toxCounter = 1

  ev.push({ t: 'status', side, slot: b.sides[side].active, status })
  const word: Record<string, string> = {
    brn: 'was burned', par: 'was paralysed', psn: 'was poisoned',
    tox: 'was badly poisoned', slp: 'fell asleep', frz: 'was frozen solid',
  }
  ev.push({ t: 'text', msg: `${label(mon)} ${word[status!]}!` })

  // Synchronize hands burn, poison and paralysis straight back.
  if (
    ab?.synchronize && source && !source.mon.fainted &&
    (status === 'brn' || status === 'psn' || status === 'tox' || status === 'par')
  ) {
    ev.push({ t: 'text', msg: `${label(mon)}'s synchronize passed it on!` })
    trySetStatus(b, source.side, source.mon, status, ev)
  }
  return true
}

function applyConfusion(b: Battle, mon: BattleMon, ev: BattleEvent[]) {
  if (mon.confusionTurns > 0) return
  if (A(mon)?.statusImmune?.includes('confusion')) return
  mon.confusionTurns = randInt(b.rng, 2, 5)
  ev.push({ t: 'text', msg: `${label(mon)} became confused!` })
}

function dealDamage(b: Battle, side: 0 | 1, mon: BattleMon, amount: number, ev: BattleEvent[]) {
  // Sturdy only holds when the hit comes at full health.
  if (A(mon)?.endure && mon.hp === mon.maxHp && amount >= mon.hp) {
    amount = mon.hp - 1
    ev.push({ t: 'text', msg: `${label(mon)} hung on with sturdy!` })
  }
  // Endure holds at any health, for the turn it was used.
  if (mon.enduring && amount >= mon.hp && mon.hp > 0) {
    amount = mon.hp - 1
    ev.push({ t: 'text', msg: `${label(mon)} endured the hit!` })
  }
  mon.hp = Math.max(0, mon.hp - amount)
  ev.push({ t: 'damage', side, slot: b.sides[side].active, hp: mon.hp, maxHp: mon.maxHp })
  if (mon.hp === 0) {
    mon.fainted = true
    ev.push({ t: 'faint', side, slot: b.sides[side].active })
    ev.push({ t: 'text', msg: `${label(mon)} fainted!` })
  }
}

/**
 * Damage from an attacking move.
 *
 * A Substitute soaks the hit and the Pokémon behind it takes nothing — that is
 * the entire point of the move, so nothing that keys off "was hit" (status,
 * Rage, Bide, Counter) fires while one is standing. Returns the damage that
 * actually reached the Pokémon, which is 0 whenever the Substitute ate it.
 */
function damageFromMove(
  b: Battle, side: 0 | 1, mon: BattleMon, amount: number, m: Move, ev: BattleEvent[],
): number {
  if (mon.substituteHp > 0) {
    mon.substituteHp = Math.max(0, mon.substituteHp - amount)
    ev.push({
      t: 'text',
      msg: mon.substituteHp === 0
        ? `${label(mon)}'s substitute faded!`
        : `The substitute took the hit for ${label(mon)}!`,
    })
    return 0
  }
  const before = mon.hp
  dealDamage(b, side, mon, amount, ev)
  const dealt = before - mon.hp
  if (dealt > 0) {
    if (m.category === 'physical') mon.tookThisTurn.physical += dealt
    else if (m.category === 'special') mon.tookThisTurn.special += dealt
    if (mon.bide) mon.bide.damage += dealt
    // Rage keeps climbing for as long as the user keeps getting hit.
    if (mon.raging && !mon.fainted) applyBoost(b, side, mon, 'atk', 1, ev)
  }
  return dealt
}

function healMon(b: Battle, side: 0 | 1, mon: BattleMon, amount: number, ev: BattleEvent[]) {
  const before = mon.hp
  mon.hp = Math.min(mon.maxHp, mon.hp + amount)
  if (mon.hp !== before) {
    ev.push({ t: 'heal', side, slot: b.sides[side].active, hp: mon.hp, maxHp: mon.maxHp })
  }
}

/** Can this Pokémon act this turn? Handles sleep, freeze, paralysis, flinch. */
/** The only two moves that work *because* the user is asleep. */
const SLEEP_ONLY_MOVES = new Set(['sleep-talk', 'snore'])

function canAct(
  b: Battle, side: 0 | 1, mon: BattleMon, ev: BattleEvent[], moveName = '',
): boolean {
  if (mon.flinched) {
    ev.push({ t: 'text', msg: `${label(mon)} flinched!` })
    // Steadfast turns every flinch into a speed boost.
    if (A(mon)?.steadfast) applyBoost(b, side, mon, 'spe', 1, ev)
    return false
  }
  if (mon.status === 'slp') {
    if (mon.sleepTurns > 0) {
      // Early Bird burns through sleep at double rate.
      mon.sleepTurns -= A(mon)?.earlyBird ? 2 : 1
      if (mon.sleepTurns < 0) mon.sleepTurns = 0
      if (mon.sleepTurns === 0) {
        mon.status = null
        ev.push({ t: 'status', side, slot: b.sides[side].active, status: null })
        ev.push({ t: 'text', msg: `${label(mon)} woke up!` })
        return true
      }
      ev.push({ t: 'text', msg: `${label(mon)} is fast asleep.` })
      // Sleep Talk and Snore are the exception: they only work while asleep.
      return SLEEP_ONLY_MOVES.has(moveName)
    }
    mon.status = null
    ev.push({ t: 'status', side, slot: b.sides[side].active, status: null })
    ev.push({ t: 'text', msg: `${label(mon)} woke up!` })
  }
  if (mon.status === 'frz') {
    if (b.rng() < 0.2) {
      mon.status = null
      ev.push({ t: 'status', side, slot: b.sides[side].active, status: null })
      ev.push({ t: 'text', msg: `${label(mon)} thawed out!` })
    } else {
      ev.push({ t: 'text', msg: `${label(mon)} is frozen solid!` })
      return false
    }
  }
  if (mon.status === 'par' && b.rng() < 0.25) {
    ev.push({ t: 'text', msg: `${label(mon)} is paralysed and can't move!` })
    return false
  }
  if (mon.confusionTurns > 0) {
    mon.confusionTurns--
    if (mon.confusionTurns === 0) {
      ev.push({ t: 'text', msg: `${label(mon)} snapped out of its confusion!` })
    } else {
      ev.push({ t: 'text', msg: `${label(mon)} is confused!` })
      if (b.rng() < 1 / 3) {
        // Confusion self-hit: a typeless 40-power physical hit.
        const self = Math.max(
          1,
          Math.floor(
            Math.floor(
              Math.floor((Math.floor((2 * mon.level) / 5 + 2) * 40 * effStat(mon, 'atk')) / effStat(mon, 'def')) / 50,
            ) + 2,
          ),
        )
        ev.push({ t: 'text', msg: `It hurt itself in its confusion!` })
        dealDamage(b, side, mon, self, ev)
        return false
      }
    }
  }
  if (mon.infatuated) {
    if (b.rng() < 0.5) {
      ev.push({ t: 'text', msg: `${label(mon)} is immobilised by love!` })
      return false
    }
    ev.push({ t: 'text', msg: `${label(mon)} is in love!` })
  }
  return true
}

/**
 * Moves whose behaviour cannot be expressed by the generic move data and are
 * run by name instead. Every one of these is fully implemented below; the data
 * layer keeps anything that is not in here out of team building entirely.
 */
export const SCRIPTED_MOVES = new Set([
  'protect', 'detect', 'endure',
  'substitute', 'rest', 'curse', 'bide', 'mimic',
  'sleep-talk',
])

const FAILED = 'But it failed!'

/**
 * Runs a scripted move. Returns nothing; every path pushes its own text so a
 * replay reads the same way a live match did.
 */
function performScripted(b: Battle, side: 0 | 1, m: Move, ev: BattleEvent[]) {
  const foeSide = (1 - side) as 0 | 1
  const user = b.sides[side].team[b.sides[side].active]
  const foe = b.sides[foeSide].team[b.sides[foeSide].active]
  const fail = () => ev.push({ t: 'text', msg: FAILED })

  switch (m.name) {
    /* ---- Protect family ---- */
    case 'protect':
    case 'detect':
    case 'endure': {
      // Consecutive uses succeed 1/3 as often each time, so a pair of stallers
      // can never lock a match up.
      if (user.protectStreak > 0 && b.rng() >= 1 / 3 ** user.protectStreak) {
        user.protectStreak = 0
        return fail()
      }
      user.protectStreak++
      if (m.name === 'endure') {
        user.enduring = true
        ev.push({ t: 'text', msg: `${label(user)} braced itself!` })
      } else {
        user.protecting = true
        ev.push({ t: 'text', msg: `${label(user)} protected itself!` })
      }
      return
    }

    /* ---- Substitute ---- */
    case 'substitute': {
      if (user.substituteHp > 0) return fail()
      const cost = Math.floor(user.maxHp / 4)
      // It costs a quarter of max HP and you must survive paying it.
      if (cost <= 0 || user.hp <= cost) {
        return ev.push({ t: 'text', msg: `${label(user)} hasn't got the HP to spare!` })
      }
      dealDamage(b, side, user, cost, ev)
      user.substituteHp = cost
      ev.push({ t: 'text', msg: `${label(user)} put up a substitute!` })
      return
    }

    /* ---- Rest ---- */
    case 'rest': {
      if (user.hp === user.maxHp) return fail()
      if (A(user)?.statusImmune?.includes('slp')) {
        return ev.push({ t: 'text', msg: `${label(user)} can't fall asleep!` })
      }
      user.status = 'slp'
      // Rest always sleeps exactly two turns, however sleep normally rolls.
      user.sleepTurns = 2
      user.toxCounter = 0
      healMon(b, side, user, user.maxHp - user.hp, ev)
      ev.push({ t: 'status', side, slot: b.sides[side].active, status: 'slp' })
      ev.push({ t: 'text', msg: `${label(user)} slept and became healthy!` })
      return
    }

    /* ---- Curse ---- */
    case 'curse': {
      if (user.types.includes('ghost')) {
        if (foe.fainted || foe.cursed) return fail()
        const cost = Math.floor(user.maxHp / 2)
        foe.cursed = true
        ev.push({ t: 'text', msg: `${label(user)} cut its own HP and laid a curse on ${label(foe)}!` })
        dealDamage(b, side, user, cost, ev)
      } else {
        applyBoost(b, side, user, 'atk', 1, ev)
        applyBoost(b, side, user, 'def', 1, ev)
        applyBoost(b, side, user, 'spe', -1, ev)
      }
      return
    }

    /* ---- Bide ---- */
    case 'bide': {
      if (!user.bide) {
        user.bide = { turns: 2, damage: 0 }
        user.lockedMove = { move: 'bide', turns: 2 }
        ev.push({ t: 'text', msg: `${label(user)} is storing energy!` })
        return
      }
      user.bide.turns--
      if (user.bide.turns > 0) {
        ev.push({ t: 'text', msg: `${label(user)} is storing energy!` })
        return
      }
      const stored = user.bide.damage * 2
      user.bide = null
      user.lockedMove = null
      if (stored <= 0 || foe.fainted) return fail()
      ev.push({ t: 'text', msg: `${label(user)} unleashed its stored energy!` })
      // Bide is typeless and ignores type immunities entirely.
      dealDamage(b, foeSide, foe, stored, ev)
      return
    }

    /* ---- Mimic ---- */
    case 'mimic': {
      const copy = foe.lastMove
      if (!copy || !MOVES.has(copy) || user.moves.some((s) => s.name === copy)) return fail()
      const slot = user.moves.find((s) => s.name === 'mimic')
      if (!slot) return fail()
      const src = MOVES.get(copy)!
      slot.name = copy
      slot.pp = Math.min(5, src.pp)
      slot.maxPp = slot.pp
      ev.push({ t: 'text', msg: `${label(user)} learned ${copy.replace(/-/g, ' ')}!` })
      return
    }

    /* ---- Sleep Talk ---- */
    case 'sleep-talk': {
      if (user.status !== 'slp') return fail()
      // Picks one of the user's other moves at random and runs it. Scripted
      // moves are skipped: nothing in that set behaves sanely when called
      // second-hand, and Sleep Talk calling Sleep Talk would recurse.
      const pool = user.moves.filter(
        (s) => s.name !== 'sleep-talk' && !SCRIPTED_MOVES.has(s.name) && MOVES.has(s.name),
      )
      if (pool.length === 0) return fail()
      const chosen = pool[randInt(b.rng, 0, pool.length - 1)]
      performMove(b, side, chosen.name, ev)
      return
    }
  }
}

function performMove(
  b: Battle, side: 0 | 1, moveName: string, ev: BattleEvent[], movingLast = false,
) {
  const foeSide = (1 - side) as 0 | 1
  const user = b.sides[side].team[b.sides[side].active]
  const foe = b.sides[foeSide].team[b.sides[foeSide].active]
  const m = moveName === 'struggle' ? STRUGGLE : MOVES.get(moveName)!
  const uab = A(user)
  // Mold Breaker means the target's ability does not get a say in defence.
  const fab = uab?.moldBreaker ? null : A(foe)
  const weather = sky(b)

  ev.push({ t: 'text', msg: `${label(user)} used ${moveName.replace(/-/g, ' ')}!` })

  // Damp smothers a self-destructing move before it goes off, from either side.
  if (SELF_DESTRUCT.has(m.name)) {
    const damper = ([0, 1] as const)
      .map((x) => b.sides[x].team[b.sides[x].active])
      .find((x) => !x.fainted && A(x)?.damp)
    if (damper) {
      ev.push({ t: 'text', msg: `${label(damper)}'s damp prevents ${moveName.replace(/-/g, ' ')}!` })
      return
    }
  }

  // Sound cannot reach a soundproof Pokémon at all.
  if (fab?.soundproof && inGroup(m.name, 'sound') && m.target !== 'user') {
    ev.push({ t: 'text', msg: `${label(foe)}'s soundproof blocked it!` })
    return
  }

  if (m.name === 'transform') {
    if (!transformInto(user, foe, ev)) ev.push({ t: 'text', msg: 'But it failed!' })
    return
  }

  // Weather-setting moves resolve here and go no further.
  const sets = WEATHER_MOVES[m.name]
  if (sets) {
    setWeather(b, sets, ev)
    return
  }

  // Protect and Detect stop anything aimed at the target dead, before
  // accuracy is even rolled.
  if (foe.protecting && m.target !== 'user' && !foe.fainted) {
    ev.push({ t: 'text', msg: `${label(foe)} protected itself!` })
    user.lastMove = m.name
    return
  }

  // Anything other than another Protect resets the escalating fail chance,
  // and Rage stops building the moment the user does something else.
  if (m.name !== 'protect' && m.name !== 'detect' && m.name !== 'endure') user.protectStreak = 0
  user.raging = m.name === 'rage'

  // Scripted moves run by name; the generic pipeline cannot express them.
  if (SCRIPTED_MOVES.has(m.name)) {
    performScripted(b, side, m, ev)
    user.lastMove = m.name
    return
  }
  user.lastMove = m.name

  // Accuracy. `null` accuracy never misses, and neither does anything while
  // No Guard is on either side.
  const alwaysHits =
    (weather === 'rain' && (m.name === 'thunder' || m.name === 'hurricane')) ||
    (weather === 'hail' && m.name === 'blizzard')

  if (m.accuracy !== null && !uab?.noMiss && !A(foe)?.noMiss && !alwaysHits) {
    let chance = (m.accuracy * accMult(user.boosts.acc)) / accMult(foe.boosts.eva)
    if (uab?.accuracy) chance *= uab.accuracy
    // Hustle buys its power with accuracy, on physical moves only.
    if (uab?.hustle && m.category === 'physical') chance *= 0.8
    // Sand Veil, Snow Cloak and Tangled Feet all make the target harder to hit.
    if (fab?.evasionUpIn && weather === fab.evasionUpIn) chance /= 1.25
    if (fab?.tangledFeet && foe.confusionTurns > 0) chance /= 1.25
    // Wonder Skin turns weak status moves into coin flips.
    if (fab?.wonderSkin && m.category === 'status' && m.target !== 'user') {
      chance = Math.min(chance, 50)
    }
    if (b.rng() * 100 >= chance) {
      ev.push({ t: 'text', msg: `${label(user)}'s attack missed!` })
      return
    }
  }

  if (m.category === 'status') {
    // Self-targeting buffs and heals.
    if (m.target === 'user') {
      for (const sc of m.statChanges) applyBoost(b, side, user, sc.stat as BoostKey, sc.change, ev)
      if (m.healing > 0) {
        healMon(b, side, user, Math.floor((user.maxHp * m.healing) / 100), ev)
        ev.push({ t: 'text', msg: `${label(user)} regained health!` })
      }
      return
    }
    if (foe.fainted) return
    for (const sc of m.statChanges) {
      applyBoost(b, foeSide, foe, sc.stat as BoostKey, sc.change, ev, true)
    }
    if (m.ailment) {
      if (m.ailment === 'confusion') applyConfusion(b, foe, ev)
      else {
        // Toxic is badly-poison; every other poison move is regular.
        const st = m.name === 'toxic' ? 'tox' : (
          { paralysis: 'par', burn: 'brn', poison: 'psn', freeze: 'frz', sleep: 'slp' } as const
        )[m.ailment as 'paralysis']
        if (!trySetStatus(b, foeSide, foe, st as Status, ev, { side, mon: user })) {
          ev.push({ t: 'text', msg: `It had no effect on ${label(foe)}.` })
        }
      }
    }
    return
  }

  if (foe.fainted) return

  // Ability-based type immunities resolve before any damage is rolled.
  if (fab) {
    if (fab.immuneTo === m.type) {
      ev.push({ t: 'text', msg: `${label(foe)}'s ${fab.name.replace(/-/g, ' ')} blocked it!` })
      return
    }
    if (fab.absorbs === m.type) {
      ev.push({ t: 'text', msg: `${label(foe)} absorbed it with ${fab.name.replace(/-/g, ' ')}!` })
      healMon(b, foeSide, foe, Math.max(1, Math.floor(foe.maxHp / 4)), ev)
      return
    }
    if (fab.drawsIn === m.type) {
      foe.drawnIn = true
      ev.push({ t: 'text', msg: `${label(foe)}'s ${fab.name.replace(/-/g, ' ')} drew it in!` })
      return
    }
    if (fab.liftsOnHit?.type === m.type) {
      ev.push({ t: 'text', msg: `${label(foe)}'s ${fab.name.replace(/-/g, ' ')} soaked it up!` })
      applyBoost(b, foeSide, foe, fab.liftsOnHit.stat, fab.liftsOnHit.by, ev)
      return
    }
  }

  // Multi-hit moves roll their hit count once. Skill Link skips the roll.
  let hits = 1
  if (m.minHits && m.maxHits) {
    hits = uab?.skillLink
      ? m.maxHits
      : m.minHits === m.maxHits
        ? m.minHits
        : ([2, 2, 3, 3, 4, 5] as const)[randInt(b.rng, 0, 5)]
  }

  // A Substitute standing when the move lands takes the whole thing: the
  // Pokémon behind it is untouched, so no on-hit ability, status, flinch or
  // stat drop may fire.
  const behindSub = foe.substituteHp > 0

  let total = 0
  let lastEff = 1
  let anyCrit = false
  for (let i = 0; i < hits && !foe.fainted; i++) {
    const crit = isCrit(b.rng, m, user, foe)
    const { dmg, eff } = damage(b.rng, user, foe, m, crit, weather, movingLast)
    lastEff = eff
    if (eff === 0) {
      ev.push({ t: 'text', msg: `It doesn't affect ${label(foe)}…` })
      return
    }
    if (crit) {
      anyCrit = true
      ev.push({ t: 'text', msg: 'A critical hit!' })
    }
    total += dmg
    damageFromMove(b, foeSide, foe, dmg, m, ev)
    if (behindSub) break
  }

  const hit = total > 0 && !behindSub
  // Physical moves stand in for contact: the engine has no per-move flag.
  const contact = m.category === 'physical'

  if (hit) {
    // Anger Point does not care how much the crit hurt, only that it landed.
    if (anyCrit && A(foe)?.angerPoint && !foe.fainted) {
      ev.push({ t: 'text', msg: `${label(foe)} maxed its Attack in fury!` })
      foe.boosts.atk = 6
      ev.push({ t: 'boost', side: foeSide, slot: b.sides[foeSide].active, stat: 'atk', by: 6 })
    }

    if (contact && A(foe)?.weakArmor && !foe.fainted) {
      applyBoost(b, foeSide, foe, 'def', -1, ev)
      applyBoost(b, foeSide, foe, 'spe', 2, ev)
    }

    const react = A(foe)?.onHitBoost
    if (react && react.types.includes(m.type) && !foe.fainted) {
      applyBoost(b, foeSide, foe, react.stat, react.by, ev)
    }

    // Static and friends punish the attacker for making contact.
    const cab = A(foe)
    if (cab?.contact && contact && !user.fainted && cab.contact.status.length > 0) {
      if (b.rng() * 100 < cab.contact.chance) {
        const st = cab.contact.status[randInt(b.rng, 0, cab.contact.status.length - 1)]
        trySetStatus(b, side, user, st as Status, ev)
      }
    }

    // Cute Charm needs two Pokémon of known, opposite genders.
    if (
      cab?.cuteCharm && contact && !user.fainted && !user.infatuated &&
      foe.gender !== 'N' && user.gender !== 'N' && foe.gender !== user.gender &&
      !A(user)?.statusImmune?.includes('infatuation')
    ) {
      if (b.rng() * 100 < cab.cuteCharm) {
        user.infatuated = true
        ev.push({ t: 'text', msg: `${label(user)} fell in love with ${label(foe)}!` })
      }
    }

    if (cab?.cursedBody && contact && !user.fainted && !user.disabled && moveName !== 'struggle') {
      if (b.rng() * 100 < cab.cursedBody) {
        user.disabled = { move: moveName, turns: 4 }
        ev.push({ t: 'text', msg: `${label(user)}'s ${moveName.replace(/-/g, ' ')} was disabled!` })
      }
    }

    // Poison Touch works the other way round: the attacker poisons on contact.
    if (uab?.poisonTouch && contact && !foe.fainted && b.rng() * 100 < uab.poisonTouch) {
      trySetStatus(b, foeSide, foe, 'psn', ev, { side, mon: user })
    }

    // Aftermath fires only when the contact hit was the fatal one.
    if (foe.fainted && A(foe)?.aftermath && contact && !user.fainted) {
      ev.push({ t: 'text', msg: `${label(foe)} went out with a bang!` })
      dealDamage(b, side, user, Math.max(1, Math.floor(user.maxHp / 4)), ev)
    }

    if (foe.fainted && uab?.moxie && !user.fainted) {
      applyBoost(b, side, user, 'atk', 1, ev)
    }
  }

  if (hits > 1) ev.push({ t: 'text', msg: `Hit ${hits} time(s)!` })
  if (lastEff > 1) ev.push({ t: 'text', msg: "It's super effective!" })
  if (lastEff < 1 && lastEff > 0) ev.push({ t: 'text', msg: "It's not very effective…" })

  // Drain (positive) and recoil (negative) are both expressed as `drain`.
  if (m.drain > 0 && total > 0) {
    const amount = Math.max(1, Math.floor((total * m.drain) / 100))
    if (A(foe)?.liquidOoze) {
      // Liquid Ooze turns the drain into damage on whoever tried it.
      ev.push({ t: 'text', msg: `${label(user)} sucked up the liquid ooze!` })
      dealDamage(b, side, user, amount, ev)
    } else {
      healMon(b, side, user, amount, ev)
      ev.push({ t: 'text', msg: `${label(user)} drained health!` })
    }
  } else if (m.drain < 0 && total > 0 && !uab?.noRecoil && !uab?.magicGuard) {
    const recoil = Math.max(1, Math.floor((total * -m.drain) / 100))
    ev.push({ t: 'text', msg: `${label(user)} is hit with recoil!` })
    dealDamage(b, side, user, recoil, ev)
  }

  // Sheer Force traded the added effect away for raw power, so it must not
  // also fire — that would be the boost for free.
  // Shield Dust refuses added effects outright, which is the same as a zero
  // chance from the attacker's point of view.
  const secondaryMult =
    uab?.sheerForce || A(foe)?.shieldDust ? 0 : (uab?.secondaryMult ?? 1)

  // Stench bolts a flinch chance onto anything that does damage.
  if (uab?.stench && hit && !foe.fainted && secondaryMult > 0 && m.flinchChance === 0) {
    if (b.rng() * 100 < 10 && !A(foe)?.statusImmune?.includes('flinch')) foe.flinched = true
  }

  // Secondary effects only fire if the target survived, and never through a
  // Substitute.
  if (!foe.fainted && !behindSub) {
    if (m.ailment && m.ailmentChance > 0 && b.rng() * 100 < m.ailmentChance * secondaryMult) {
      if (m.ailment === 'confusion') applyConfusion(b, foe, ev)
      else {
        const st = ({ paralysis: 'par', burn: 'brn', poison: 'psn', freeze: 'frz', sleep: 'slp' } as const)[
          m.ailment as 'paralysis'
        ]
        trySetStatus(b, foeSide, foe, st as Status, ev, { side, mon: user })
      }
    }
    if (m.flinchChance > 0 && b.rng() * 100 < m.flinchChance * secondaryMult) {
      if (!A(foe)?.statusImmune?.includes('flinch')) foe.flinched = true
    }
    if (m.statChanges.length > 0 && m.statChance > 0 && b.rng() * 100 < m.statChance * secondaryMult) {
      for (const sc of m.statChanges) {
        // A damaging move's stat change targets whoever the move targets.
        const onSelf = m.target === 'user'
        applyBoost(
          b, onSelf ? side : foeSide, onSelf ? user : foe, sc.stat as BoostKey, sc.change, ev,
          !onSelf,
        )
      }
    }
  } else if (m.statChanges.length > 0 && m.statChance > 0 && m.target === 'user') {
    if (b.rng() * 100 < m.statChance) {
      for (const sc of m.statChanges) applyBoost(b, side, user, sc.stat as BoostKey, sc.change, ev)
    }
  }
}

/** End-of-turn effects: weather, healing abilities, then status damage. */
function residuals(b: Battle, ev: BattleEvent[]) {
  const weather = sky(b)

  for (const side of [0, 1] as const) {
    const mon = b.sides[side].team[b.sides[side].active]
    if (mon.fainted) continue
    const ab = A(mon)

    // A Ghost-type Curse bleeds a quarter of max HP every turn it stays in.
    if (mon.cursed && !ab?.magicGuard) {
      ev.push({ t: 'text', msg: `${label(mon)} is afflicted by the curse!` })
      dealDamage(b, side, mon, Math.max(1, Math.floor(mon.maxHp / 4)), ev)
      if (mon.fainted) continue
    }

    // A disabled move frees up again after a few turns.
    if (mon.disabled) {
      mon.disabled.turns--
      if (mon.disabled.turns <= 0) {
        ev.push({ t: 'text', msg: `${label(mon)}'s ${mon.disabled.move.replace(/-/g, ' ')} is no longer disabled.` })
        mon.disabled = null
      }
    }

    if (weather) {
      // Sandstorm and hail chip anything not built for them.
      const immuneToChip =
        ab?.weatherProof || ab?.magicGuard ||
        (weather === 'sand' && mon.types.some((t) => ['rock', 'ground', 'steel'].includes(t))) ||
        (weather === 'hail' && mon.types.includes('ice'))

      if ((weather === 'sand' || weather === 'hail') && !immuneToChip) {
        ev.push({ t: 'text', msg: `${label(mon)} is buffeted by the ${weather === 'sand' ? 'sandstorm' : 'hail'}!` })
        dealDamage(b, side, mon, Math.max(1, Math.floor(mon.maxHp / 16)), ev)
        if (mon.fainted) continue
      }

      if (ab?.healsIn === weather) {
        healMon(b, side, mon, Math.max(1, Math.floor(mon.maxHp / 16)), ev)
        ev.push({ t: 'text', msg: `${label(mon)} is soothed by the weather.` })
      }

      if (ab?.solarPower && weather === 'sun' && !ab.magicGuard) {
        ev.push({ t: 'text', msg: `${label(mon)} is drained by the sun!` })
        dealDamage(b, side, mon, Math.max(1, Math.floor(mon.maxHp / 8)), ev)
        if (mon.fainted) continue
      }

      if (ab?.drySkin) {
        if (weather === 'sun' && !ab.magicGuard) {
          ev.push({ t: 'text', msg: `${label(mon)}'s dry skin is parched!` })
          dealDamage(b, side, mon, Math.max(1, Math.floor(mon.maxHp / 8)), ev)
          if (mon.fainted) continue
        } else if (weather === 'rain') {
          healMon(b, side, mon, Math.max(1, Math.floor(mon.maxHp / 8)), ev)
          ev.push({ t: 'text', msg: `${label(mon)}'s dry skin drinks the rain.` })
        }
      }

      if (ab?.hydration && weather === 'rain' && mon.status !== null) {
        mon.status = null
        mon.sleepTurns = 0
        mon.toxCounter = 0
        ev.push({ t: 'status', side, slot: b.sides[side].active, status: null })
        ev.push({ t: 'text', msg: `${label(mon)} was cured by the rain!` })
      }
    }

    if (ab?.shedSkin && mon.status !== null && b.rng() * 100 < ab.shedSkin) {
      mon.status = null
      mon.sleepTurns = 0
      mon.toxCounter = 0
      ev.push({ t: 'status', side, slot: b.sides[side].active, status: null })
      ev.push({ t: 'text', msg: `${label(mon)} shed its status!` })
      continue
    }

    // Magic Guard means only direct hits ever hurt.
    if (ab?.magicGuard) continue

    if (mon.status === 'brn') {
      ev.push({ t: 'text', msg: `${label(mon)} is hurt by its burn!` })
      dealDamage(b, side, mon, Math.max(1, Math.floor(mon.maxHp / 16)), ev)
    } else if (mon.status === 'psn') {
      ev.push({ t: 'text', msg: `${label(mon)} is hurt by poison!` })
      dealDamage(b, side, mon, Math.max(1, Math.floor(mon.maxHp / 8)), ev)
    } else if (mon.status === 'tox') {
      ev.push({ t: 'text', msg: `${label(mon)} is hurt by poison!` })
      dealDamage(b, side, mon, Math.max(1, Math.floor((mon.maxHp * mon.toxCounter) / 16)), ev)
      mon.toxCounter = Math.min(15, mon.toxCounter + 1)
    }
  }

  // Weather runs out last, so the turn it expires still counted.
  if (b.weather) {
    b.weather.turns--
    if (b.weather.turns <= 0) {
      ev.push({ t: 'text', msg: WEATHER_END[b.weather.kind] })
      b.weather = null
      ev.push({ t: 'weather', kind: null })
    }
  }
}

function doSwitch(b: Battle, side: 0 | 1, index: number, ev: BattleEvent[]) {
  const s = b.sides[side]
  const outgoing = s.team[s.active]
  // Boosts and confusion are cleared on switch; status is not, unless the
  // Pokémon leaving heals it on the way out.
  outgoing.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 }
  outgoing.confusionTurns = 0
  outgoing.infatuated = false
  outgoing.disabled = null
  // Volatiles die with the switch: the Substitute is left behind, a stored
  // Bide is lost, and Protect's escalating fail chance starts fresh.
  outgoing.substituteHp = 0
  outgoing.protecting = false
  outgoing.enduring = false
  outgoing.protectStreak = 0
  outgoing.bide = null
  outgoing.lockedMove = null
  outgoing.raging = false
  outgoing.cursed = false
  outgoing.lastMove = null
  outgoing.tookThisTurn = { physical: 0, special: 0 }
  if (A(outgoing)?.cureOnSwitch && outgoing.status !== null) {
    outgoing.status = null
    outgoing.sleepTurns = 0
    outgoing.toxCounter = 0
  }
  if (A(outgoing)?.regenerator && outgoing.hp > 0) {
    healMon(b, side, outgoing, Math.max(1, Math.floor(outgoing.maxHp / 3)), ev)
    ev.push({ t: 'text', msg: `${label(outgoing)} regenerated on the way out.` })
  }
  // A borrowed shape or ability lasts only while that Pokémon is out.
  outgoing.ability = outgoing.baseAbility
  if (outgoing.preTransform) {
    outgoing.types = outgoing.preTransform.types
    outgoing.stats = outgoing.preTransform.stats
    outgoing.moves = outgoing.preTransform.moves
    outgoing.preTransform = null
  }
  outgoing.transformed = false
  s.active = index
  ev.push({ t: 'switch', side, slot: index })
  ev.push({ t: 'text', msg: `Go! ${label(s.team[index])}!` })
  onEnter(b, side, ev)
}

/** Everything that fires the moment a Pokémon lands on the field. */
function onEnter(b: Battle, side: 0 | 1, ev: BattleEvent[]) {
  // Neutralizing Gas can arrive or leave with this switch, so recompute first.
  refreshSuppression(b)

  const mon = b.sides[side].team[b.sides[side].active]
  const foeSide = (1 - side) as 0 | 1
  const foe = b.sides[foeSide].team[b.sides[foeSide].active]
  const ab = A(mon)
  if (!ab) return

  if (ab.neutralizingGas) {
    ev.push({ t: 'text', msg: `${label(mon)} leaks neutralizing gas!` })
  }

  if (ab.setsWeather) setWeather(b, ab.setsWeather, ev, label(mon))

  if (ab.intimidate && !foe.fainted) {
    if (A(foe)?.oblivious) {
      ev.push({ t: 'text', msg: `${label(foe)} is too oblivious to be intimidated.` })
    } else {
      ev.push({ t: 'text', msg: `${label(mon)} intimidates ${label(foe)}!` })
      applyBoost(b, foeSide, foe, 'atk', -1, ev, true)
    }
  }

  if (ab.download && !foe.fainted) {
    // Aim at whichever wall is weaker, comparing the raw stats.
    const stat = effStat(foe, 'def') <= effStat(foe, 'spd') ? 'atk' : 'spa'
    ev.push({ t: 'text', msg: `${label(mon)} sized up ${label(foe)}!` })
    applyBoost(b, side, mon, stat, 1, ev)
  }

  if (ab.trace && !foe.fainted) {
    const target = A(foe)
    // Nothing to copy is a no-op, exactly as in the games.
    if (target && !target.trace) {
      mon.ability = target
      ev.push({
        t: 'text',
        msg: `${label(mon)} traced ${label(foe)}'s ${target.name.replace(/-/g, ' ')}!`,
      })
    }
  }

  if (ab.imposter && !foe.fainted) transformInto(mon, foe, ev)

  if (ab.forewarn && !foe.fainted) {
    const best = [...foe.moves].sort(
      (x, y) => (MOVES.get(y.name)?.power ?? 0) - (MOVES.get(x.name)?.power ?? 0),
    )[0]
    if (best) {
      ev.push({
        t: 'text',
        msg: `${label(mon)}'s forewarn sensed ${label(foe)}'s ${best.name.replace(/-/g, ' ')}!`,
      })
    }
  }

  if (ab.anticipation && !foe.fainted) {
    const danger = foe.moves.some((x) => {
      const mv = MOVES.get(x.name)
      return mv && mv.category !== 'status' && typeEff(mv, foe, mon) > 1
    })
    if (danger) ev.push({ t: 'text', msg: `${label(mon)} shuddered with anticipation!` })
  }
}

/**
 * Copies the target's shape. Everything but HP is taken, moves come with five
 * PP, and the original is stashed so switching out puts it back.
 */
function transformInto(mon: BattleMon, foe: BattleMon, ev: BattleEvent[]): boolean {
  if (mon.transformed || foe.transformed || foe.fainted) return false
  mon.preTransform = { types: mon.types, stats: mon.stats, moves: mon.moves }
  mon.types = [...foe.types]
  mon.stats = { ...foe.stats }
  mon.moves = foe.moves.map((x) => ({ name: x.name, pp: 5, maxPp: 5 }))
  mon.ability = foe.ability
  mon.transformed = true
  ev.push({ t: 'text', msg: `${label(mon)} transformed into ${label(foe)}!` })
  return true
}

/** Sets weather for five turns, or says so when it is already up. */
function setWeather(b: Battle, kind: Weather, ev: BattleEvent[], by?: string) {
  if (b.weather?.kind === kind) {
    ev.push({ t: 'text', msg: WEATHER_ALREADY[kind] })
    return
  }
  b.weather = { kind, turns: 5 }
  ev.push({ t: 'weather', kind })
  ev.push({ t: 'text', msg: by ? `${by}'s arrival ${WEATHER_START[kind]}` : WEATHER_START_MOVE[kind] })
}

const WEATHER_START: Record<Weather, string> = {
  sun: 'turned the sunlight harsh!',
  rain: 'brought a downpour!',
  sand: 'kicked up a sandstorm!',
  hail: 'brought a hailstorm!',
}

const WEATHER_START_MOVE: Record<Weather, string> = {
  sun: 'The sunlight turned harsh!',
  rain: 'It started to rain!',
  sand: 'A sandstorm kicked up!',
  hail: 'It started to hail!',
}

const WEATHER_ALREADY: Record<Weather, string> = {
  sun: 'The sunlight is already harsh.',
  rain: 'It is already raining.',
  sand: 'The sandstorm is already raging.',
  hail: 'It is already hailing.',
}

const WEATHER_END: Record<Weather, string> = {
  sun: 'The harsh sunlight faded.',
  rain: 'The rain stopped.',
  sand: 'The sandstorm subsided.',
  hail: 'The hail stopped.',
}

export function isTeamWiped(side: Side): boolean {
  return side.team.every((m) => m.fainted)
}

/** Validates an action against current state. Returns null when legal. */
export function validateAction(b: Battle, side: 0 | 1, action: Action): string | null {
  if (b.finished) return 'battle is over'
  const s = b.sides[side]
  const mon = s.team[s.active]

  if (action.kind === 'switch') {
    const t = s.team[action.index]
    if (!t) return 'no such team slot'
    if (action.index === s.active) return 'already active'
    if (t.fainted) return 'that Pokémon has fainted'
    // A forced replacement always goes through; trapping only binds a
    // voluntary switch.
    if (!b.pendingReplace[side] && !mon.fainted && trappedBy(b, side)) {
      return 'cannot switch out'
    }
    return null
  }

  if (b.pendingReplace[side]) return 'must send out a replacement'
  if (mon.fainted) return 'active Pokémon has fainted'
  const mv = mon.moves[action.index]
  if (!mv) return 'no such move'
  if (mon.disabled?.move === mv.name && mon.moves.some((x) => x.pp > 0 && x.name !== mv.name)) {
    return 'that move is disabled'
  }
  // Out of PP is legal only because Struggle replaces it at execution time.
  if (mv.pp <= 0 && mon.moves.some((x) => x.pp > 0)) return 'no PP left for that move'
  return null
}

/**
 * The opposing ability keeping this side from switching, if any.
 *
 * Arena Trap only holds grounded Pokémon, and Magnet Pull only Steel types —
 * anything else walks away freely.
 */
function trappedBy(b: Battle, side: 0 | 1): Ability | null {
  const mon = b.sides[side].team[b.sides[side].active]
  const foe = b.sides[(1 - side) as 0 | 1].team[b.sides[(1 - side) as 0 | 1].active]
  const ab = A(foe)
  if (!ab?.traps || foe.fainted) return null
  const myAb = A(mon)
  if (ab.traps === 'ground') {
    const airborne = mon.types.includes('flying') || myAb?.immuneTo === 'ground'
    return airborne ? null : ab
  }
  if (ab.traps === 'steel') return mon.types.includes('steel') ? ab : null
  return ab
}

/**
 * Runs one full turn from both players' chosen actions.
 * Switches resolve first, then moves by priority, then speed.
 */
/**
 * Which move a side will actually run this turn: a locked move wins over the
 * chosen action, and an empty or exhausted slot falls back to Struggle. Turn
 * order and execution both read this so they can never disagree.
 */
function chosenMoveName(b: Battle, side: 0 | 1, action: Action): string {
  const mon = b.sides[side].team[b.sides[side].active]
  if (mon.lockedMove) return mon.lockedMove.move
  if (action.kind !== 'move') return 'struggle'
  const slot = mon.moves[action.index]
  return slot && slot.pp > 0 ? slot.name : 'struggle'
}

export function resolveTurn(b: Battle, actions: [Action, Action]): BattleEvent[] {
  const ev: BattleEvent[] = []
  b.turn++
  ev.push({ t: 'text', msg: `— Turn ${b.turn} —` })

  // Per-turn flags clear before anyone acts: a Protect only covers the turn it
  // was used, and damage tallies are what Bide and Counter read.
  for (const side of [0, 1] as const) {
    const mon = b.sides[side].team[b.sides[side].active]
    mon.flinched = false
    mon.protecting = false
    mon.enduring = false
    mon.tookThisTurn = { physical: 0, special: 0 }
  }

  // Switches always go first.
  for (const side of [0, 1] as const) {
    if (actions[side].kind === 'switch') {
      doSwitch(b, side, (actions[side] as { index: number }).index, ev)
    }
  }

  const movers = ([0, 1] as const).filter((s) => actions[s].kind === 'move')

  const order = movers.sort((x, y) => {
    const nameX = chosenMoveName(b, x, actions[x])
    const nameY = chosenMoveName(b, y, actions[y])
    const mx = b.sides[x].team[b.sides[x].active]
    const my = b.sides[y].team[b.sides[y].active]
    const px = (nameX === 'struggle' ? STRUGGLE : MOVES.get(nameX)!).priority
    const py = (nameY === 'struggle' ? STRUGGLE : MOVES.get(nameY)!).priority
    if (px !== py) return py - px
    const sx = effStat(mx, 'spe', false, sky(b))
    const sy = effStat(my, 'spe', false, sky(b))
    if (sx !== sy) return sy - sx
    return b.rng() < 0.5 ? -1 : 1
  })

  order.forEach((side, position) => {
    if (b.finished) return
    const s = b.sides[side]
    const mon = s.team[s.active]
    if (mon.fainted) return

    const a = actions[side] as { index: number }
    // A locked move (Bide, Thrash family) overrides the chosen action and
    // costs no further PP — the first turn already paid for it.
    const locked = mon.lockedMove
    const slot = locked ? undefined : mon.moves[a.index]
    // Fall back to Struggle when every move is out of PP.
    const useStruggle = !locked && (!slot || slot.pp <= 0)
    const name = chosenMoveName(b, side, actions[side])

    if (!canAct(b, side, mon, ev, name)) return
    if (locked) {
      /* already paid for */
    } else if (!useStruggle && slot) {
      const foeSide = (1 - side) as 0 | 1
      const foe = b.sides[foeSide].team[b.sides[foeSide].active]
      // Pressure costs the attacker an extra PP, but only on moves aimed at it.
      const extra = A(foe)?.pressure && MOVES.get(name)?.target !== 'user' ? 1 : 0
      slot.pp = Math.max(0, slot.pp - 1 - extra)
    } else {
      ev.push({ t: 'text', msg: `${label(mon)} has no moves left!` })
    }

    // Analytic wants to know whether this Pokémon acted second.
    performMove(b, side, name, ev, position > 0 && movers.length > 1)

    checkEnd(b, ev)
  })
  if (b.finished) return ev

  refreshSuppression(b)
  residuals(b, ev)
  if (checkEnd(b, ev)) return ev
  refreshSuppression(b)

  // Anyone whose active Pokémon fainted must replace it before the next turn.
  for (const side of [0, 1] as const) {
    b.pendingReplace[side] = b.sides[side].team[b.sides[side].active].fainted
  }

  return ev
}

/** Handles a forced replacement after a faint (does not consume a turn). */
export function replaceFainted(b: Battle, side: 0 | 1, index: number): BattleEvent[] {
  const ev: BattleEvent[] = []
  const s = b.sides[side]
  if (!b.pendingReplace[side]) return ev
  const t = s.team[index]
  if (!t || t.fainted) return ev
  s.active = index
  b.pendingReplace[side] = false
  ev.push({ t: 'switch', side, slot: index })
  ev.push({ t: 'text', msg: `Go! ${label(t)}!` })
  onEnter(b, side, ev)
  return ev
}

function checkEnd(b: Battle, ev: BattleEvent[]): boolean {
  const dead0 = isTeamWiped(b.sides[0])
  const dead1 = isTeamWiped(b.sides[1])
  if (!dead0 && !dead1) return false
  b.finished = true
  b.winner = dead0 && dead1 ? null : dead0 ? 1 : 0
  ev.push({ t: 'end', winner: b.winner })
  ev.push({
    t: 'text',
    msg: b.winner === null ? 'The battle ended in a draw.' : `Player ${b.winner + 1} wins!`,
  })
  return true
}

/** The view one player is allowed to see (foe PP and unrevealed data hidden). */
export function publicState(b: Battle, viewer: 0 | 1) {
  const mine = b.sides[viewer]
  const theirs = b.sides[(1 - viewer) as 0 | 1]
  const pub = (m: BattleMon) => ({
    speciesId: m.speciesId, name: m.name, types: m.types,
    hp: m.hp, maxHp: m.maxHp, status: m.status, fainted: m.fainted, boosts: m.boosts,
    gender: m.gender, ability: m.ability?.name ?? null,
  })
  return {
    turn: b.turn,
    weather: b.weather?.kind ?? null,
    finished: b.finished,
    winner: b.winner,
    mustReplace: b.pendingReplace[viewer],
    you: {
      active: mine.active,
      team: mine.team.map((m) => ({
        ...pub(m),
        moves: m.moves.map((x) => ({ name: x.name, pp: x.pp, maxPp: x.maxPp })),
      })),
    },
    foe: { active: theirs.active, team: theirs.team.map(pub) },
  }
}
