import type { ReactNode } from 'react'

/**
 * The PokePlay mark: a Pokéball whose centre button is a play triangle.
 *
 * Drawn as inline SVG rather than shipping the PNG — it stays sharp at every
 * size, needs no extra request, and recolours with the theme if we ever want it.
 */
export function Mark({ size = 40 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      role="img"
      aria-label="PokePlay"
    >
      {/* lower half */}
      <circle cx="50" cy="50" r="40" fill="#ffffff" />
      {/* upper half */}
      <path d="M10 50a40 40 0 0 1 80 0Z" fill="#ff2323" />
      {/* the band across the middle */}
      <path d="M10 50h80" stroke="#0d0d0d" strokeWidth="8.5" />
      {/* outer ring, drawn last so it sits over the fills */}
      <circle cx="50" cy="50" r="40" stroke="#0d0d0d" strokeWidth="8.5" />
      {/* play button in place of the usual catch button */}
      <path
        d="M45.5 42 58 50 45.5 58Z"
        fill="#ffffff"
        stroke="#0d0d0d"
        strokeWidth="6.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Canonical stat labels. The API sends the short keys (`spd`, `spe`), which are
 * easy to confuse — "Spd" reads as Speed but means Special Defense. Spell them
 * out so a player never picks a move expecting the wrong stat.
 */
export const STAT_LABEL: Record<string, string> = {
  hp: 'HP',
  atk: 'Attack',
  def: 'Defense',
  spa: 'Sp. Atk',
  spd: 'Sp. Def',
  spe: 'Speed',
  acc: 'Accuracy',
  eva: 'Evasion',
  // PokeAPI long forms, in case an unnormalised value ever reaches the UI.
  attack: 'Attack',
  defense: 'Defense',
  'special-attack': 'Sp. Atk',
  'special-defense': 'Sp. Def',
  speed: 'Speed',
  accuracy: 'Accuracy',
  evasion: 'Evasion',
}

export const statLabel = (key: string) => STAT_LABEL[key] ?? key

export const TYPE_COLORS: Record<string, string> = {
  normal: '#9099a1', fire: '#ff9d55', water: '#5090d6', electric: '#f4d23c',
  grass: '#63bc5a', ice: '#73cec0', fighting: '#ce4069', poison: '#aa6bc8',
  ground: '#d97845', flying: '#8fa9de', psychic: '#fa7179', bug: '#91c12f',
  rock: '#c5b78c', ghost: '#5269ad', dragon: '#0b6dc3', dark: '#5a5465',
  steel: '#5a8ea1', fairy: '#ec8fe6',
}

export function TypeBadge({ type, small = false }: { type: string; small?: boolean }) {
  return (
    <span
      className={`type-badge${small ? ' type-badge--sm' : ''}`}
      style={{ background: TYPE_COLORS[type] ?? '#999' }}
    >
      {type}
    </span>
  )
}

export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__title">{title}</div>
      <div className="empty__body">{body}</div>
      {action && <div style={{ marginTop: 18 }}>{action}</div>}
    </div>
  )
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="spinner" role="status">
      <span className="spinner__dot" />
      {label}
    </div>
  )
}

export function Banner({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'error'; children: ReactNode }) {
  return <div className={`banner banner--${kind}`}>{children}</div>
}

/**
 * Shown when the frontend is up but the battle API is not answering.
 *
 * "Failed to fetch" on its own sends people hunting through browser devtools,
 * when the cause is almost always that only one of the two dev servers is
 * running — so say which command fixes it.
 */
export function ApiDown({ what, error }: { what: string; error: string }) {
  const offline = /failed to fetch|networkerror|load failed/i.test(error)
  return (
    <Banner kind="error">
      <strong>Could not load {what}.</strong>{' '}
      {offline ? (
        <>
          The battle API is not responding, so the frontend has nothing to read from. Start both
          servers together with <code>npm run dev:all</code> from the project root, or run the API
          on its own with <code>cd server &amp;&amp; npm start</code>.
        </>
      ) : (
        error
      )}
      {offline && <div className="banner__detail">{error}</div>}
    </Banner>
  )
}

/** Renders a real value, or an honest dash when we do not have one. */
export function Stat({ value, label, format }: { value: number | null; label: string; format?: 'usd' }) {
  const shown =
    value === null
      ? '—'
      : format === 'usd'
        ? `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
        : value.toLocaleString('en-US')
  return (
    <div>
      <div className={`stat__value${value === null ? ' placeholder' : ''}`}>{shown}</div>
      <div className="stat__label">{label}</div>
    </div>
  )
}

/** Official PokeAPI sprite, with a stable box so the grid does not jump. */
export function Sprite({
  src, alt, size = 72, back = false,
}: { src: string; alt: string; size?: number; back?: boolean }) {
  return (
    <img
      className="sprite"
      src={src}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      style={{ transform: back ? 'scaleX(-1)' : undefined }}
    />
  )
}

export function HpBar({ hp, maxHp }: { hp: number; maxHp: number }) {
  const pct = maxHp > 0 ? Math.max(0, (hp / maxHp) * 100) : 0
  const tone = pct > 50 ? 'ok' : pct > 20 ? 'warn' : 'low'
  return (
    <div className="hpbar">
      <div className={`hpbar__fill hpbar__fill--${tone}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

const STATUS_LABEL: Record<string, string> = {
  brn: 'BRN', par: 'PAR', psn: 'PSN', tox: 'TOX', slp: 'SLP', frz: 'FRZ',
}

export function StatusChip({ status }: { status: string | null }) {
  if (!status) return null
  return <span className={`status-chip status-chip--${status}`}>{STATUS_LABEL[status] ?? status}</span>
}
