import { randomBytes, createHash, randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import {
  createBattle, resolveTurn, replaceFainted, validateAction, publicState, firstLegalAction,
  viewerEvents, spectatorState, spectatorEvents,
  type Action, type Battle, type BattleEvent, type TeamSlot,
} from './battle/active.js'
import { db, now, ensureUser } from './db.js'
import { chooseAction, type Difficulty } from './battle/active.js'

/** How long a player has to choose before the server picks for them. */
export const TURN_SECONDS = 30

/**
 * How long a disconnected player has to get back before they forfeit.
 *
 * This must stay short. A losing player who could stall indefinitely by
 * closing the tab would be able to hold a wagered match hostage, and one who
 * could force a refund by disconnecting would have a free escape from every
 * losing position. Neither is allowed: quitting mid-match is a loss.
 */
export const RECONNECT_SECONDS = Number(process.env.RECONNECT_SECONDS ?? 30)

type Seat = {
  address: string
  socket: WebSocket | null
  team: TeamSlot[]
  /** Action chosen for the current turn, if any. */
  choice: Action | null
  disconnectedAt: number | null
/**
   * Whether this seat ever managed to open a socket.
   *
   * This is what separates "could not start" from "quit". Keying the void on
   * `turn === 0` instead let a player connect, look at the opening matchup,
   * and quit before the first turn resolved to force a refund — a free reroll
   * of the opponent. Once you have seen the board, leaving is a forfeit.
   */
  everConnected: boolean
  /** Set for the practice opponent: the server plays this seat. */
  bot: Difficulty | null
  /** Display name shown to the other side, instead of a raw address. */
  label: string | null
}

/**
 * One state-changing decision. Replaying these in order against the recorded
 * seed reproduces the match exactly — that is what the seed commitment buys.
 */
export type Step =
  | { k: 'turn'; a: [Action, Action] }
  | { k: 'replace'; side: 0 | 1; index: number }

export type Room = {
  id: string
  wagerId: number | null
  stakeWei: string
  seats: [Seat, Seat]
  battle: Battle
  seedHash: string
  timer: NodeJS.Timeout | null
  deadline: number
  ended: boolean
  /** Practice matches do not touch anyone's win/loss record. */
  practice: boolean
  /** Ordered decision log, persisted at the end so the match can be replayed. */
  steps: Step[]
  /** Set when this battle is a tournament fixture, so the bracket can advance. */
  tournamentMatchId: number | null
  /**
   * Read-only watchers. They receive the same public state both players already
   * expose (no move list or PP on either side) and can never submit an action,
   * so a watcher — including a player peeking at their own live wager — learns
   * nothing a cheater could use.
   */
  spectators: Set<WebSocket>
  /** When the match began, for the live-battle listing. */
  startedAt: number
}

const rooms = new Map<string, Room>()
/** address -> roomId, so a reconnecting player can find their match. */
const byPlayer = new Map<string, string>()

/** Synthetic account for the practice opponent. Never a real wallet. */
export const BOT_ADDRESS = '0x00000000000000000000000000000000000b0000'

export function ensureBotUser() {
  ensureUser(BOT_ADDRESS)
  db.prepare("UPDATE users SET name = 'Practice AI' WHERE address = ?").run(BOT_ADDRESS)
}

export const getRoom = (id: string) => rooms.get(id)
export const roomForPlayer = (addr: string) => {
  const id = byPlayer.get(addr)
  return id ? rooms.get(id) : undefined
}

type EndHook = (room: Room, winner: 0 | 1 | null) => void
let onEnd: EndHook = () => {}
export const setEndHook = (fn: EndHook) => { onEnd = fn }

function send(sock: WebSocket | null, msg: unknown) {
  if (sock && sock.readyState === 1) sock.send(JSON.stringify(msg))
}

/**
 * Push the current state to both seats. `rawLines` are the protocol lines for
 * whatever just happened; each seat gets them re-narrated from its own point of
 * view, so the opponent's Pokémon reads "the opposing X".
 */
function pushState(room: Room, rawLines: string[] = []) {
  for (const side of [0, 1] as const) {
    send(room.seats[side].socket, {
      type: 'state',
      roomId: room.id,
      you: side,
      state: publicState(room.battle, side),
      events: rawLines.length ? viewerEvents(room.battle, side, rawLines) : [],
      deadline: room.deadline,
      opponent: room.seats[1 - side].address,
      opponentName: room.seats[1 - side].label,
      practice: room.practice,
      stakeWei: room.stakeWei,
      wagerId: room.wagerId,
    })
  }
  pushSpectators(room, rawLines)
}

/** Identity of a room seat as a spectator should see it — masked like the rest
 * of the site, so a player who hid their wallet stays hidden to watchers too. */
function spectatorIdentity(addr: string) {
  if (addr === BOT_ADDRESS) return { address: addr, name: 'Practice AI', hidden: false }
  const u = db.prepare('SELECT name, hide_wallet FROM users WHERE address = ?').get(addr) as
    | { name: string | null; hide_wallet: number }
    | undefined
  const hidden = Boolean(u?.hide_wallet)
  return { address: hidden ? null : addr, name: u?.name ?? null, hidden }
}

/** Broadcast the neutral, both-sides-public view to every watcher of the room. */
function pushSpectators(room: Room, rawLines: string[] = []) {
  if (room.spectators.size === 0) return
  const [i0, i1] = [spectatorIdentity(room.seats[0].address), spectatorIdentity(room.seats[1].address)]
  const msg = JSON.stringify({
    type: 'state',
    roomId: room.id,
    state: spectatorState(room.battle),
    events: rawLines.length ? spectatorEvents(room.battle, rawLines) : [],
    p0: i0.address, p0Name: i0.name, p0Hidden: i0.hidden,
    p1: i1.address, p1Name: i1.name, p1Hidden: i1.hidden,
    deadline: room.deadline,
    practice: room.practice,
    stakeWei: room.stakeWei,
    wagerId: room.wagerId,
  })
  for (const sock of room.spectators) {
    if (sock.readyState === 1) sock.send(msg)
  }
}

export function createRoom(
  p0: { address: string; team: TeamSlot[]; bot?: Difficulty; label?: string },
  p1: { address: string; team: TeamSlot[]; bot?: Difficulty; label?: string },
  wagerId: number | null,
  stakeWei: string,
  tournamentMatchId: number | null = null,
): Room {
  // The seed decides every roll in the match. We publish its hash up front and
  // reveal the seed at the end, so either player can replay and verify.
  const seed = randomBytes(32).toString('hex')
  const seedHash = createHash('sha256').update(seed).digest('hex')
  const id = randomUUID()

  const room: Room = {
    id,
    wagerId,
    stakeWei,
    seats: [
      { address: p0.address, socket: null, team: p0.team, choice: null, disconnectedAt: now(), everConnected: false, bot: p0.bot ?? null, label: p0.label ?? null },
      { address: p1.address, socket: null, team: p1.team, choice: null, disconnectedAt: now(), everConnected: false, bot: p1.bot ?? null, label: p1.label ?? null },
    ],
    battle: createBattle([p0.team, p1.team], seed),
    seedHash,
    timer: null,
    deadline: 0,
    ended: false,
    practice: Boolean(p0.bot || p1.bot),
    steps: [],
    tournamentMatchId,
    spectators: new Set(),
    startedAt: now(),
  }

  rooms.set(id, room)
  if (!p0.bot) byPlayer.set(p0.address, id)
  if (!p1.bot) byPlayer.set(p1.address, id)

  // Record which engine drove this match so its replay re-derives on the same
  // one. The current engine tags its battle with `engine`; the frozen v1 engine
  // has no such field, so a missing tag means v1.
  const engineVersion = (room.battle as { engine?: number }).engine ?? 1

  db.prepare(
    `INSERT INTO battles (id, wager_id, p0, p1, seed, seed_hash, started_at, p0_team, p1_team, engine)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, wagerId, p0.address, p1.address, seed, seedHash, now(),
    JSON.stringify(p0.team), JSON.stringify(p1.team), engineVersion,
  )

  // The leads' switch-in abilities happen before anyone chooses anything.
  // `lastRaw` holds the opening's protocol lines, which startTurn re-narrates
  // per seat.
  startTurn(room, room.battle.lastRaw)
  return room
}

export function attachSocket(room: Room, address: string, sock: WebSocket) {
  const side = room.seats.findIndex((s) => s.address === address)
  if (side < 0) return false
  const wasGone = room.seats[side].disconnectedAt !== null && room.seats[side].everConnected
  room.seats[side].socket = sock
  room.seats[side].disconnectedAt = null
  room.seats[side].everConnected = true
  send(sock, { type: 'hello', roomId: room.id, you: side, seedHash: room.seedHash })
  pushState(room)

  // Tell the opponent the countdown is off.
  if (wasGone) {
    send(room.seats[1 - side].socket, { type: 'opponentBack' })
  }
  return true
}

export function detachSocket(room: Room, address: string) {
  const side = room.seats.findIndex((s) => s.address === address)
  if (side < 0 || room.ended) return
  room.seats[side].socket = null
  room.seats[side].disconnectedAt = now()

  // Give the opponent a deadline they can count down against locally, and say
  // what happens when it expires — the outcome differs before turn 1.
  send(room.seats[1 - side].socket, {
    type: 'opponentGone',
    deadline: Date.now() + RECONNECT_SECONDS * 1000,
    // They connected, so this is a forfeit, not a void.
    voidsMatch: false,
  })
}

/**
 * Seat a read-only watcher and hand them the current state. A spectator socket
 * is never a `Seat`, so it cannot submit actions or forfeit; the only thing it
 * does is receive `pushSpectators` broadcasts.
 */
export function addSpectator(room: Room, sock: WebSocket) {
  room.spectators.add(sock)
  const [i0, i1] = [spectatorIdentity(room.seats[0].address), spectatorIdentity(room.seats[1].address)]
  send(sock, { type: 'hello', roomId: room.id, spectator: true, seedHash: room.seedHash })
  // The opening state, with no events — a watcher who joins mid-match should see
  // the board as it stands, not replay everything that already happened.
  send(sock, {
    type: 'state',
    roomId: room.id,
    state: spectatorState(room.battle),
    events: [],
    p0: i0.address, p0Name: i0.name, p0Hidden: i0.hidden,
    p1: i1.address, p1Name: i1.name, p1Hidden: i1.hidden,
    deadline: room.deadline,
    practice: room.practice,
    stakeWei: room.stakeWei,
    wagerId: room.wagerId,
  })
  // A watcher who arrives after the match already ended still gets told so.
  if (room.ended) {
    send(sock, {
      type: 'ended',
      winner: room.battle.winner,
      seed: room.battle.seed,
      seedHash: room.seedHash,
      events: [],
    })
  }
}

export function removeSpectator(room: Room, sock: WebSocket) {
  room.spectators.delete(sock)
}

/**
 * Summaries of every live, watchable match — non-practice rooms still in
 * progress. Raw addresses; the caller masks hidden wallets and adds tournament
 * context.
 */
export function liveBattles() {
  return [...rooms.values()]
    .filter((r) => !r.ended && !r.practice)
    .map((r) => ({
      roomId: r.id,
      p0: r.seats[0].address,
      p1: r.seats[1].address,
      turn: r.battle.turn,
      stakeWei: r.stakeWei,
      wagerId: r.wagerId,
      tournamentMatchId: r.tournamentMatchId,
      spectators: r.spectators.size,
      startedAt: r.startedAt,
    }))
}

function startTurn(room: Room, rawLines: string[] = []) {
  if (room.ended) return
  room.seats[0].choice = null
  room.seats[1].choice = null
  room.deadline = Date.now() + TURN_SECONDS * 1000

  if (room.timer) clearTimeout(room.timer)
  room.timer = setTimeout(() => forceTurn(room), TURN_SECONDS * 1000 + 250)

  // One push per turn, carrying the lines that produced it. Pushing again
  // afterwards would deliver the same state twice and re-send the events.
  pushState(room, rawLines)
  takeBotTurns(room)
}

/**
 * Plays any bot seat for the current turn.
 *
 * Deliberately does NOT use `battle.rng` — that seed drives the match and is
 * published as a commitment, so drawing from it here would break replay
 * verification for the human player.
 */
function takeBotTurns(room: Room) {
  if (room.ended) return
  for (const side of [0, 1] as const) {
    const seat = room.seats[side]
    if (!seat.bot || seat.choice) continue

    if (room.battle.pendingReplace[side]) {
      const action = chooseAction(room.battle, side, seat.bot)
      if (action.kind === 'switch') {
        replaceFainted(room.battle, side, action.index)
        const raw = room.battle.lastRaw
        room.steps.push({ k: 'replace', side, index: action.index })
        if (!room.battle.pendingReplace[0] && !room.battle.pendingReplace[1]) startTurn(room, raw)
        else pushState(room, raw)
      }
      continue
    }
    seat.choice = chooseAction(room.battle, side, seat.bot)
  }

  // If the human has already moved, this completes the turn.
  if (room.seats[0].choice && room.seats[1].choice) runTurn(room)
}

/**
 * A player who never chooses does not stall the match: the server picks the
 * first legal action for them. Without this, one side could hold a wagered
 * match open forever.
 */
function autoAction(room: Room, side: 0 | 1): Action {
  // The engine decides what is legal right now: a Pokémon may be recharging,
  // locked into a move, or owe a switch, none of which is visible from PP.
  return firstLegalAction(room.battle, side)
}

function forceTurn(room: Room) {
  if (room.ended) return
  for (const side of [0, 1] as const) {
    if (!room.seats[side].choice) room.seats[side].choice = autoAction(room, side)
  }
  runTurn(room)
}

export function submitAction(room: Room, address: string, action: Action): string | null {
  if (room.ended) return 'battle is over'
  const seat = room.seats.findIndex((s) => s.address === address)
  if (seat < 0) return 'not a participant'
  const side = seat as 0 | 1

  const b = room.battle

  // A forced replacement after a faint is resolved immediately, not queued.
  if (b.pendingReplace[side]) {
    if (action.kind !== 'switch') return 'you must send out a replacement'
    const t = b.sides[side].team[action.index]
    if (!t || t.fainted) return 'invalid replacement'
    replaceFainted(b, side, action.index)
    const raw = b.lastRaw
    room.steps.push({ k: 'replace', side, index: action.index })
    // Only start the next turn once both sides have replaced. The replacement
    // lines must ride along — startTurn is the only push that follows, and
    // dropping them loses the "Go! X!" line from the player's battle log.
    if (!b.pendingReplace[0] && !b.pendingReplace[1]) startTurn(room, raw)
    else {
      pushState(room, raw)
      takeBotTurns(room)
    }
    return null
  }

  const err = validateAction(b, side, action)
  if (err) return err

  room.seats[side].choice = action
  // Acknowledge privately so the client can lock its UI without leaking the
  // choice to the opponent.
  send(room.seats[side].socket, { type: 'accepted', action })

  if (room.seats[0].choice && room.seats[1].choice) runTurn(room)
  return null
}

function runTurn(room: Room) {
  if (room.ended) return
  if (room.timer) clearTimeout(room.timer)

  const actions: [Action, Action] = [
    room.seats[0].choice ?? autoAction(room, 0),
    room.seats[1].choice ?? autoAction(room, 1),
  ]

  room.steps.push({ k: 'turn', a: actions })
  const events = resolveTurn(room.battle, actions)
  const b = room.battle
  const raw = b.lastRaw

  if (b.finished) return finish(room, events, undefined, raw)

  if (b.pendingReplace[0] || b.pendingReplace[1]) {
    // Clear last turn's actions before the replacement phase. Leaving them set
    // makes takeBotTurns think the bot has already chosen (so it skips the
    // replacement) and then immediately re-runs the turn with stale actions —
    // an infinite loop with a fainted Pokémon stuck in play.
    room.seats[0].choice = null
    room.seats[1].choice = null
    room.deadline = Date.now() + TURN_SECONDS * 1000
    room.timer = setTimeout(() => {
      const forcedRaw: string[] = []
      for (const side of [0, 1] as const) {
        if (b.pendingReplace[side]) {
          const idx = b.sides[side].team.findIndex((m) => !m.fainted)
          if (idx >= 0) {
            replaceFainted(b, side, idx)
            forcedRaw.push(...b.lastRaw)
            room.steps.push({ k: 'replace', side, index: idx })
          }
        }
      }
      startTurn(room, forcedRaw)
    }, TURN_SECONDS * 1000 + 250)
    pushState(room, raw)
    takeBotTurns(room)
    return
  }

  startTurn(room, raw)
}

/** Ends the match, records it, and hands off to the settlement hook. */
export function finish(
  room: Room,
  events: BattleEvent[] = [],
  forced?: { winner: 0 | 1 | null },
  rawLines?: string[],
) {
  if (room.ended) return
  room.ended = true
  if (room.timer) clearTimeout(room.timer)

  const winner = forced ? forced.winner : room.battle.winner

  // The closing narration is rendered from each seat ("the opposing X"), when
  // it came from the battle. Synthetic endings (forfeit/void) pass plain text.
  const eventsFor = (side: 0 | 1) =>
    rawLines && rawLines.length ? viewerEvents(room.battle, side, rawLines) : events

  // Watchers see the same reveal both players do: the closing events and the
  // seed, so a spectator can hand the match straight to the replay verifier.
  if (room.spectators.size > 0) {
    const specEvents = rawLines && rawLines.length ? spectatorEvents(room.battle, rawLines) : events
    const endMsg = JSON.stringify({
      type: 'ended',
      winner,
      seed: room.battle.seed,
      seedHash: room.seedHash,
      events: specEvents,
    })
    for (const sock of room.spectators) {
      if (sock.readyState === 1) sock.send(endMsg)
    }
  }

  db.prepare(
    'UPDATE battles SET winner = ?, log = ?, steps = ?, forced = ?, ended_at = ? WHERE id = ?',
  ).run(
    winner,
    JSON.stringify(events),
    JSON.stringify(room.steps),
    forced ? 1 : 0,
    now(),
    room.id,
  )

  // Practice is for learning: it never touches the ranked record.
  if (room.practice) {
    for (const side of [0, 1] as const) {
      send(room.seats[side].socket, {
        type: 'ended', winner, youWon: winner === side,
        seed: room.battle.seed, seedHash: room.seedHash, events: eventsFor(side), practice: true,
      })
    }
    onEnd(room, winner)
    for (const s of room.seats) byPlayer.delete(s.address)
    setTimeout(() => rooms.delete(room.id), 5 * 60 * 1000)
    return
  }

  // Record W/L for the leaderboard.
  if (winner === null) {
    for (const s of room.seats) {
      db.prepare('UPDATE users SET draws = draws + 1 WHERE address = ?').run(s.address)
    }
  } else {
    db.prepare('UPDATE users SET wins = wins + 1 WHERE address = ?').run(room.seats[winner].address)
    db.prepare('UPDATE users SET losses = losses + 1 WHERE address = ?').run(
      room.seats[1 - winner].address,
    )
  }

  for (const side of [0, 1] as const) {
    send(room.seats[side].socket, {
      type: 'ended',
      winner,
      youWon: winner === side,
      // Revealing the seed lets either player replay and audit the match.
      seed: room.battle.seed,
      seedHash: room.seedHash,
      events: eventsFor(side),
    })
  }

  onEnd(room, winner)

  for (const s of room.seats) byPlayer.delete(s.address)
  // Keep the room briefly so a late reconnect can still read the result.
  setTimeout(() => rooms.delete(room.id), 5 * 60 * 1000)
}

/**
 * Forfeits a player who has been gone too long. Otherwise a losing player
 * could simply close the tab to freeze a wagered match.
 */
/**
 * Resolves matches whose player has been gone past the reconnect window.
 *
 * The rule, and why:
 *
 *  - Before turn 1 has resolved, nothing has been played. The match is voided
 *    as a draw so both stakes come back — this is the "could not start"
 *    case a technical failure produces.
 *  - Once play has begun, leaving is a loss. Anything else would hand every
 *    losing player a free exit: disconnect, get your stake back.
 *  - If both sides are gone, nobody can be awarded the win, so it is a draw.
 */
export function sweepDisconnects(graceSeconds = RECONNECT_SECONDS) {
  for (const room of rooms.values()) {
    if (room.ended) continue

    const overdue = ([0, 1] as const).filter((side) => {
      const seat = room.seats[side]
      return !seat.bot && seat.disconnectedAt !== null &&
        now() - seat.disconnectedAt >= graceSeconds
    })

    if (overdue.length === 0) continue

    // Someone never turned up at all — the match could not begin, so it is
    // voided and both stakes come back. Anyone who did connect and then left
    // is forfeiting, and falls through to the branches below.
    if (overdue.some((side) => !room.seats[side].everConnected)) {
      finish(room, [{ t: 'text', msg: 'A player never connected. The match was voided.' }], {
        winner: null,
      })
      continue
    }

    if (overdue.length === 2) {
      finish(room, [{ t: 'text', msg: 'Both players disconnected. The match was drawn.' }], {
        winner: null,
      })
      continue
    }

    const quitter = overdue[0]
    finish(
      room,
      [{ t: 'text', msg: 'Opponent disconnected and did not return — they forfeit the match.' }],
      { winner: (1 - quitter) as 0 | 1 },
    )
  }
}

export const activeRoomCount = () => [...rooms.values()].filter((r) => !r.ended).length
