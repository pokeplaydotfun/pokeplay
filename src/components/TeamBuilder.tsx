import { useMemo, useState } from 'react'
import { ApiError, api, titleCase } from '../lib/api'
import type { MoveInfo, Pokedex, Species, Team, TeamSlot } from '../lib/api'
import { Banner, Sprite, TypeBadge, STAT_LABEL } from './ui'
import { SpeciesPicker, bst, dexNo } from './SpeciesPicker'
import { CATEGORY_SHORT, MovePicker, moveEffects } from './MovePicker'
import { TraitSelect, type TraitOption } from './TraitSelect'
// Owns the builder's styles now that the standalone Teams page is gone.
import '../styles/teams.css'

export const TEAM_SIZE = 6
export const MAX_MOVES = 4

/**
 * A die, drawn rather than typed as an emoji.
 *
 * The 🎲 glyph renders as a completely different object on macOS, Windows and
 * Android and never picks up the surrounding text colour. This inherits
 * `currentColor` and looks the same everywhere.
 */
function DiceIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="dice-icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <circle cx="8.2" cy="8.2" r="1.45" fill="currentColor" />
      <circle cx="15.8" cy="8.2" r="1.45" fill="currentColor" />
      <circle cx="12" cy="12" r="1.45" fill="currentColor" />
      <circle cx="8.2" cy="15.8" r="1.45" fill="currentColor" />
      <circle cx="15.8" cy="15.8" r="1.45" fill="currentColor" />
    </svg>
  )
}

type Slot = TeamSlot | null

const emptyRoster = (): Slot[] => Array.from({ length: TEAM_SIZE }, () => null)

/** A saved team is always 6 slots, but be defensive about short payloads. */
function rosterFrom(team: Team | null): Slot[] {
  const base = emptyRoster()
  if (!team) return base
  team.slots.slice(0, TEAM_SIZE).forEach((s, i) => {
    base[i] = { speciesId: s.speciesId, moves: [...s.moves], nature: s.nature, ability: s.ability }
  })
  return base
}

const STAT_ROWS: { key: keyof Species['stats']; label: string }[] = [
  { key: 'hp', label: 'HP' },
  { key: 'atk', label: 'Atk' },
  { key: 'def', label: 'Def' },
  { key: 'spa', label: 'Sp. Atk' },
  { key: 'spd', label: 'Sp. Def' },
  { key: 'spe', label: 'Speed' },
]

/**
 * Bars are scaled against 180 rather than the true 255 maximum: almost every
 * stat in gen 1 sits under 180, so the smaller scale keeps the chart readable
 * and the handful of outliers (Chansey's HP) simply peg the bar full.
 */
const BAR_SCALE = 180

const DEFAULT_NATURE = 'hardy'

const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]

const TEAM_NAME_IDEAS = [
  'Squad Alpha', 'The Underdogs', 'Full Send', 'Type Advantage', 'Glass Cannons',
  'Bench Warmers', 'Six Pack', 'Wild Cards', 'The Regulars', 'No Sweat',
]

const STAT_SHORT: Record<string, string> = {
  atk: 'Atk', def: 'Def', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed',
}

type NatureLike = { name: string; up: string | null; down: string | null }

const isNeutralNature = (n: NatureLike) => !n.up || !n.down || n.up === n.down

/** The compact right-hand tag: "+Atk −Sp. Atk", or "neutral" for the five that cancel out. */
function natureHint(n: NatureLike) {
  if (isNeutralNature(n)) return 'neutral'
  return `+${STAT_SHORT[n.up!]} −${STAT_SHORT[n.down!]}`
}

/** A full sentence explaining a nature's effect, for the dropdown footer. */
function natureDesc(n: NatureLike) {
  if (isNeutralNature(n))
    return 'Neutral — changes no stats. A safe pick when you want no trade-off.'
  return `Raises ${STAT_LABEL[n.up!] ?? n.up} by 10% and lowers ${STAT_LABEL[n.down!] ?? n.down} by 10%. HP is never affected.`
}

/** Pick up to four distinct legal moves. */
function randomMoves(sp: Species): string[] {
  const pool = [...sp.moves]
  const out: string[] = []
  while (out.length < MAX_MOVES && pool.length) out.push(...pool.splice(Math.floor(Math.random() * pool.length), 1))
  return out
}

/** A species with nothing the engine implements simply has no ability. */
const defaultAbility = (sp: Species) => (sp.abilities.find((a) => !a.hidden) ?? sp.abilities[0])?.name

const randomAbility = (sp: Species) => (sp.abilities.length ? pick(sp.abilities).name : undefined)

function StatBars({ s }: { s: Species }) {
  return (
    <div className="tb-stats">
      {STAT_ROWS.map((row) => {
        const v = s.stats[row.key]
        return (
          <div className="tb-stat" key={row.key}>
            <span className="tb-stat__label">{row.label}</span>
            <span className="tb-stat__value">{v}</span>
            <span className="tb-stat__track">
              <span
                className="tb-stat__bar"
                style={{ width: `${Math.min(100, (v / BAR_SCALE) * 100)}%` }}
              />
            </span>
          </div>
        )
      })}
      <div className="tb-stat tb-stat--total">
        <span className="tb-stat__label">BST</span>
        <span className="tb-stat__value">{bst(s)}</span>
        <span />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* validation — mirrors the server so the button state is honest       */
/* ------------------------------------------------------------------ */

function validate(name: string, roster: Slot[], byId: Map<number, Species>): string[] {
  const problems: string[] = []
  if (!name.trim()) problems.push('Give the team a name.')

  const filled = roster.filter((s): s is TeamSlot => s !== null)
  if (filled.length < TEAM_SIZE) {
    const missing = TEAM_SIZE - filled.length
    problems.push(`Pick ${missing} more Pokémon — a team is exactly ${TEAM_SIZE}.`)
  }

  // Species Clause, mirroring the server so the Save button is honest.
  const counts = new Map<number, number>()
  for (const s of roster) if (s) counts.set(s.speciesId, (counts.get(s.speciesId) ?? 0) + 1)
  for (const [id, n] of counts) {
    if (n > 1) {
      const sp = byId.get(id)
      problems.push(`Only one ${sp ? titleCase(sp.name) : 'of each species'} per team.`)
    }
  }

  roster.forEach((slot, i) => {
    if (!slot) return
    const sp = byId.get(slot.speciesId)
    const who = sp ? titleCase(sp.name) : `Slot ${i + 1}`
    if (slot.moves.length === 0) problems.push(`${who} needs at least one move.`)
    if (slot.moves.length > MAX_MOVES) problems.push(`${who} has more than ${MAX_MOVES} moves.`)
    if (new Set(slot.moves).size !== slot.moves.length)
      problems.push(`${who} has the same move twice.`)
    if (sp) for (const m of slot.moves)
      if (!sp.moves.includes(m)) problems.push(`${who} cannot learn ${titleCase(m)}.`)
    if (sp && slot.ability && !sp.abilities.some((a) => a.name === slot.ability))
      problems.push(`${who} cannot have ${titleCase(slot.ability)}.`)
  })

  return problems
}

/* ------------------------------------------------------------------ */

type Props = {
  dex: Pokedex
  /** The team being edited, or null when creating a new one. */
  team: Team | null
  signedIn: boolean
  isConnected: boolean
  signingIn: boolean
  onSignIn: () => void
  onSaved: () => void
  onCancel: () => void
}

export function TeamBuilder({
  dex,
  team,
  signedIn,
  isConnected,
  signingIn,
  onSignIn,
  onSaved,
  onCancel,
}: Props) {
  const [name, setName] = useState(team?.name ?? '')
  const [roster, setRoster] = useState<Slot[]>(() => rosterFrom(team))
  const [active, setActive] = useState(0)
  const [pickingMove, setPickingMove] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [serverErrors, setServerErrors] = useState<string[]>([])

  const byId = useMemo(
    () => new Map(dex.species.map((s) => [s.id, s] as const)),
    [dex.species],
  )

  const slot = roster[active] ?? null
  const activeSpecies = slot ? byId.get(slot.speciesId) ?? null : null

  const problems = useMemo(() => validate(name, roster, byId), [name, roster, byId])
  const legal = problems.length === 0

  const dupes = useMemo(() => {
    const seen = new Set<number>()
    const out = new Set<string>()
    for (const s of roster) {
      if (!s) continue
      const sp = byId.get(s.speciesId)
      if (seen.has(s.speciesId) && sp) out.add(titleCase(sp.name))
      seen.add(s.speciesId)
    }
    return [...out]
  }, [roster, byId])

  const setSlot = (i: number, next: Slot) =>
    setRoster((prev) => prev.map((s, idx) => (idx === i ? next : s)))

  const pickSpecies = (id: number) => {
    if (slot && slot.speciesId === id) return
    // Changing species invalidates the old moves, and abilities are per-species.
    const sp = byId.get(id)
    setSlot(active, {
      speciesId: id,
      moves: [],
      nature: DEFAULT_NATURE,
      ability: sp ? defaultAbility(sp) : undefined,
    })
    setServerErrors([])
  }

  const setTrait = (patch: Partial<TeamSlot>) => {
    if (!slot) return
    setSlot(active, { ...slot, ...patch })
    setServerErrors([])
  }

  /** Rolls everything the player can choose, leaving the species alone. */
  const randomiseSlot = () => {
    if (!slot || !activeSpecies) return
    setSlot(active, {
      ...slot,
      moves: randomMoves(activeSpecies),
      nature: pick(dex.natures).name,
      ability: randomAbility(activeSpecies),
    })
    setServerErrors([])
  }

  const addMove = (move: string) => {
    if (!slot || slot.moves.includes(move) || slot.moves.length >= MAX_MOVES) return
    setSlot(active, { ...slot, moves: [...slot.moves, move] })
    setPickingMove(null)
  }

  const removeMove = (idx: number) => {
    if (!slot) return
    setSlot(active, { ...slot, moves: slot.moves.filter((_, i) => i !== idx) })
  }

  const clearSlot = () => {
    setSlot(active, null)
    setServerErrors([])
  }

  /**
   * Fill the whole team in one click — the fastest path from a cold start to a
   * playable team. Six DISTINCT species (Species Clause), each with legal
   * moves, a random nature and a legal ability.
   */
  const randomiseTeam = () => {
    // Only species the engine can actually field (at least one legal move).
    const usable = dex.species.filter((sp) => sp.moves.length > 0)
    const chosen: Species[] = []
    const pool = [...usable]
    while (chosen.length < TEAM_SIZE && pool.length) {
      chosen.push(...pool.splice(Math.floor(Math.random() * pool.length), 1))
    }
    setRoster(
      chosen.map((sp) => ({
        speciesId: sp.id,
        moves: randomMoves(sp),
        nature: pick(dex.natures).name,
        ability: randomAbility(sp),
      })),
    )
    if (!name.trim()) setName(pick(TEAM_NAME_IDEAS))
    setActive(0)
    setPickingMove(null)
    setServerErrors([])
  }

  const save = async () => {
    if (!legal) return
    setSaving(true)
    setServerErrors([])
    const body = { name: name.trim(), slots: roster.filter((s): s is TeamSlot => s !== null) }
    try {
      if (team) await api.put(`/api/teams/${team.id}`, body)
      else await api.post<{ id: number }>('/api/teams', body)
      onSaved()
    } catch (e) {
      // The server's `details` are more precise than anything we could guess.
      if (e instanceof ApiError) setServerErrors(e.details?.length ? e.details : [e.message])
      else setServerErrors([(e as Error).message])
    } finally {
      setSaving(false)
    }
  }

  const chosenMoves: (MoveInfo | null)[] = Array.from({ length: MAX_MOVES }, (_, i) => {
    const n = slot?.moves[i]
    return n ? dex.moves[n] ?? null : null
  })

  const movesLeft = activeSpecies
    ? activeSpecies.moves.length - (slot?.moves.length ?? 0)
    : 0

  // Nature choices never change, so build them once. Each carries a sentence
  // explaining its effect, shown when the row is hovered in the dropdown.
  const natureOptions: TraitOption[] = useMemo(
    () =>
      dex.natures.map((n) => ({
        value: n.name,
        label: titleCase(n.name),
        hint: natureHint(n),
        desc: natureDesc(n),
      })),
    [dex.natures],
  )

  // Abilities are per-species; the description comes straight from the dex, so
  // the builder and the engine can never disagree about what an ability does.
  const abilityOptions: TraitOption[] = useMemo(() => {
    if (!activeSpecies) return []
    return activeSpecies.abilities.map((a) => {
      const info = dex.abilities[a.name]
      return {
        value: a.name,
        label: titleCase(a.name),
        hint: a.hidden ? 'hidden' : undefined,
        desc: info?.text ?? 'No effect in this format.',
        flag: info?.inert ? `No effect here — ${info.inert}` : null,
      }
    })
  }, [activeSpecies, dex.abilities])

  return (
    <div className="tb">
      {/* ---------- quick actions ---------- */}
      <div className="tb-quick">
        <p className="tb-quick__hint">
          New here? Fill a legal team in one tap, then tweak whatever you like.
        </p>
        <button className="btn btn--dark tb-quick__random" onClick={randomiseTeam}>
          <DiceIcon /> Random team
        </button>
      </div>

      {/* ---------- roster strip ---------- */}
      <div className="tb-roster" role="tablist" aria-label="Team slots">
        {roster.map((s, i) => {
          const sp = s ? byId.get(s.speciesId) ?? null : null
          return (
            <button
              key={i}
              role="tab"
              aria-selected={i === active}
              className={`tb-slot${i === active ? ' tb-slot--on' : ''}${sp ? '' : ' tb-slot--empty'}`}
              onClick={() => {
                setActive(i)
                setPickingMove(null)
              }}
            >
              <span className="tb-slot__n">{i + 1}</span>
              {sp ? (
                <>
                  <Sprite src={sp.sprites.front} alt="" size={56} />
                  <span className="tb-slot__name">{titleCase(sp.name)}</span>
                  <span className="tb-slot__types">
                    {sp.types.map((t) => (
                      <TypeBadge key={t} type={t} small />
                    ))}
                  </span>
                  <span className="tb-slot__moves">
                    {s?.moves.length ?? 0}/{MAX_MOVES} moves
                  </span>
                </>
              ) : (
                <>
                  <span className="tb-slot__plus" aria-hidden="true">
                    +
                  </span>
                  <span className="tb-slot__name tb-slot__name--muted">Empty</span>
                </>
              )}
            </button>
          )
        })}
      </div>

      {dupes.length > 0 && (
        <p className="tb-note tb-note--bad">
          {dupes.join(', ')} appear{dupes.length === 1 ? 's' : ''} more than once. Teams are one of
          each species — swap the duplicate for something else.
        </p>
      )}

      {/* ---------- two columns ---------- */}
      <div className="tb-cols">
        <SpeciesPicker
          species={dex.species}
          selectedId={slot?.speciesId ?? null}
          takenIds={roster
            .map((s, i) => (i === active ? null : s?.speciesId ?? null))
            .filter((id): id is number => id !== null)}
          onPick={pickSpecies}
        />

        <div className="tb-panel tb-detail">
          <div className="tb-panel__head">
            <h3>Slot {active + 1}</h3>
            {activeSpecies && (
              <button className="tb-link" onClick={clearSlot}>
                Clear slot
              </button>
            )}
          </div>

          {!activeSpecies ? (
            <p className="tb-note tb-note--pad">
              Nothing in this slot yet. Choose a Pokémon from the list to fill it.
            </p>
          ) : (
            <>
              <div className="tb-hero">
                <img
                  className="tb-hero__art sprite"
                  src={activeSpecies.sprites.art ?? activeSpecies.sprites.front}
                  alt={titleCase(activeSpecies.name)}
                  width={160}
                  height={160}
                />
                <div>
                  <div className="tb-hero__dex">{dexNo(activeSpecies.id)}</div>
                  <div className="tb-hero__name">{titleCase(activeSpecies.name)}</div>
                  <div className="tb-hero__types">
                    {activeSpecies.types.map((t) => (
                      <TypeBadge key={t} type={t} />
                    ))}
                  </div>
                </div>
              </div>

              <StatBars s={activeSpecies} />

              <div className="tb-panel__head tb-panel__head--sub">
                <h3>Nature &amp; ability</h3>
                <button className="tb-link" onClick={randomiseSlot}>
                  Randomise all
                </button>
              </div>

              <div className="tb-traits">
                <div className="tb-trait">
                  <span className="tb-trait__label">Nature</span>
                  <div className="tb-trait__row">
                    <TraitSelect
                      label="Nature"
                      value={slot?.nature ?? DEFAULT_NATURE}
                      options={natureOptions}
                      onChange={(v) => setTrait({ nature: v })}
                    />
                    <button
                      className="tb-dice"
                      title="Random nature"
                      aria-label="Random nature"
                      onClick={() => setTrait({ nature: pick(dex.natures).name })}
                    >
                      <DiceIcon />
                    </button>
                  </div>
                </div>

                <div className="tb-trait">
                  <span className="tb-trait__label">Ability</span>
                  <div className="tb-trait__row">
                    <TraitSelect
                      label="Ability"
                      value={slot?.ability}
                      options={abilityOptions}
                      disabled={abilityOptions.length === 0}
                      placeholder="None available"
                      onChange={(v) => setTrait({ ability: v || undefined })}
                    />
                    <button
                      className="tb-dice"
                      title="Random ability"
                      aria-label="Random ability"
                      disabled={activeSpecies.abilities.length < 2}
                      onClick={() => setTrait({ ability: randomAbility(activeSpecies) })}
                    >
                      <DiceIcon />
                    </button>
                  </div>
                </div>
              </div>

              <p className="tb-trait-hint">
                Hover a nature or ability to see what it does.
              </p>

              {slot?.ability && dex.abilities[slot.ability] && (
                <p className="tb-note">
                  <b>{titleCase(slot.ability)}.</b> {dex.abilities[slot.ability].text}
                  {dex.abilities[slot.ability].inert && (
                    <>
                      {' '}
                      <span className="tb-note__flag">
                        No effect here — {dex.abilities[slot.ability].inert}
                      </span>
                    </>
                  )}
                </p>
              )}

              <div className="tb-panel__head tb-panel__head--sub">
                <h3>Moves</h3>
                <span className="tb-count">
                  {activeSpecies.moves.length} legal
                  {movesLeft <= 0 && activeSpecies.moves.length < MAX_MOVES ? ' · all picked' : ''}
                  <button
                    className="tb-link"
                    onClick={() => setTrait({ moves: randomMoves(activeSpecies) })}
                  >
                    Random moves
                  </button>
                </span>
              </div>

              {activeSpecies.moves.length < MAX_MOVES && (
                <p className="tb-note">
                  {titleCase(activeSpecies.name)} only has {activeSpecies.moves.length} legal move
                  {activeSpecies.moves.length === 1 ? '' : 's'} in this simulator, so it cannot fill
                  all four slots.
                </p>
              )}

              <div className="tb-moves">
                {chosenMoves.map((m, i) => {
                  const beyond = i >= activeSpecies.moves.length
                  if (m) {
                    return (
                      <div className="mv mv--chosen" key={`m${i}`}>
                        <div className="mv__body">
                          <div className="mv__main">
                            <span className="mv__name">{titleCase(m.name)}</span>
                            <TypeBadge type={m.type} small />
                            <span className={`mv__cat mv__cat--${m.category}`}>
                              {CATEGORY_SHORT[m.category]}
                            </span>
                          </div>
                          <div className="mv__meta">
                            <span>
                              <b>{m.power ?? '—'}</b> pow
                            </span>
                            <span>
                              <b>{m.accuracy ?? '—'}</b> acc
                            </span>
                            <span>
                              <b>{m.pp}</b> pp
                            </span>
                          </div>
                          {moveEffects(m).length > 0 && (
                            <div className="mv__fx">
                              {moveEffects(m).map((fx) => (
                                <span className="mv__fx-tag" key={fx}>
                                  {fx}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <button
                          className="mv__remove"
                          onClick={() => removeMove(i)}
                          aria-label={`Remove ${titleCase(m.name)}`}
                        >
                          ✕
                        </button>
                      </div>
                    )
                  }
                  return (
                    <button
                      key={`m${i}`}
                      className="mv mv--add"
                      disabled={beyond}
                      title={beyond ? 'No more legal moves for this Pokémon' : undefined}
                      onClick={() => setPickingMove(i)}
                    >
                      <span className="mv__plus" aria-hidden="true">
                        +
                      </span>
                      {beyond ? 'No move available' : 'Add a move'}
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ---------- save bar ---------- */}
      <div className="tb-save card">
        <label className="tb-field">
          <span className="eyebrow">Team name</span>
          <input
            className="tb-input"
            value={name}
            maxLength={40}
            placeholder="e.g. Thunder & Steel"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="tb-save__right">
          <button className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
          {!signedIn && !isConnected ? (
            <span className="tb-note tb-note--inline">Connect a wallet to save this team.</span>
          ) : !signedIn ? (
            <button className="btn btn--dark" onClick={onSignIn} disabled={signingIn}>
              {signingIn ? 'Check your wallet…' : 'Sign in to save teams'}
            </button>
          ) : (
            <button className="btn btn--dark" onClick={() => void save()} disabled={!legal || saving}>
              {saving ? 'Saving…' : team ? 'Save changes' : 'Create team'}
            </button>
          )}
        </div>

        {problems.length > 0 && (
          <ul className="tb-problems">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}

        {serverErrors.length > 0 && (
          <div className="tb-server-errors">
            <Banner kind="error">
              <ul className="tb-problems tb-problems--bare">
                {serverErrors.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Banner>
          </div>
        )}
      </div>

      {pickingMove !== null && activeSpecies && (
        <MovePicker
          species={activeSpecies}
          moves={dex.moves}
          taken={slot?.moves ?? []}
          onPick={addMove}
          onClose={() => setPickingMove(null)}
        />
      )}
    </div>
  )
}
