/**
 * Reference data for engine v2, built from @pkmn/dex.
 *
 * v1's data layer had to filter the move list down to what its hand-written
 * engine could faithfully reproduce, which cut ~40% of the moves the first 151
 * can legally learn. The sim implements all of them, so this layer no longer
 * filters on mechanics — it just reports what the dex says.
 *
 * IMPORTANT — this payload is now DISPLAY ONLY. The sim is the source of truth
 * for how a move behaves; nothing here drives a battle. It exists so the team
 * builder can show types, power, accuracy and hover help.
 *
 * Move keys stay in the hyphenated form v1 used ('body-slam'), because saved
 * teams in the database store them that way. Changing the key format would
 * silently invalidate every team a player has already built.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Dex } from '@pkmn/sim'

const GEN = 9
const gen = Dex.forGen(GEN)

/**
 * Moves deliberately kept out of team building.
 *
 * This is the whole exclusion list — contrast v1, which had to exclude 252.
 * Baton Pass is excluded by product decision, not capability: passing stat
 * boosts to a fresh Pokémon makes for degenerate matches.
 */
export const EXCLUDED_MOVES = new Set(['baton-pass'])

/* ------------------------------------------------------------------ */
/* sprites + canonical keys come from the existing generated dex        */
/* ------------------------------------------------------------------ */

type RawDex = {
  pokemon: { id: number; sprites: Record<string, string | null>; genderRate: number }[]
  moves: { name: string }[]
}

const raw = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../data/pokedex.json', import.meta.url)), 'utf8'),
) as RawDex

const SPRITES = new Map(raw.pokemon.map((p) => [p.id, p.sprites]))
const GENDER_RATE = new Map(raw.pokemon.map((p) => [p.id, p.genderRate]))

/** sim id ('bodyslam') → the canonical hyphenated key ('body-slam'). */
const KEY_BY_SIM_ID = new Map<string, string>()
for (const m of raw.moves) KEY_BY_SIM_ID.set(simId(m.name), m.name)

/** Strip everything but letters and digits, which is exactly the sim's id. */
export function simId(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

/** The hyphenated key we expose for a sim id, derived if we have never seen it. */
function keyFor(id: string, displayName: string): string {
  const known = KEY_BY_SIM_ID.get(id)
  if (known) return known
  return displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/* ------------------------------------------------------------------ */
/* moves                                                               */
/* ------------------------------------------------------------------ */

export type DexMove = {
  name: string
  type: string
  category: 'physical' | 'special' | 'status'
  power: number | null
  accuracy: number | null
  pp: number
  priority: number
  /** Plain-English description, shown on hover in the builder. */
  text: string
  ailment: string | null
  ailmentChance: number
  statChanges: { stat: string; change: number }[]
  healing: number
  drain: number
}

const STAT_KEY: Record<string, string> = {
  atk: 'atk', def: 'def', spa: 'spa', spd: 'spd', spe: 'spe',
  accuracy: 'acc', evasion: 'eva',
}

/** Everything the first 151 can learn in this generation, by canonical key. */
export const MOVES = new Map<string, DexMove>()
/** Reverse lookup so the engine can turn a stored key into a sim id. */
export const SIM_ID_BY_KEY = new Map<string, string>()

/* ------------------------------------------------------------------ */
/* species                                                             */
/* ------------------------------------------------------------------ */

export type DexSpecies = {
  id: number
  name: string
  types: string[]
  stats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number }
  sprites: Record<string, string | null>
  /** Canonical move keys this species can legally learn. */
  moves: string[]
  abilities: { name: string; hidden: boolean }[]
  genderRate: number
}

export const SPECIES = new Map<number, DexSpecies>()
/** Same entries keyed by lowercase name, for presets written by hand. */
export const SPECIES_BY_NAME = new Map<string, DexSpecies>()

export type DexAbility = { name: string; text: string }
export const ABILITIES = new Map<string, DexAbility>()

/* ------------------------------------------------------------------ */
/* build                                                               */
/* ------------------------------------------------------------------ */

/**
 * Learnsets are async in @pkmn, so the tables are filled once at startup and
 * every consumer awaits the same promise.
 */
export const ready: Promise<void> = (async () => {
  const list = gen.species
    .all()
    .filter((s) => s.num >= 1 && s.num <= 151 && !s.forme)
    .sort((a, b) => a.num - b.num)

  for (const s of list) {
    const learnset = await gen.learnsets.get(s.id)
    const keys: string[] = []

    for (const id of Object.keys(learnset?.learnset ?? {})) {
      const m = gen.moves.get(id)
      if (!m || !m.exists) continue
      const key = keyFor(id, m.name)
      if (EXCLUDED_MOVES.has(key)) continue
      keys.push(key)

      if (!MOVES.has(key)) {
        SIM_ID_BY_KEY.set(key, id)
        MOVES.set(key, {
          name: key,
          type: m.type.toLowerCase(),
          category: m.category.toLowerCase() as DexMove['category'],
          // Status moves report 0; v1 used null and the client renders "—".
          power: m.basePower > 0 ? m.basePower : null,
          // `true` in the sim means "cannot miss", which v1 expressed as null.
          accuracy: m.accuracy === true ? null : m.accuracy,
          pp: m.pp,
          priority: m.priority,
          text: m.shortDesc || m.desc || '',
          ailment: m.status ?? m.secondary?.status ?? null,
          ailmentChance: m.secondary?.chance ?? (m.status ? 100 : 0),
          statChanges: Object.entries(m.boosts ?? {}).map(([stat, change]) => ({
            stat: STAT_KEY[stat] ?? stat,
            change: change as number,
          })),
          healing: typeof m.heal?.[0] === 'number' && m.heal?.[1]
            ? Math.round((m.heal[0] / m.heal[1]) * 100)
            : 0,
          drain: m.drain
            ? Math.round((m.drain[0] / m.drain[1]) * 100)
            : m.recoil
              ? -Math.round((m.recoil[0] / m.recoil[1]) * 100)
              : 0,
        })
      }
    }

    keys.sort()

    for (const a of Object.values(s.abilities)) {
      const ab = gen.abilities.get(String(a))
      if (ab?.exists && !ABILITIES.has(abilityKey(ab.name))) {
        ABILITIES.set(abilityKey(ab.name), { name: ab.name, text: ab.shortDesc || ab.desc || '' })
      }
    }

    const entry: DexSpecies = {
      id: s.num,
      name: s.name.toLowerCase(),
      types: s.types.map((t) => t.toLowerCase()),
      stats: {
        hp: s.baseStats.hp, atk: s.baseStats.atk, def: s.baseStats.def,
        spa: s.baseStats.spa, spd: s.baseStats.spd, spe: s.baseStats.spe,
      },
      sprites: SPRITES.get(s.num) ?? {},
      moves: keys,
      abilities: Object.entries(s.abilities).map(([k, v]) => ({
        name: abilityKey(String(v)),
        hidden: k === 'H',
      })),
      genderRate: GENDER_RATE.get(s.num) ?? -1,
    }
    SPECIES.set(s.num, entry)
    SPECIES_BY_NAME.set(entry.name, entry)
  }
})()

/** Abilities are keyed hyphenated too, matching v1 and the saved teams. */
export function abilityKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export const allSpecies = () => [...SPECIES.values()].sort((a, b) => a.id - b.id)

/* ------------------------------------------------------------------ */
/* team validation                                                     */
/* ------------------------------------------------------------------ */

import { NATURES } from './natures.js'

export const TEAM_SIZE = 6
export const MAX_MOVES = 4
export const NO_ABILITY = 'none'

const NATURE_NAMES = new Set(NATURES.map((n) => n.name))

/**
 * Validate a submitted team against the v2 dex.
 *
 * Mirrors v1's rules exactly — six Pokémon, Species Clause, 1–4 legal moves,
 * a legal ability and nature — but checks them against @pkmn's learnsets. This
 * is the boundary a crafted request hits, so it must never trust the builder.
 */
export function validateTeam(team: unknown): string[] {
  const errs: string[] = []
  if (!Array.isArray(team)) return ['team must be an array']
  if (team.length !== TEAM_SIZE) errs.push(`team must have exactly ${TEAM_SIZE} Pokémon`)

  // Species Clause: one of each, or the format collapses into six of whatever
  // is strongest.
  const seen = new Set<number>()
  const repeated = new Set<number>()
  for (const slot of team as Partial<{ speciesId: number }>[]) {
    const id = slot?.speciesId
    if (typeof id !== 'number') continue
    if (seen.has(id)) repeated.add(id)
    seen.add(id)
  }
  for (const id of repeated) {
    errs.push(`only one ${SPECIES.get(id)?.name ?? `species ${id}`} per team`)
  }

  team.forEach((slot: unknown, i: number) => {
    const at = `slot ${i + 1}`
    if (typeof slot !== 'object' || slot === null) return errs.push(`${at}: malformed`)
    const s = slot as Partial<{ speciesId: number; moves: string[]; nature: string; ability: string }>

    const sp = typeof s.speciesId === 'number' ? SPECIES.get(s.speciesId) : undefined
    if (!sp) return errs.push(`${at}: unknown species`)
    if (sp.moves.length === 0) return errs.push(`${at}: ${sp.name} has no usable moves`)

    if (!Array.isArray(s.moves) || s.moves.length < 1 || s.moves.length > MAX_MOVES) {
      return errs.push(`${at}: needs 1–${MAX_MOVES} moves`)
    }
    if (new Set(s.moves).size !== s.moves.length) errs.push(`${at}: duplicate moves`)

    for (const mv of s.moves) {
      if (typeof mv !== 'string' || !MOVES.has(mv)) {
        errs.push(`${at}: unsupported move "${mv}"`)
      } else if (!sp.moves.includes(mv)) {
        errs.push(`${at}: ${sp.name} cannot learn ${mv}`)
      }
    }

    if (s.nature !== undefined && (typeof s.nature !== 'string' || !NATURE_NAMES.has(s.nature))) {
      errs.push(`${at}: unknown nature "${s.nature}"`)
    }

    // An ability must be one this species can actually have, or none at all —
    // otherwise a crafted request could hand Magikarp Huge Power.
    if (s.ability !== undefined && s.ability !== NO_ABILITY) {
      if (typeof s.ability !== 'string' || !ABILITIES.has(s.ability)) {
        errs.push(`${at}: unsupported ability "${s.ability}"`)
      } else if (!sp.abilities.some((a) => a.name === s.ability)) {
        errs.push(`${at}: ${sp.name} cannot have ${s.ability}`)
      }
    }
  })

  return errs
}
