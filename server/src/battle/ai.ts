/**
 * The practice opponent.
 *
 * Runs entirely on the server, like every other battle decision — the client
 * never sees or influences it. It reads the same `Battle` object the engine
 * uses, but must never touch `battle.rng`: that seed drives the match and is
 * published as a commitment, so consuming from it here would desync replay
 * verification. Any randomness the AI wants comes from its own generator.
 */
import { MOVES } from './data.js'
import {
  estimateDamage, typeMultiplier, currentWeather,
  type Action, type Battle, type BattleMon, type Weather,
} from './engine.js'

export type Difficulty = 'easy' | 'normal'

/** How much of the best option the AI actually takes, per difficulty. */
const SETTINGS: Record<Difficulty, { blunderChance: number; switchThreshold: number }> = {
  // Plays well only about half the time and never switches tactically, so a
  // newcomer with a rough team has a genuine chance. At 0.35 this was still
  // optimal 65% of the time and barely distinguishable from `normal`.
  easy: { blunderChance: 0.55, switchThreshold: 0 },
  // Plays the best damaging line and switches out of bad matchups.
  normal: { blunderChance: 0.05, switchThreshold: 2.5 },
}

/** How badly the foe threatens this Pokémon: the best multiplier they have. */
function incomingThreat(foe: BattleMon, mon: BattleMon): number {
  let worst = 1
  for (const t of foe.types) worst = Math.max(worst, typeMultiplier(t, mon))
  return worst
}

/** Best single-move damage this Pokémon can do to the target. */
function bestDamage(
  attacker: BattleMon, defender: BattleMon, weather: Weather | null = null,
): number {
  let best = 0
  for (const slot of attacker.moves) {
    if (slot.pp <= 0) continue
    const m = MOVES.get(slot.name)
    if (!m) continue
    best = Math.max(best, estimateDamage(attacker, defender, m, weather))
  }
  return best
}

/**
 * Picks an action for `side`. Pure: it inspects state and returns a choice,
 * leaving all mutation and legality enforcement to the engine.
 */
export function chooseAction(
  battle: Battle,
  side: 0 | 1,
  difficulty: Difficulty = 'normal',
  rand: () => number = Math.random,
): Action {
  const cfg = SETTINGS[difficulty]
  const me = battle.sides[side]
  const foeSide = battle.sides[(1 - side) as 0 | 1]
  const active = me.team[me.active]
  const foe = foeSide.team[foeSide.active]
  // Sun doubles down on Fire, rain on Water: the same numbers the engine uses.
  const weather = currentWeather(battle)

  // Forced replacement: send out whoever handles the current foe best.
  if (battle.pendingReplace[side] || active.fainted) {
    let bestIdx = me.team.findIndex((m) => !m.fainted)
    let bestScore = -Infinity
    me.team.forEach((mon, i) => {
      if (mon.fainted) return
      // Reward hitting hard, punish being hit hard.
      const score = bestDamage(mon, foe, weather) - incomingThreat(foe, mon) * 40
      if (score > bestScore) {
        bestScore = score
        bestIdx = i
      }
    })
    return { kind: 'switch', index: bestIdx >= 0 ? bestIdx : 0 }
  }

  const usable = active.moves
    .map((slot, index) => ({ slot, index, move: MOVES.get(slot.name) }))
    .filter((x) => x.slot.pp > 0 && x.move)

  // Out of PP everywhere: the engine substitutes Struggle.
  if (usable.length === 0) return { kind: 'move', index: 0 }

  // Occasionally just pick something legal, so it is beatable and not robotic.
  if (rand() < cfg.blunderChance) {
    return { kind: 'move', index: usable[Math.floor(rand() * usable.length)].index }
  }

  // Score every move by expected damage, weighted by accuracy.
  let best = usable[0]
  let bestScore = -Infinity

  for (const option of usable) {
    const m = option.move!
    const accuracy = (m.accuracy ?? 100) / 100
    let score: number

    if (m.category === 'status') {
      // Status moves are worth something, but never more than a kill. Value
      // them only early, while there is time for the effect to pay off.
      const setupValue = foe.hp / foe.maxHp > 0.6 ? 25 : 5
      score = setupValue * accuracy
      // Do not try to inflict a status the target already has.
      if (m.ailment && foe.status !== null) score = 0
    } else {
      const dmg = estimateDamage(active, foe, m, weather)
      score = dmg * accuracy
      // A move the target's ability shrugs off entirely is never worth picking.
      if (dmg === 0) score = -1
      // A guaranteed KO beats a bigger but less certain hit.
      if (dmg >= foe.hp) score += 1000 * accuracy
      // Slight preference for priority when it would finish the job.
      if (m.priority > 0 && dmg >= foe.hp) score += 200
    }

    if (score > bestScore) {
      bestScore = score
      best = option
    }
  }

  // Consider switching when this matchup is genuinely bad: we cannot threaten
  // the foe, and something on the bench does much better.
  if (cfg.switchThreshold > 0 && bestScore < foe.hp * 0.25) {
    let bestAlt = -1
    let bestAltScore = bestScore * cfg.switchThreshold

    me.team.forEach((mon, i) => {
      if (i === me.active || mon.fainted) return
      const alt = bestDamage(mon, foe, weather) - incomingThreat(foe, mon) * 20
      if (alt > bestAltScore) {
        bestAltScore = alt
        bestAlt = i
      }
    })

    // Only switch if staying in is not about to win anyway.
    if (bestAlt >= 0 && bestDamage(active, foe, weather) < foe.hp) {
      return { kind: 'switch', index: bestAlt }
    }
  }

  return { kind: 'move', index: best.index }
}
