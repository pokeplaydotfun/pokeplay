import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, loadPokedex, shortAddr, titleCase, type Pokedex } from '../lib/api'
import { Banner, HpBar, Spinner, StatusChip, TypeBadge } from '../components/ui'
import '../styles/battle.css'
import '../styles/replay.css'
import { Address } from '../components/Address'

type Mon = {
  speciesId: number
  name: string
  types: string[]
  hp: number
  maxHp: number
  status: string | null
  fainted: boolean
}

type Turn = {
  turn: number
  // `side` (absolute 0/1) tags which trainer a line is about; absent on neutral
  // lines and on replays recorded before line-tagging existed.
  events: { t: string; msg?: string; side?: 0 | 1 }[]
  state: { you: { active: number; team: Mon[] }; foe: { active: number; team: Mon[] } }
}

type Replay = {
  id: string
  // null when the player hid their wallet — name still shows, address never does.
  p0: string | null
  p1: string | null
  p0Name: string | null
  p1Name: string | null
  p0Hidden: boolean
  p1Hidden: boolean
  winner: 0 | 1 | null
  forced: boolean
  seed: string
  seedHash: string
  seedVerified: boolean
  practice: boolean
  endedAt: number
  turns: Turn[]
  reproduced: boolean
}

const SPEEDS = [0.5, 1, 2, 4]

export default function ReplayPage() {
  const { id } = useParams()
  const [replay, setReplay] = useState<Replay | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dex, setDex] = useState<Pokedex | null>(null)

  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [copied, setCopied] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadPokedex().then(setDex).catch(() => setDex(null))
    api
      .get<Replay>(`/api/replay/${id}`)
      .then(setReplay)
      .catch((e) => setError((e as Error).message))
  }, [id])

  const total = replay?.turns.length ?? 0

  // Advance while playing. Steps are paced by how much happened in them, so a
  // long exchange does not flash past at the same rate as a single switch.
  useEffect(() => {
    if (!playing || !replay || step >= total - 1) return
    const lines = replay.turns[step]?.events.filter((e) => e.t === 'text').length || 1
    const ms = Math.min(2600, 420 + lines * 260) / speed
    const t = setTimeout(() => setStep((s) => Math.min(s + 1, total - 1)), ms)
    return () => clearTimeout(t)
  }, [playing, step, total, speed, replay])

  // Only stop at the end of a *loaded* replay. Before the fetch resolves
  // `total` is 0, and `step >= total - 1` is `0 >= -1` — which would switch
  // playback off before it ever began.
  useEffect(() => {
    if (total > 0 && step >= total - 1) setPlaying(false)
  }, [step, total])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [step])

  const share = useCallback(async () => {
    const url = `${window.location.origin}/replay/${id}`
    // Use the native sheet on mobile where it exists; fall back to clipboard.
    if (navigator.share) {
      try {
        await navigator.share({ title: 'PokePlay battle', url })
        return
      } catch {
        // User dismissed the sheet — fall through to copying.
      }
    }
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }, [id])

  const sprite = (sid: number, back: boolean) =>
    dex?.species.find((s) => s.id === sid)?.sprites[back ? 'back' : 'front'] ?? ''

  // Every log line up to and including the current step, each tagged with the
  // side it is about (0/1) so it can be labelled with that trainer's name.
  const log = useMemo(() => {
    if (!replay) return []
    return replay.turns
      .slice(0, step + 1)
      .flatMap((t) =>
        t.events
          .filter((e) => e.t === 'text')
          .map((e) => ({ msg: e.msg as string, side: e.side })),
      )
  }, [replay, step])

  if (error) {
    return (
      <section className="section">
        <div className="wrap">
          <Banner kind="error">{error}</Banner>
          <p style={{ marginTop: 18 }}>
            <Link className="btn btn--ghost" to="/play">
              Back to Play
            </Link>
          </p>
        </div>
      </section>
    )
  }

  if (!replay) {
    return (
      <section className="section">
        <div className="wrap">
          <Spinner label="Loading the replay…" />
        </div>
      </section>
    )
  }

  const cur = replay.turns[step]
  const me = cur.state.you.team[cur.state.you.active]
  const foe = cur.state.foe.team[cur.state.foe.active]

  // A plain-text name for each side, used in the "X won" line. A hidden player
  // shows their username (or a generic label), never an address.
  const sideLabel = (side: 0 | 1): string => {
    if (replay.practice) return side === 0 ? 'Player' : 'Practice AI'
    const name = side === 0 ? replay.p0Name : replay.p1Name
    const hidden = side === 0 ? replay.p0Hidden : replay.p1Hidden
    const addr = side === 0 ? replay.p0 : replay.p1
    if (hidden) return name ?? 'Hidden trainer'
    return name ?? (addr ? shortAddr(addr) : 'Trainer')
  }

  // The header element for each side: a clickable address when public, or just
  // the username with a lock when the player hid their wallet.
  const sideTag = (side: 0 | 1) => {
    if (replay.practice) return sideLabel(side)
    const hidden = side === 0 ? replay.p0Hidden : replay.p1Hidden
    const addr = side === 0 ? replay.p0 : replay.p1
    if (hidden || !addr) {
      return <span className="replay__hidden">🔒 {sideLabel(side)}</span>
    }
    return <Address value={addr} />
  }

  const result =
    replay.winner === null ? 'Draw' : `${sideLabel(replay.winner)} won`

  return (
    <div className="wrap battle replay">
      <div className="battle__head">
        <div>
          <div className="eyebrow">
            Replay · {sideTag(0)} vs {sideTag(1)}
            {replay.practice && ' · practice'}
          </div>
          <h1 className="battle__title">{result}</h1>
        </div>
        <button className="btn btn--dark" onClick={() => void share()}>
          {copied ? 'Link copied' : 'Share'}
        </button>
      </div>

      {!replay.reproduced && (
        <Banner kind="error">
          This battle could not be reproduced from its seed. The stored result and the stored
          moves disagree, so treat the outcome as unverified.
        </Banner>
      )}

      {/* arena ------------------------------------------------------- */}
      <div className="arena">
        <div className="arena__side arena__side--foe">
          <div className="plate plate--left">
            <div className="plate__row">
              <span className="plate__name">{titleCase(foe.name)}</span>
              <StatusChip status={foe.status} />
            </div>
            <HpBar hp={foe.hp} maxHp={foe.maxHp} />
            <div className="plate__hp">
              {Math.round((foe.hp / foe.maxHp) * 100)}%
            </div>
            <div className="plate__types">
              {foe.types.map((t) => (
                <TypeBadge key={t} type={t} small />
              ))}
            </div>
          </div>
          <img
            className={`mon mon--foe${foe.fainted ? ' mon--fainted' : ''}`}
            src={sprite(foe.speciesId, false)}
            alt={titleCase(foe.name)}
          />
          <div className="tray">
            {cur.state.foe.team.map((m, i) => (
              <span
                key={i}
                className={`tray__pip${m.fainted ? ' tray__pip--out' : ''}${
                  i === cur.state.foe.active ? ' tray__pip--active' : ''
                }`}
              />
            ))}
          </div>
        </div>

        <div className="arena__side arena__side--you">
          <img
            className={`mon mon--you${me.fainted ? ' mon--fainted' : ''}`}
            src={sprite(me.speciesId, true) || sprite(me.speciesId, false)}
            alt={titleCase(me.name)}
          />
          <div className="plate plate--right">
            <div className="plate__row">
              <span className="plate__name">{titleCase(me.name)}</span>
              <StatusChip status={me.status} />
            </div>
            <HpBar hp={me.hp} maxHp={me.maxHp} />
            <div className="plate__hp">
              {me.hp} / {me.maxHp}
            </div>
            <div className="plate__types">
              {me.types.map((t) => (
                <TypeBadge key={t} type={t} small />
              ))}
            </div>
          </div>
          <div className="tray">
            {cur.state.you.team.map((m, i) => (
              <span
                key={i}
                className={`tray__pip${m.fainted ? ' tray__pip--out' : ''}${
                  i === cur.state.you.active ? ' tray__pip--active' : ''
                }`}
              />
            ))}
          </div>
        </div>
      </div>

      {/* controls ---------------------------------------------------- */}
      <div className="rp__bar">
        <button
          className="rp__btn rp__btn--primary"
          onClick={() => (step >= total - 1 ? (setStep(0), setPlaying(true)) : setPlaying((p) => !p))}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {step >= total - 1 ? '↻' : playing ? '❚❚' : '▶'}
        </button>

        <button className="rp__btn" onClick={() => { setPlaying(false); setStep((s) => Math.max(0, s - 1)) }}>
          ‹
        </button>
        <button
          className="rp__btn"
          onClick={() => { setPlaying(false); setStep((s) => Math.min(total - 1, s + 1)) }}
        >
          ›
        </button>

        <input
          className="rp__scrub"
          type="range"
          min={0}
          max={Math.max(0, total - 1)}
          value={step}
          onChange={(e) => { setPlaying(false); setStep(Number(e.target.value)) }}
          aria-label="Scrub through the battle"
        />

        <span className="rp__count">
          Turn {cur.turn} · {step + 1}/{total}
        </span>

        <div className="rp__speeds">
          {SPEEDS.map((s) => (
            <button
              key={s}
              className={`rp__speed${speed === s ? ' rp__speed--on' : ''}`}
              onClick={() => setSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>

      {/* log + verification ------------------------------------------ */}
      <div className="rp__bottom">
        <div className="logbox">
          <div className="logbox__head">Battle log</div>
          <div className="logbox__body" ref={logRef}>
            {log.map((line, i) => (
              <div
                key={i}
                className={`logbox__line${line.msg.startsWith('—') ? ' logbox__line--turn' : ''}`}
              >
                {line.side !== undefined && (
                  <span className={`logtag logtag--${line.side === 0 ? 'you' : 'foe'}`}>
                    {sideLabel(line.side)}
                  </span>
                )}
                {line.msg}
              </div>
            ))}
          </div>
        </div>

        <div className="card rp__verify">
          <div className="eyebrow">Verification</div>
          <ul className="rp__checks">
            <li className={replay.seedVerified ? 'ok' : 'bad'}>
              {replay.seedVerified ? '✓' : '✕'} Seed matches the commitment published before the
              first turn
            </li>
            <li className={replay.reproduced ? 'ok' : 'bad'}>
              {replay.reproduced ? '✓' : '✕'} Re-running the moves against that seed reproduces
              this exact result
            </li>
          </ul>
          <p className="rp__note">
            This replay is not a recording. The server re-ran the battle engine from the seed and
            the players' choices — if either had been altered afterwards, the outcome above would
            not match.
            {replay.forced && ' This match ended by forfeit, which is decided outside the rules.'}
          </p>
          <div className="rp__hashes">
            <div>
              <span>Commitment</span>
              <code>{replay.seedHash}</code>
            </div>
            <div>
              <span>Seed</span>
              <code>{replay.seed}</code>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
