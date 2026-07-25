import { createHash } from 'node:crypto'
import { createBattle, resolveTurn, replaceFainted, type BattleEvent, type TeamSlot } from './battle/active.js'
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
           p0_team, p1_team, steps
    FROM battles WHERE id = ?
  `).get(id) as
    | {
        id: string; p0: string; p1: string; winner: number | null; forced: number | null
        seed: string; seed_hash: string; started_at: number; ended_at: number | null
        p0_team: string | null; p1_team: string | null; steps: string | null
      }
    | undefined

  if (!row || row.ended_at === null) return null
  // Battles from before replay existed have no teams or decisions recorded.
  if (!row.p0_team || !row.p1_team || !row.steps) return null

  const teams: [TeamSlot[], TeamSlot[]] = [JSON.parse(row.p0_team), JSON.parse(row.p1_team)]
  const steps = JSON.parse(row.steps) as Step[]

  const battle = createBattle([structuredClone(teams[0]), structuredClone(teams[1])], row.seed)
  const turns: ReplayTurn[] = []

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
      const ev = replaceFainted(battle, step.side, step.index)
      if (ev.length) capture(ev)
    } else {
      capture(resolveTurn(battle, step.a))
    }
  }

  const forced = row.forced === 1
  // A forfeit is decided outside the rules, so a replay cannot reach it.
  const reproduced = forced ? true : battle.winner === row.winner

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
    turns,
    reproduced,
  }
}
