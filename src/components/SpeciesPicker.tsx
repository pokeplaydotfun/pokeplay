import { memo, useMemo, useState } from 'react'
import type { Species } from '../lib/api'
import { titleCase } from '../lib/api'
import { Sprite, TypeBadge } from './ui'

export const bst = (s: Species) =>
  s.stats.hp + s.stats.atk + s.stats.def + s.stats.spa + s.stats.spd + s.stats.spe

/** Ditto's only move is Transform, which the simulator does not implement. */
const isUsable = (s: Species) => s.moves.length > 0

const UNUSABLE_REASON =
  'Ditto only learns Transform, which the simulator does not implement — so it cannot be picked.'

export const dexNo = (id: number) => `#${String(id).padStart(3, '0')}`

type Sort = 'dex' | 'name' | 'bst'

const SORTS: { key: Sort; label: string }[] = [
  { key: 'dex', label: 'Dex no.' },
  { key: 'name', label: 'Name' },
  { key: 'bst', label: 'Base total' },
]

const Card = memo(function Card({
  s,
  selected,
  taken,
  onPick,
}: {
  s: Species
  selected: boolean
  taken: boolean
  onPick: (id: number) => void
}) {
  const usable = isUsable(s)
  // Species Clause: already on the team in another slot.
  const blocked = !usable || taken
  return (
    <button
      className={`sp${selected ? ' sp--on' : ''}${blocked ? ' sp--off' : ''}`}
      disabled={blocked}
      title={!usable ? UNUSABLE_REASON : taken ? 'Already on your team — one of each species' : undefined}
      aria-label={`${titleCase(s.name)}, ${dexNo(s.id)}`}
      onClick={() => onPick(s.id)}
    >
      <Sprite src={s.sprites.front} alt="" size={64} />
      <span className="sp__dex">{dexNo(s.id)}</span>
      <span className="sp__name">{titleCase(s.name)}</span>
      <span className="sp__types">
        {s.types.map((t) => (
          <TypeBadge key={t} type={t} small />
        ))}
      </span>
    </button>
  )
})

type Props = {
  species: Species[]
  selectedId: number | null
  /** Species used by OTHER slots; Species Clause blocks re-picking them. */
  takenIds?: number[]
  onPick: (id: number) => void
}

export function SpeciesPicker({ species, selectedId, takenIds = [], onPick }: Props) {
  const taken = useMemo(() => new Set(takenIds), [takenIds])
  const [q, setQ] = useState('')
  const [type, setType] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>('dex')

  const types = useMemo(() => {
    const set = new Set<string>()
    for (const s of species) for (const t of s.types) set.add(t)
    return [...set].sort()
  }, [species])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const digits = needle.replace(/^#/, '')
    const list = species.filter((s) => {
      if (type && !s.types.includes(type)) return false
      if (!needle) return true
      if (s.name.includes(needle)) return true
      return /^\d+$/.test(digits) && String(s.id).includes(digits)
    })
    const sorted = [...list]
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name))
    else if (sort === 'bst') sorted.sort((a, b) => bst(b) - bst(a) || a.id - b.id)
    else sorted.sort((a, b) => a.id - b.id)
    return sorted
  }, [species, q, type, sort])

  return (
    <div className="tb-panel">
      <div className="tb-panel__head">
        <h3>Pick a Pokémon</h3>
        <span className="tb-count">{shown.length} of {species.length}</span>
      </div>

      <input
        className="tb-input"
        placeholder="Search by name or dex number…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search species"
      />

      <div className="tb-chips">
        <button className={`chip${type === null ? ' chip--on' : ''}`} onClick={() => setType(null)}>
          All types
        </button>
        {types.map((t) => (
          <button
            key={t}
            className={`chip chip--type${type === t ? ' chip--on' : ''}`}
            onClick={() => setType(type === t ? null : t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="tb-sort">
        <span className="eyebrow">Sort</span>
        {SORTS.map((s) => (
          <button
            key={s.key}
            className={`tb-sort__btn${sort === s.key ? ' tb-sort__btn--on' : ''}`}
            aria-pressed={sort === s.key}
            onClick={() => setSort(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="tb-note tb-note--pad">Nothing matches that search.</p>
      ) : (
        <div className="sp-grid">
          {shown.map((s) => (
            <Card
              key={s.id}
              s={s}
              selected={s.id === selectedId}
              taken={taken.has(s.id) && s.id !== selectedId}
              onPick={onPick}
            />
          ))}
        </div>
      )}
    </div>
  )
}
