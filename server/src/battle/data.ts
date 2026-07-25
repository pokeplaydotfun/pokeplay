import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PokeType } from './typechart.js'
import { isSupportedAbility } from './abilities.js'

export type Species = {
  id: number
  name: string
  types: PokeType[]
  stats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number }
  sprites: { front: string; back: string; frontShiny: string; art: string | null }
  moves: string[]
  abilities: { name: string; hidden: boolean }[]
  /** -1 means genderless; otherwise eighths female (0 = always male). */
  genderRate: number
}

export type Move = {
  name: string
  type: PokeType
  category: 'physical' | 'special' | 'status'
  power: number | null
  accuracy: number | null
  pp: number
  priority: number
  target: string
  ailment: string | null
  ailmentChance: number
  critRate: number
  drain: number
  healing: number
  flinchChance: number
  statChance: number
  minHits: number | null
  maxHits: number | null
  statChanges: { stat: string; change: number }[]
}

const raw = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../data/pokedex.json', import.meta.url)), 'utf8'),
) as { pokemon: Species[]; moves: Move[] }

/**
 * Moves whose real behaviour this engine does not model. Allowing them would
 * make them silently stronger or weaker than a player expects — in a wagered
 * match that is a bug worth real money, so they are excluded from team building
 * entirely rather than approximated.
 */
const UNMODELLED = new Set([
  // Recharge turn after use
  'hyper-beam', 'giga-impact', 'blast-burn', 'hydro-cannon', 'frenzy-plant',
  'rock-wrecker', 'roar-of-time', 'prismatic-laser', 'eternabeam',
  // Charge / two-turn
  'solar-beam', 'solar-blade', 'fly', 'dig', 'dive', 'bounce', 'razor-wind',
  'skull-bash', 'sky-attack', 'shadow-force', 'phantom-force', 'freeze-shock',
  'ice-burn', 'geomancy', 'meteor-beam', 'electro-shot', 'sky-drop',
  // Locks the user in for several turns
  'thrash', 'petal-dance', 'outrage', 'rollout', 'ice-ball', 'uproar', 'raging-fury',
  // Forces a switch, which changes turn structure
  'whirlwind', 'roar', 'dragon-tail', 'circle-throw',
  // Scripted effects with no generic representation
  'counter', 'mirror-coat', 'metal-burst', 'bide', 'rest', 'substitute',
  'mimic', 'metronome', 'mirror-move', 'sketch', 'haze',
  'conversion', 'conversion-2', 'disable', 'encore', 'torment', 'taunt',
  'protect', 'detect', 'endure', 'wide-guard', 'quick-guard', 'spiky-shield',
  'kings-shield', 'baneful-bunker', 'obstruct', 'silk-trap', 'burning-bulwark',
  'leech-seed', 'nightmare', 'curse', 'perish-song', 'destiny-bond', 'grudge',
  'spite', 'trick', 'switcheroo', 'psych-up', 'heal-block', 'imprison',
  'magic-coat', 'snatch', 'follow-me', 'helping-hand', 'after-you', 'quash',
  'belly-drum', 'pain-split', 'endeavor', 'final-gambit', 'memento',
  'healing-wish', 'lunar-dance', 'baton-pass', 'u-turn', 'volt-switch',
  'flip-turn', 'parting-shot', 'teleport', 'splash', 'celebrate', 'hold-hands',
  'trick-room', 'wonder-room', 'magic-room', 'gravity', 'safeguard', 'mist',
  'lucky-chant', 'reflect', 'light-screen', 'aurora-veil', 'tailwind',
  'sticky-web', 'spikes', 'toxic-spikes', 'stealth-rock', 'rapid-spin',
  'defog', 'court-change', 'focus-punch', 'shell-trap', 'beak-blast',
  'future-sight', 'doom-desire', 'wish', 'dream-eater', 'sleep-talk', 'snore',
  'fake-out', 'first-impression', 'last-resort', 'stored-power', 'punishment',
  'fury-cutter', 'echoed-voice', 'triple-kick', 'triple-axel', 'present',
  'magnitude', 'return', 'frustration', 'hidden-power', 'weather-ball',
  'terrain-pulse', 'nature-power', 'judgment', 'techno-blast', 'multi-attack',
  'revelation-dance', 'aura-wheel', 'tera-blast', 'ivy-cudgel', 'raging-bull',
  'assist', 'copycat', 'me-first', 'sleep-talk', 'roost', 'synthesis',
  'morning-sun', 'moonlight', 'shore-up', 'strength-sap', 'flatter', 'swagger',
  'attract', 'captivate', 'yawn', 'gastro-acid', 'worry-seed', 'simple-beam',
  'entrainment', 'role-play', 'skill-swap', 'power-trick', 'power-split',
  'guard-split', 'speed-swap', 'heart-swap', 'topsy-turvy', 'aromatherapy',
  'heal-bell', 'refresh', 'purify', 'jungle-healing', 'life-dew', 'floral-healing',
  'heal-pulse',
  'electric-terrain', 'grassy-terrain', 'misty-terrain', 'psychic-terrain',
  'whirlpool', 'fire-spin', 'bind', 'wrap', 'clamp', 'sand-tomb', 'magma-storm',
  'infestation', 'snap-trap', 'thunder-cage', 'mean-look', 'block', 'spider-web',
  'ingrain', 'aqua-ring', 'focus-energy', 'charge', 'stockpile', 'spit-up',
  'swallow', 'rage', 'flail', 'reversal', 'grass-knot', 'low-kick', 'heat-crash',
  'heavy-slam', 'gyro-ball', 'electro-ball', 'eruption', 'water-spout',
  'crush-grip', 'wring-out', 'trump-card', 'natural-gift', 'fling', 'acrobatics',
  'facade', 'hex', 'venoshock', 'brine', 'retaliate', 'avalanche', 'payback',
  'assurance', 'round', 'smack-down', 'thousand-arrows', 'freeze-dry',
  'flying-press', 'relic-song', 'secret-power', 'psywave', 'sonic-boom',
  'dragon-rage', 'seismic-toss', 'night-shade', 'super-fang', 'nature-s-madness',
  'guillotine', 'horn-drill', 'fissure', 'sheer-cold',
])

const AILMENTS = new Set(['paralysis', 'burn', 'poison', 'freeze', 'sleep', 'confusion'])

/**
 * A move is playable only if the engine reproduces it faithfully:
 * damaging moves need a fixed power, status moves need an effect we implement.
 */
/** The weather setters, which the engine handles by name rather than by data. */
const WEATHER_MOVES = new Set(['sunny-day', 'rain-dance', 'sandstorm', 'hail', 'snowscape'])

/**
 * Handled by name in the engine rather than by its data.
 *
 * Everything in here has a real implementation in `performScripted` (or, for
 * Transform, its own branch). Adding a name here without writing that code
 * would put an inert move into team building, which is exactly what the
 * UNMODELLED list exists to prevent.
 */
export const SCRIPTED = new Set([
  'transform',
  'protect', 'detect', 'endure',
  'substitute', 'rest', 'curse', 'bide', 'mimic', 'sleep-talk',
])

/**
 * Fixes for moves whose real values depend on something this engine does not
 * model. Applied before the support check, so an override can rescue a move
 * that would otherwise be dropped for having no base power.
 */
const OVERRIDES: Record<string, Partial<Move>> = {
  // Friendship is not modelled. Both sit at the maximum the stat can give,
  // which is what every competitive simulator does.
  return: { power: 102 },
  frustration: { power: 102 },
  // Every Pokémon here runs flat 31 IVs, and that combination fixes Hidden
  // Power at Dark / 60 for all of them.
  'hidden-power': { power: 60, type: 'dark' },
  // PokeAPI reports the terrain forms and drops the 30% paralysis the plain
  // version has.
  'secret-power': { ailment: 'paralysis', ailmentChance: 30 },
}

function isSupported(m: Move): boolean {
  if (UNMODELLED.has(m.name)) return false
  if (WEATHER_MOVES.has(m.name) || SCRIPTED.has(m.name)) return true
  // In a 1v1 these spread targets all resolve to "the one opponent".
  // Without `all-other-pokemon`, staples like Surf and Earthquake vanish.
  const OK_TARGETS = new Set(['selected-pokemon', 'user', 'all-opponents', 'all-other-pokemon'])
  if (!OK_TARGETS.has(m.target)) return false
  if (m.category === 'status') {
    const doesSomething =
      m.statChanges.length > 0 || m.healing > 0 || (m.ailment !== null && AILMENTS.has(m.ailment))
    return doesSomething
  }
  // Damaging: needs a concrete base power, and any ailment must be one we model.
  if (m.power === null || m.power <= 0) return false
  if (m.ailment !== null && !AILMENTS.has(m.ailment)) return false
  return true
}

export const MOVES = new Map<string, Move>()
for (const m of raw.moves) if (isSupported(m)) MOVES.set(m.name, m)

export const SPECIES = new Map<number, Species>()
export const SPECIES_BY_NAME = new Map<string, Species>()

for (const s of raw.pokemon) {
  // Restrict each learnset to moves the engine actually supports, and each
  // ability list to the ones it implements.
  const legal = s.moves.filter((n) => MOVES.has(n))
  const abilities = (s.abilities ?? []).filter((a) => isSupportedAbility(a.name))
  const entry = { ...s, moves: legal, abilities }
  SPECIES.set(s.id, entry)
  SPECIES_BY_NAME.set(s.name, entry)
}

export const ALL_SPECIES = [...SPECIES.values()].sort((a, b) => a.id - b.id)
