import { useEffect, useMemo, useRef, useState } from 'react'
import type { MoveInfo, Species } from '../lib/api'
import { titleCase } from '../lib/api'
import { TypeBadge, statLabel } from './ui'

/* ------------------------------------------------------------------ */
/* effect summaries                                                    */
/* ------------------------------------------------------------------ */

/** PokeAPI ailment ids -> a verb that reads naturally in "May … 10%". */
const AILMENT_VERB: Record<string, string> = {
  paralysis: 'paralyse',
  burn: 'burn',
  freeze: 'freeze',
  poison: 'poison',
  'bad-poison': 'badly poison',
  sleep: 'put to sleep',
  confusion: 'confuse',
  infatuation: 'infatuate',
  trap: 'trap',
  flinch: 'flinch',
  'leech-seed': 'seed',
  nightmare: 'give nightmares',
  torment: 'torment',
  disable: 'disable',
  yawn: 'drowse',
  'heal-block': 'heal-block',
  'no-type-immunity': 'expose',
  'ingrain': 'ingrain',
}

const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`)

/**
 * Turns the raw move data into a few short human phrases.
 *
 * Everything here is derived from fields the API actually sends — nothing is
 * invented, so a move with no modelled side effect simply returns an empty list.
 */
export function moveEffects(m: MoveInfo): string[] {
  const out: string[] = []

  for (const sc of m.statChanges) {
    if (!sc.change) continue
    out.push(`${sign(sc.change)} ${statLabel(sc.stat)}`)
  }

  if (m.healing > 0) out.push(`Heals ${m.healing}%`)
  else if (m.healing < 0) out.push(`Costs ${Math.abs(m.healing)}% HP`)

  if (m.drain > 0) out.push(`Drains ${m.drain}%`)
  else if (m.drain < 0) out.push(`Recoil ${Math.abs(m.drain)}%`)

  if (m.ailment && m.ailment !== 'none') {
    const verb = AILMENT_VERB[m.ailment] ?? m.ailment.replace(/-/g, ' ')
    // 0 or 100 both mean "always" in the API's encoding for guaranteed effects.
    out.push(
      m.ailmentChance > 0 && m.ailmentChance < 100
        ? `May ${verb} ${m.ailmentChance}%`
        : `${verb.charAt(0).toUpperCase()}${verb.slice(1)}s`,
    )
  }

  if (m.priority !== 0) out.push(`Priority ${sign(m.priority)}`)

  return out
}

export const CATEGORY_SHORT: Record<MoveInfo['category'], string> = {
  // Not "SPE" for special — that reads as Speed next to a stat change.
  physical: 'PHYS',
  special: 'SPEC',
  status: 'STATUS',
}

/* ------------------------------------------------------------------ */
/* the row, reused by the picker and by the chosen-move list           */
/* ------------------------------------------------------------------ */

function MoveRow({ move }: { move: MoveInfo }) {
  const effects = moveEffects(move)
  return (
    <>
      <div className="mv__main">
        <span className="mv__name">{titleCase(move.name)}</span>
        <TypeBadge type={move.type} small />
        <span className={`mv__cat mv__cat--${move.category}`}>{CATEGORY_SHORT[move.category]}</span>
      </div>
      <div className="mv__meta">
        <span>
          <b>{move.power ?? '—'}</b> pow
        </span>
        <span>
          <b>{move.accuracy ?? '—'}</b> acc
        </span>
        <span>
          <b>{move.pp}</b> pp
        </span>
      </div>
      {move.text && <div className="mv__text">{move.text}</div>}
      {effects.length > 0 && (
        <div className="mv__fx">
          {effects.map((e) => (
            <span className="mv__fx-tag" key={e}>
              {e}
            </span>
          ))}
        </div>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* the overlay                                                         */
/* ------------------------------------------------------------------ */

type Props = {
  species: Species
  moves: Record<string, MoveInfo>
  /** Moves already on this Pokémon — they are shown, but not selectable. */
  taken: string[]
  onPick: (move: string) => void
  onClose: () => void
}

export function MovePicker({ species, moves, taken, onPick, onClose }: Props) {
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const legal = useMemo(() => {
    const list = species.moves.map((n) => moves[n]).filter((m): m is MoveInfo => Boolean(m))
    list.sort((a, b) => a.name.localeCompare(b.name))
    return list
  }, [species, moves])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return legal
    // Searching the description as well matters now that a Pokémon can have
    // hundreds of legal moves: "heal", "switch" or "paralyse" finds them
    // without having to know the name.
    return legal.filter(
      (m) =>
        m.name.includes(needle) ||
        m.type.includes(needle) ||
        m.category.startsWith(needle) ||
        (m.text ?? '').toLowerCase().includes(needle),
    )
  }, [legal, q])

  return (
    <div
      className="modal__backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal tb-movemodal" role="dialog" aria-modal="true" aria-label="Choose a move">
        <div className="modal__head">
          <div>
            <div className="modal__title">Choose a move</div>
            <div className="modal__sub">
              {titleCase(species.name)} · {legal.length} legal move{legal.length === 1 ? '' : 's'}
            </div>
          </div>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="tb-movemodal__search">
          <input
            ref={inputRef}
            className="tb-input"
            placeholder="Search name, type, category or effect…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        <div className="modal__list tb-movelist">
          {shown.length === 0 && <p className="tb-note tb-note--pad">No moves match “{q}”.</p>}
          {shown.map((m) => {
            const isTaken = taken.includes(m.name)
            return (
              <button
                key={m.name}
                className={`mv${isTaken ? ' mv--taken' : ''}`}
                disabled={isTaken}
                title={isTaken ? 'Already on this Pokémon' : undefined}
                onClick={() => onPick(m.name)}
              >
                <MoveRow move={m} />
                {isTaken && <span className="mv__taken-tag">On team</span>}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
