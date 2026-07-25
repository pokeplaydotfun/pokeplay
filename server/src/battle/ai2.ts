/**
 * Bot opponent for engine v2.
 *
 * Mirrors v1's behaviour deliberately — same difficulties, same blunder rates,
 * same "switch out of a hopeless matchup" instinct — so practice feels the
 * same after the engine swap. It reads the sim's own state, which means it can
 * never pick an illegal move: the sim tells us exactly what is available this
 * turn (a Pokémon locked into Outrage or recharging from Hyper Beam simply has
 * fewer options).
 *
 * Pure: inspects state, returns a choice, mutates nothing.
 */
import { Dex } from '@pkmn/sim'
import type { Action, Battle2 } from './engine2.js'

export type Difficulty = 'easy' | 'normal'

const gen = Dex.forGen(9)

/** How much of the best option the AI actually takes, per difficulty. */
const SETTINGS: Record<Difficulty, { blunderChance: number; switchThreshold: number }> = {
  // Plays well only about half the time and never switches tactically, so a
  // newcomer with a rough team has a genuine chance.
  easy: { blunderChance: 0.55, switchThreshold: 0 },
  // Plays the best damaging line and switches out of bad matchups.
  normal: { blunderChance: 0.05, switchThreshold: 2.5 },
}

type StatKey = 'atk' | 'def' | 'spa' | 'spd' | 'spe'

type Mon = {
  hp: number
  maxhp: number
  fainted: boolean
  status: string
  types: string[]
  isActive: boolean
  moveSlots: { id: string; pp: number }[]
  storedStats: Record<StatKey, number>
  boosts: Record<string, number>
}

const roster = (b: Battle2, side: 0 | 1) => b.roster[side] as unknown as Mon[]

/**
 * A stat with its boosts applied.
 *
 * Deliberately reads `storedStats` rather than calling the sim's `getStat()`:
 * that runs the whole onModifyAtk event chain, which assumes a move is being
 * executed and throws when called speculatively from the AI.
 */
function stat(mon: Mon, key: StatKey): number {
  const raw = mon.storedStats?.[key] ?? 100
  const stage = Math.max(-6, Math.min(6, mon.boosts?.[key] ?? 0))
  const mult = stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage)
  return Math.max(1, Math.floor(raw * mult))
}

/**
 * Type multiplier of an attacking type against a defender's typing.
 *
 * `damageTaken` hangs off the DEFENDING type and is indexed by the attacking
 * type — the opposite way round reads plausibly and is silently wrong. The
 * encoding is Showdown's: 1 = weak to it (2x), 2 = resists it (0.5x),
 * 3 = immune, anything else neutral.
 */
function typeMult(moveType: string, defender: Mon): number {
  let mult = 1
  for (const t of defender.types) {
    const eff = gen.types.get(t)?.damageTaken?.[moveType]
    mult *= eff === 1 ? 2 : eff === 2 ? 0.5 : eff === 3 ? 0 : 1
  }
  return mult
}

/** A rough damage estimate: enough to rank moves, not to predict the roll. */
function estimate(attacker: Mon, defender: Mon, moveId: string): number {
  const m = gen.moves.get(moveId)
  if (!m || !m.exists || m.category === 'Status' || m.basePower <= 0) return 0
  const eff = typeMult(m.type, defender)
  if (eff === 0) return 0
  const physical = m.category === 'Physical'
  const atk = stat(attacker, physical ? 'atk' : 'spa')
  const def = Math.max(1, stat(defender, physical ? 'def' : 'spd'))
  const base = Math.floor((Math.floor((2 * 100) / 5 + 2) * m.basePower * atk) / def / 50) + 2
  const stab = attacker.types.includes(m.type) ? 1.5 : 1
  return Math.max(0, Math.floor(base * stab * eff))
}

/** Best single-move damage this Pokémon could do to the target. */
function bestDamage(attacker: Mon, defender: Mon): number {
  let best = 0
  for (const slot of attacker.moveSlots ?? []) {
    if (slot.pp <= 0) continue
    best = Math.max(best, estimate(attacker, defender, slot.id))
  }
  return best
}

/** How badly the foe threatens this Pokémon: the best multiplier they have. */
function incomingThreat(foe: Mon, mon: Mon): number {
  let worst = 1
  for (const t of foe.types) worst = Math.max(worst, typeMult(t, mon))
  return worst
}

/** The move indices the sim will actually accept from this side this turn. */
function legalMoves(b: Battle2, side: 0 | 1): number[] {
  const req = (b.sim.sides[side] as {
    activeRequest?: { active?: { moves?: { disabled?: boolean; pp?: number }[] }[] }
  }).activeRequest
  const moves = req?.active?.[0]?.moves
  if (!moves) return [0]
  const out: number[] = []
  moves.forEach((m, i) => {
    if (!m.disabled && (m.pp === undefined || m.pp > 0)) out.push(i)
  })
  // Everything disabled or out of PP means the sim will fall back to Struggle.
  return out.length > 0 ? out : [0]
}

export function chooseAction(
  b: Battle2,
  side: 0 | 1,
  difficulty: Difficulty = 'normal',
  rand: () => number = Math.random,
): Action {
  const cfg = SETTINGS[difficulty]
  const mine = roster(b, side)
  const theirs = roster(b, (1 - side) as 0 | 1)
  const active = mine.find((m) => m.isActive) ?? mine[0]
  const foe = theirs.find((m) => m.isActive) ?? theirs[0]

  // Forced replacement: send out whoever handles the current foe best.
  //
  // This fires for a faint AND for pivot moves (U-turn, Volt Switch), where
  // the active Pokémon must leave the field but is still healthy. It must
  // therefore be excluded as a candidate — offering the sim a switch to the
  // Pokémon already out is rejected, and the battle deadlocks.
  if (b.pendingReplace[side] || active?.fainted) {
    const eligible = (m: Mon) => !m.fainted && !m.isActive
    let bestIdx = mine.findIndex(eligible)
    let bestScore = -Infinity
    mine.forEach((mon, i) => {
      if (!eligible(mon)) return
      // Reward hitting hard, punish being hit hard.
      const score = bestDamage(mon, foe) - incomingThreat(foe, mon) * 40
      if (score > bestScore) {
        bestScore = score
        bestIdx = i
      }
    })
    // Nobody eligible means the battle is already over; any index is harmless.
    return { kind: 'switch', index: bestIdx >= 0 ? bestIdx : 0 }
  }

  const usable = legalMoves(b, side)

  // Occasionally just pick something legal, so it is beatable and not robotic.
  if (rand() < cfg.blunderChance) {
    return { kind: 'move', index: usable[Math.floor(rand() * usable.length)] }
  }

  let best = usable[0]
  let bestScore = -Infinity

  for (const index of usable) {
    const id = active.moveSlots?.[index]?.id
    if (!id) continue
    const m = gen.moves.get(id)
    if (!m || !m.exists) continue
    const accuracy = (m.accuracy === true ? 100 : m.accuracy) / 100
    let score: number

    if (m.category === 'Status') {
      // Status moves are worth something, but never more than a kill. Value
      // them only early, while there is time for the effect to pay off.
      score = (foe.hp / foe.maxhp > 0.6 ? 25 : 5) * accuracy
      // Do not try to inflict a status the target already has.
      if (m.status && foe.status) score = 0
    } else {
      const dmg = estimate(active, foe, id)
      score = dmg * accuracy
      // A move the target shrugs off entirely is never worth picking.
      if (dmg === 0) score = -1
      // A guaranteed KO beats a bigger but less certain hit.
      if (dmg >= foe.hp) score += 1000 * accuracy
      if (m.priority > 0 && dmg >= foe.hp) score += 200
    }

    if (score > bestScore) {
      bestScore = score
      best = index
    }
  }

  // Consider switching when this matchup is genuinely bad: we cannot threaten
  // the foe, and something on the bench does much better.
  if (cfg.switchThreshold > 0 && bestScore < foe.hp * 0.25) {
    let bestAlt = -1
    let bestAltScore = bestScore * cfg.switchThreshold
    mine.forEach((mon, i) => {
      if (mon.isActive || mon.fainted) return
      const alt = bestDamage(mon, foe) - incomingThreat(foe, mon) * 20
      if (alt > bestAltScore) {
        bestAltScore = alt
        bestAlt = i
      }
    })
    // Only switch if staying in is not about to win anyway.
    if (bestAlt >= 0 && bestDamage(active, foe) < foe.hp) {
      return { kind: 'switch', index: bestAlt }
    }
  }

  return { kind: 'move', index: best }
}
