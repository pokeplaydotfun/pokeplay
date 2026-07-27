import { createHash } from 'node:crypto'
import type { Action, BattleEvent, TeamSlot } from './battle/active.js'
import * as currentEngine from './battle/active.js'
import * as legacyEngine from './battle/engine.js'
import type { Step } from './rooms.js'
import { db } from './db.js'

export type ReplayTurn = {
  /** Turn number, or 0 for the pre-battle replacement steps. */
  turn: number
  events: BattleEvent[]
  /** Both sides after this step resolved, for scrubbing to any point. */
  state: {
    you: { active: number; team: PublicMon[] }
    foe: { active: number; team: PublicMon[] }
  }
}

type PublicMon = {
  speciesId: number
  name: string
  types: string[]
  hp: number
  maxHp: number
  status: string | null
  fainted: boolean
}

export type Replay = {
  id: string
  p0: string
  p1: string
  winner: 0 | 1 | null
  forced: boolean
  seed: string
  seedHash: string
  /** True when hash(seed) matches the commitment published before the match. */
  seedVerified: boolean
  startedAt: number
  endedAt: number
  practice: boolean
  teams: [TeamSlot[], TeamSlot[]]
  turns: ReplayTurn[]
  /**
   * Whether re-deriving the match reproduced the recorded winner. False means
   * the stored result and the stored decisions disagree — worth surfacing
   * loudly rather than hiding.
   */
  reproduced: boolean
}

const snap = (mon: {
  speciesId: number; name: string; types: string[]; hp: number; maxHp: number
  status: string | null; fainted: boolean
}): PublicMon => ({
  speciesId: mon.speciesId,
  name: mon.name,
  types: mon.types,
  hp: mon.hp,
  maxHp: mon.maxHp,
  status: mon.status,
  fainted: mon.fainted,
})

/**
 * The slice of a battle engine that replay drives. Both the current engine and
 * the frozen v1 engine satisfy it — v1 is literally what this code was first
 * written against — so a match re-derives on the engine it was played on.
 */
type ReplayBattle = {
  turn: number
  finished: boolean
  winner: 0 | 1 | null
  opening: BattleEvent[]
  sides: [{ active: number; team: Parameters<typeof snap>[0][] }, { active: number; team: Parameters<typeof snap>[0][] }]
}
type Engine = {
  createBattle(teams: [TeamSlot[], TeamSlot[]], seed: string): ReplayBattle
  resolveTurn(b: ReplayBattle, actions: [Action, Action]): BattleEvent[]
  replaceFainted(b: ReplayBattle, side: 0 | 1, index: number): BattleEvent[]
}

const CURRENT = currentEngine as unknown as Engine
const LEGACY = legacyEngine as unknown as Engine

/**
 * Engines to try for a battle, in order, given its recorded version.
 *
 * A KNOWN version resolves to exactly one engine — the replay must be honest, so
 * a v2 match that fails to reproduce is reported failing, not quietly retried on
 * v1. Only a row from BEFORE the engine column existed (version null) is
 * ambiguous, and there we try the current engine then the frozen one and accept
 * whichever reproduces the recorded result.
 */
function enginesFor(version: number | null): Engine[] {
  if (version === 1) return [LEGACY]
  if (version === 2) return [CURRENT]
  return [CURRENT, LEGACY]
}

/**
 * Re-derives the whole match on one engine.
 *
 * `ok` is false if the engine threw part-way — which is a real possibility when
 * the WRONG engine is tried on a legacy row, because a divergent state can make
 * a recorded move index or replacement invalid. A throw there means "this engine
 * did not play this match", not a server error, so it is caught and the caller
 * moves on to the next candidate.
 */
function derive(
  engine: Engine,
  teams: [TeamSlot[], TeamSlot[]],
  seed: string,
  steps: Step[],
): { turns: ReplayTurn[]; winner: 0 | 1 | null; ok: boolean } {
  const turns: ReplayTurn[] = []
  try {
    const battle = engine.createBattle([structuredClone(teams[0]), structuredClone(teams[1])], seed)

    const capture = (events: BattleEvent[]) => {
      turns.push({
        turn: battle.turn,
        events,
        state: {
          you: { active: battle.sides[0].active, team: battle.sides[0].team.map(snap) },
          foe: { active: battle.sides[1].active, team: battle.sides[1].team.map(snap) },
        },
      })
    }

    // Mirror the live match: the leads' entry abilities come before turn 1.
    if (battle.opening.length) capture(battle.opening)

    for (const step of steps) {
      if (battle.finished) break
      if (step.k === 'replace') {
        const ev = engine.replaceFainted(battle, step.side, step.index)
        if (ev.length) capture(ev)
      } else {
        capture(engine.resolveTurn(battle, step.a))
      }
    }

    return { turns, winner: battle.winner, ok: true }
  } catch {
    return { turns, winner: null, ok: false }
  }
}

/**
 * Rebuilds a finished battle from its seed and recorded decisions.
 *
 * This does not read back a stored event log — it re-runs the real engine.
 * If the seed or the decisions had been altered, the replay would diverge and
 * `reproduced` would come out false, which is exactly the property the
 * pre-match seed commitment is supposed to give players.
 */
export function buildReplay(id: string): Replay | null {
  const row = db.prepare(`
    SELECT id, p0, p1, winner, forced, seed, seed_hash, started_at, ended_at,
           p0_team, p1_team, steps, engine
    FROM battles WHERE id = ?
  `).get(id) as
    | {
        id: string; p0: string; p1: string; winner: number | null; forced: number | null
        seed: string; seed_hash: string; started_at: number; ended_at: number | null
        p0_team: string | null; p1_team: string | null; steps: string | null
        engine: number | null
      }
    | undefined

  if (!row || row.ended_at === null) return null
  // Battles from before replay existed have no teams or decisions recorded.
  if (!row.p0_team || !row.p1_team || !row.steps) return null

  const teams: [TeamSlot[], TeamSlot[]] = [JSON.parse(row.p0_team), JSON.parse(row.p1_team)]
  const steps = JSON.parse(row.steps) as Step[]
  const forced = row.forced === 1

  // Re-derive on the engine this match was played on. A forfeit is decided
  // outside the rules, so a replay can never reach it — reproduced is true by
  // definition and the engine choice only affects the (partial) playback.
  const engines = enginesFor(row.engine)
  let result = derive(engines[0], teams, row.seed, steps)
  let reproduced = forced ? true : result.ok && result.winner === row.winner

  // Ambiguous legacy row (engine null): if the current engine did not reproduce
  // it, try the frozen one and take it if that reproduces the recorded result.
  if (!forced && !reproduced && engines.length > 1) {
    for (let i = 1; i < engines.length; i++) {
      const alt = derive(engines[i], teams, row.seed, steps)
      if (alt.ok && alt.winner === row.winner) {
        result = alt
        reproduced = true
        break
      }
    }
  }

  return {
    id: row.id,
    p0: row.p0,
    p1: row.p1,
    winner: (row.winner as 0 | 1 | null) ?? null,
    forced,
    seed: row.seed,
    seedHash: row.seed_hash,
    seedVerified: createHash('sha256').update(row.seed).digest('hex') === row.seed_hash,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    practice: false,
    teams,
    turns: result.turns,
    reproduced,
  }
}
