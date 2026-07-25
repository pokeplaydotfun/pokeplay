import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE } from '../config'
import { getToken } from './api'

export type BoostKey = 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'acc' | 'eva'

export type PubMon = {
  speciesId: number
  name: string
  types: string[]
  hp: number
  maxHp: number
  status: string | null
  fainted: boolean
  boosts: Record<BoostKey, number>
  gender: 'M' | 'F' | 'N'
  ability: string | null
}

export type OwnMon = PubMon & {
  /** `eff` is the move's type-effectiveness multiplier against the current
   *  opponent (0, 0.25, 0.5, 1, 2, 4), or null for status moves. Optional so a
   *  response from an older server still parses. */
  moves: { name: string; pp: number; maxPp: number; eff?: number | null }[]
}

export type Weather = 'sun' | 'rain' | 'sand' | 'hail'

export type BattleState = {
  turn: number
  weather: Weather | null
  finished: boolean
  winner: 0 | 1 | null
  mustReplace: boolean
  you: { active: number; team: OwnMon[] }
  foe: { active: number; team: PubMon[] }
}

export type BattleEvent =
  // `side` (absolute 0/1) marks which trainer the line is about, so the log can
  // tag it "You" vs the opponent. Absent on neutral lines (weather, effectiveness).
  | { t: 'text'; msg: string; side?: 0 | 1 }
  | { t: 'damage'; side: 0 | 1; slot: number; hp: number; maxHp: number }
  | { t: 'heal'; side: 0 | 1; slot: number; hp: number; maxHp: number }
  | { t: 'faint'; side: 0 | 1; slot: number }
  | { t: 'switch'; side: 0 | 1; slot: number }
  | { t: 'status'; side: 0 | 1; slot: number; status: string | null }
  | { t: 'boost'; side: 0 | 1; slot: number; stat: BoostKey; by: number }
  | { t: 'weather'; kind: Weather | null }
  | { t: 'end'; winner: 0 | 1 | null }

export type Action = { kind: 'move'; index: number } | { kind: 'switch'; index: number }

/**
 * One line of the battle log. `who` says whose Pokémon the line is about, from
 * the reader's seat — `'you'`, `'foe'`, or `null` for neutral lines (weather,
 * "super effective", turn dividers) — so the log can tag each line.
 */
export type LogLine = { msg: string; who: 'you' | 'foe' | null }

export type Ended = {
  winner: 0 | 1 | null
  youWon: boolean
  seed: string
  seedHash: string
}

type Status = 'connecting' | 'live' | 'closed' | 'error'

/* ------------------------------------------------------------------ */
/* animation pacing                                                    */
/* ------------------------------------------------------------------ */

/**
 * How long each kind of event holds the screen. A turn is played out one event
 * at a time so a match reads like a real battle — a line of text, the HP bar
 * draining, a faint — instead of everything snapping at once. Tuned to match
 * the feel of the main PokePlay game.
 */
const TEXT_MS = 850
const DRAIN_MS = 520
const FAINT_MS = 650
const MISC_MS = 420

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const clone = <T,>(v: T): T =>
  typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v))

/** The active-side mon an absolute-sided event refers to, from the viewer's seat. */
function monFor(view: BattleState, you: 0 | 1, side: 0 | 1, slot: number): PubMon | undefined {
  const s = side === you ? view.you : view.foe
  return s.team[slot]
}

/**
 * Connects to the battle socket and mirrors server state.
 *
 * The client never computes an outcome — it renders what the server sends and
 * posts action choices back. `waiting` is purely a UI lock so a player cannot
 * spam actions while a turn resolves. `view` is a *paced* copy of the state
 * that the arena renders: events are played into it one at a time so the fight
 * animates rather than jumping to the result.
 */
export function useBattle(roomId: string | undefined) {
  const [status, setStatus] = useState<Status>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [you, setYou] = useState<0 | 1>(0)
  const [state, setState] = useState<BattleState | null>(null)
  const [log, setLog] = useState<LogLine[]>([])
  const [deadline, setDeadline] = useState(0)
  const [waiting, setWaiting] = useState(false)
  const [ended, setEnded] = useState<Ended | null>(null)
  const [opponent, setOpponent] = useState<string | null>(null)
  const [opponentName, setOpponentName] = useState<string | null>(null)
  const [practice, setPractice] = useState(false)
  /** Set while the opponent is away and the reconnect clock is running. */
  const [oppGone, setOppGone] = useState<{ deadline: number; voidsMatch: boolean } | null>(null)
  const [seedHash, setSeedHash] = useState<string | null>(null)
  const [stakeWei, setStakeWei] = useState('0')
  const [wagerId, setWagerId] = useState<number | null>(null)

  const sockRef = useRef<WebSocket | null>(null)

  /* -------- paced playback -------- */
  // What the arena renders. Trails `state` while a turn animates, then catches
  // up to it. The controls read `state` (the authoritative final), so they
  // always offer the right moves once animation unlocks them.
  const [view, setView] = useState<BattleState | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // Whose Pokémon the current narration line is about, so the live line can be
  // coloured the same way the log is ('you' teal / 'foe' red / null neutral).
  const [messageSide, setMessageSide] = useState<LogLine['who']>(null)
  const [animating, setAnimating] = useState(false)

  const viewRef = useRef<BattleState | null>(null)
  const youRef = useRef<0 | 1>(0)
  const mountedRef = useRef(true)
  // Queued turns waiting to animate, and a flag so only one drains at a time.
  const queueRef = useRef<{ final?: BattleState; events: BattleEvent[] }[]>([])
  // Latest raw events, exposed for anything that wants them directly.
  const [lastEvents, setLastEvents] = useState<BattleEvent[]>([])
  const drainingRef = useRef(false)
  // Ending payload held back until the last events have finished playing.
  const pendingEndRef = useRef<Ended | null>(null)

  useEffect(() => {
    const token = getToken()
    if (!token) {
      setStatus('error')
      setError('You need to sign in first.')
      return
    }

    // In production the API is same-origin, so API_BASE is empty and there is
    // no host to build a ws:// URL from — fall back to the page's own origin,
    // which also gets us wss:// automatically under HTTPS.
    const base = API_BASE || window.location.origin
    const url = new URL(base.replace(/^http/, 'ws') + '/ws')
    url.searchParams.set('token', token)
    if (roomId) url.searchParams.set('room', roomId)

    const sock = new WebSocket(url)
    sockRef.current = sock

    // A fresh battle starts with an empty animation pipeline.
    mountedRef.current = true
    viewRef.current = null
    queueRef.current = []
    drainingRef.current = false
    pendingEndRef.current = null

    /* -------- the paced player -------- */

    const commitView = (s: BattleState) => {
      const c = clone(s)
      viewRef.current = c
      setView(c)
    }

    // Apply one event to the working copy and hold the screen for its beat.
    const applyEvent = async (work: BattleState, e: BattleEvent) => {
      const you = youRef.current
      switch (e.t) {
        case 'text': {
          // Turn dividers are structure, not narration — no dwell.
          if (/^—\s*turn/i.test(e.msg)) return
          setMessage(e.msg)
          // Tag the line by whose Pokémon it is about, from this viewer's seat.
          const who: LogLine['who'] =
            e.side === undefined ? null : e.side === you ? 'you' : 'foe'
          setMessageSide(who)
          setLog((l) => [...l, { msg: e.msg, who }])
          await sleep(TEXT_MS)
          return
        }
        case 'damage':
        case 'heal': {
          const mon = monFor(work, you, e.side, e.slot)
          if (mon) {
            mon.hp = e.hp
            mon.maxHp = e.maxHp
          }
          await sleep(DRAIN_MS)
          return
        }
        case 'faint': {
          const mon = monFor(work, you, e.side, e.slot)
          if (mon) mon.fainted = true
          await sleep(FAINT_MS)
          return
        }
        case 'switch': {
          ;(e.side === you ? work.you : work.foe).active = e.slot
          await sleep(MISC_MS)
          return
        }
        case 'status': {
          const mon = monFor(work, you, e.side, e.slot)
          if (mon) mon.status = e.status
          await sleep(MISC_MS)
          return
        }
        case 'boost': {
          const mon = monFor(work, you, e.side, e.slot)
          if (mon) mon.boosts[e.stat] = (mon.boosts[e.stat] ?? 0) + e.by
          await sleep(MISC_MS)
          return
        }
        case 'weather':
          work.weather = e.kind
          await sleep(MISC_MS)
          return
        case 'end':
          return
      }
    }

    // Play a turn's events into the view, then settle on the authoritative
    // final. `final` is omitted for the closing events (no post-state is sent);
    // there we settle on whatever the events produced.
    const playTurn = async (events: BattleEvent[], final?: BattleState) => {
      const hadView = Boolean(viewRef.current)
      if (!hadView && final) commitView(final)
      if (!events.length) {
        if (final) commitView(final)
        return
      }
      setAnimating(true)
      const work = clone(viewRef.current ?? final!)
      for (const e of events) {
        if (!mountedRef.current) return
        await applyEvent(work, e)
        const snap = clone(work)
        viewRef.current = snap
        setView(snap)
      }
      commitView(final ?? work)
      setMessage(null)
      setAnimating(false)
    }

    const drainQueue = async () => {
      if (drainingRef.current) return
      drainingRef.current = true
      while (queueRef.current.length) {
        const job = queueRef.current.shift()!
        await playTurn(job.events, job.final)
      }
      drainingRef.current = false
      // The result screen was held back so the final KO could play out.
      if (pendingEndRef.current && mountedRef.current) {
        setEnded(pendingEndRef.current)
        pendingEndRef.current = null
      }
    }

    const enqueue = (events: BattleEvent[], final?: BattleState) => {
      queueRef.current.push({ events, final })
      void drainQueue()
    }

    sock.onopen = () => setStatus('live')

    sock.onmessage = (raw) => {
      const msg = JSON.parse(raw.data as string)

      switch (msg.type) {
        case 'hello':
          setYou(msg.you)
          setSeedHash(msg.seedHash)
          break

        case 'state': {
          setYou(msg.you)
          youRef.current = msg.you
          setState(msg.state as BattleState)
          setDeadline(msg.deadline ?? 0)
          setOpponent(msg.opponent ?? null)
          setOpponentName(msg.opponentName ?? null)
          setPractice(Boolean(msg.practice))
          setStakeWei(msg.stakeWei ?? '0')
          setWagerId(msg.wagerId ?? null)
          setWaiting(false)

          const events = (msg.events ?? []) as BattleEvent[]
          setLastEvents(events)
          // The arena catches up to this state by playing the events; the log
          // is appended to as each line plays, not all at once.
          enqueue(events, msg.state as BattleState)
          break
        }

        case 'opponentGone':
          setOppGone({ deadline: msg.deadline, voidsMatch: Boolean(msg.voidsMatch) })
          break

        case 'opponentBack':
          setOppGone(null)
          break

        case 'accepted':
          // The server has our choice; lock the controls until the turn runs.
          setWaiting(true)
          break

        case 'ended': {
          const events = (msg.events ?? []) as BattleEvent[]
          setLastEvents(events)
          setOppGone(null)
          setWaiting(false)
          const payload: Ended = {
            winner: msg.winner,
            youWon: msg.youWon,
            seed: msg.seed,
            seedHash: msg.seedHash,
          }
          // Let the closing events (the final KO) finish playing before the
          // result screen replaces the arena. No post-state is sent, so the
          // player settles on whatever the events produce.
          if (events.length) {
            pendingEndRef.current = payload
            enqueue(events)
          } else {
            setEnded(payload)
          }
          break
        }

        case 'error':
          setError(msg.error)
          // A rejected action must release the lock, or the UI deadlocks.
          setWaiting(false)
          break
      }
    }

    sock.onerror = () => setStatus('error')
    sock.onclose = () => setStatus((s) => (s === 'error' ? s : 'closed'))

    return () => {
      mountedRef.current = false
      queueRef.current = []
      drainingRef.current = false
      sock.close()
    }
  }, [roomId])

  const send = useCallback((action: Action) => {
    const sock = sockRef.current
    if (!sock || sock.readyState !== WebSocket.OPEN) return
    setError(null)
    setWaiting(true)
    sock.send(JSON.stringify({ type: 'action', action }))
  }, [])

  // Countdown on the opponent's reconnect window.
  const [oppGoneSeconds, setOppGoneSeconds] = useState(0)
  useEffect(() => {
    if (!oppGone) return setOppGoneSeconds(0)
    const tick = () => setOppGoneSeconds(Math.max(0, Math.ceil((oppGone.deadline - Date.now()) / 1000)))
    tick()
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [oppGone])

  // Countdown to the turn deadline, for the timer ring.
  const [secondsLeft, setSecondsLeft] = useState(0)
  useEffect(() => {
    if (!deadline || ended) return setSecondsLeft(0)
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)))
    tick()
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [deadline, ended])

  return {
    status, error, you, state, log, waiting, ended, opponent, opponentName, practice, seedHash,
    oppGone, oppGoneSeconds,
    stakeWei, wagerId, secondsLeft, lastEvents, send,
    // Paced playback: the arena renders `view`, shows `message` while
    // `animating`, and reveals the controls only once animation settles.
    view, message, messageSide, animating,
    clearError: () => setError(null),
  }
}
