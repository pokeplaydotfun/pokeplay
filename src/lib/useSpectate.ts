import { useEffect, useRef, useState } from 'react'
import { API_BASE } from '../config'
import { getToken } from './api'
import type { BattleEvent, PubMon, Weather } from './useBattle'

/**
 * What a watcher sees. Both sides are the public projection the opponent
 * already gets — species, exact HP, status, boosts, ability, but never a move
 * list or PP — and they are absolute (`p0`/`p1`) because a spectator has no
 * "you"; the page labels each side with its trainer's name.
 */
export type SpectateState = {
  turn: number
  weather: Weather | null
  finished: boolean
  winner: 0 | 1 | null
  p0: { active: number; team: PubMon[] }
  p1: { active: number; team: PubMon[] }
}

/** A watcher's log line, tagged with the absolute side (0/1) it is about. */
export type SpectateLine = { msg: string; side?: 0 | 1 }

export type SpectateEnded = { winner: 0 | 1 | null; seed: string; seedHash: string }

/** How each side appears to a watcher — a hidden wallet is masked to its name. */
export type SpectateTrainer = { address: string | null; name: string | null; hidden: boolean }

type Status = 'connecting' | 'live' | 'ended' | 'closed' | 'error'

/* ------------------------------------------------------------------ */
/* animation pacing (mirrors useBattle)                               */
/* ------------------------------------------------------------------ */

const TEXT_MS = 850
const DRAIN_MS = 520
const FAINT_MS = 650
const MISC_MS = 420

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const clone = <T,>(v: T): T =>
  typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v))

/** The active-side mon an absolute-sided event refers to. */
function monFor(view: SpectateState, side: 0 | 1, slot: number): PubMon | undefined {
  return (side === 0 ? view.p0 : view.p1).team[slot]
}

/**
 * Connects to a battle's spectate socket and mirrors its public state, pacing
 * each turn's events one at a time so a watched match animates the same way it
 * does for the players. Read-only: there is no action channel.
 */
export function useSpectate(roomId: string | undefined) {
  const [status, setStatus] = useState<Status>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<SpectateState | null>(null)
  const [log, setLog] = useState<SpectateLine[]>([])
  const [ended, setEnded] = useState<SpectateEnded | null>(null)
  const [p0, setP0] = useState<SpectateTrainer>({ address: null, name: null, hidden: false })
  const [p1, setP1] = useState<SpectateTrainer>({ address: null, name: null, hidden: false })
  const [stakeWei, setStakeWei] = useState('0')
  const [wagerId, setWagerId] = useState<number | null>(null)
  const [spectators, setSpectators] = useState(0)

  /* -------- paced playback -------- */
  const [view, setView] = useState<SpectateState | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [messageSide, setMessageSide] = useState<0 | 1 | null>(null)
  const [animating, setAnimating] = useState(false)

  const viewRef = useRef<SpectateState | null>(null)
  const mountedRef = useRef(true)
  const queueRef = useRef<{ final?: SpectateState; events: BattleEvent[] }[]>([])
  const drainingRef = useRef(false)
  const pendingEndRef = useRef<SpectateEnded | null>(null)

  useEffect(() => {
    if (!roomId) return

    const base = API_BASE || window.location.origin
    const url = new URL(base.replace(/^http/, 'ws') + '/ws')
    url.searchParams.set('spectate', '1')
    url.searchParams.set('room', roomId)
    // No sign-in is required to watch, but pass a token if we happen to have one.
    const token = getToken()
    if (token) url.searchParams.set('token', token)

    const sock = new WebSocket(url)

    mountedRef.current = true
    viewRef.current = null
    queueRef.current = []
    drainingRef.current = false
    pendingEndRef.current = null

    const commitView = (s: SpectateState) => {
      const c = clone(s)
      viewRef.current = c
      setView(c)
    }

    const applyEvent = async (work: SpectateState, e: BattleEvent) => {
      switch (e.t) {
        case 'text': {
          if (/^—\s*turn/i.test(e.msg)) return
          setMessage(e.msg)
          setMessageSide(e.side ?? null)
          setLog((l) => [...l, { msg: e.msg, side: e.side }])
          await sleep(TEXT_MS)
          return
        }
        case 'damage':
        case 'heal': {
          const mon = monFor(work, e.side, e.slot)
          if (mon) {
            mon.hp = e.hp
            mon.maxHp = e.maxHp
          }
          await sleep(DRAIN_MS)
          return
        }
        case 'faint': {
          const mon = monFor(work, e.side, e.slot)
          if (mon) mon.fainted = true
          await sleep(FAINT_MS)
          return
        }
        case 'switch':
          ;(e.side === 0 ? work.p0 : work.p1).active = e.slot
          await sleep(MISC_MS)
          return
        case 'status': {
          const mon = monFor(work, e.side, e.slot)
          if (mon) mon.status = e.status
          await sleep(MISC_MS)
          return
        }
        case 'boost': {
          const mon = monFor(work, e.side, e.slot)
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

    const playTurn = async (events: BattleEvent[], final?: SpectateState) => {
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
      setMessageSide(null)
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
      if (pendingEndRef.current && mountedRef.current) {
        setEnded(pendingEndRef.current)
        setStatus('ended')
        pendingEndRef.current = null
      }
    }

    const enqueue = (events: BattleEvent[], final?: SpectateState) => {
      queueRef.current.push({ events, final })
      void drainQueue()
    }

    sock.onopen = () => setStatus('live')

    sock.onmessage = (raw) => {
      const msg = JSON.parse(raw.data as string)
      switch (msg.type) {
        case 'hello':
          break

        case 'state': {
          setState(msg.state as SpectateState)
          setP0({ address: msg.p0 ?? null, name: msg.p0Name ?? null, hidden: Boolean(msg.p0Hidden) })
          setP1({ address: msg.p1 ?? null, name: msg.p1Name ?? null, hidden: Boolean(msg.p1Hidden) })
          setStakeWei(msg.stakeWei ?? '0')
          setWagerId(msg.wagerId ?? null)
          if (typeof msg.spectators === 'number') setSpectators(msg.spectators)
          enqueue((msg.events ?? []) as BattleEvent[], msg.state as SpectateState)
          break
        }

        case 'ended': {
          const events = (msg.events ?? []) as BattleEvent[]
          const payload: SpectateEnded = {
            winner: msg.winner,
            seed: msg.seed,
            seedHash: msg.seedHash,
          }
          if (events.length) {
            pendingEndRef.current = payload
            enqueue(events)
          } else {
            setEnded(payload)
            setStatus('ended')
          }
          break
        }

        case 'error':
          setError(msg.error)
          break
      }
    }

    sock.onerror = () => setStatus((s) => (s === 'ended' ? s : 'error'))
    sock.onclose = () =>
      setStatus((s) => (s === 'error' || s === 'ended' ? s : 'closed'))

    return () => {
      mountedRef.current = false
      queueRef.current = []
      drainingRef.current = false
      sock.close()
    }
  }, [roomId])

  return {
    status, error, state, log, ended, p0, p1, stakeWei, wagerId, spectators,
    view, message, messageSide, animating,
  }
}
