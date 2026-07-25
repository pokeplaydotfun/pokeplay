/**
 * Preset teams for the practice opponent.
 *
 * Every preset is checked against `validateTeam` when this module loads, so an
 * illegal roster fails at boot rather than at the start of someone's match.
 * Movesets are topped up from the species' legal pool, which keeps the presets
 * valid even if the supported-move filter changes.
 */
import { SPECIES_BY_NAME, validateTeam, MAX_MOVES, type TeamSlot } from './active.js'

type Draft = { name: string; wants: string[]; nature: string; ability: string }

function slot(draft: Draft): TeamSlot {
  const sp = SPECIES_BY_NAME.get(draft.name)
  if (!sp) throw new Error(`preset references unknown species "${draft.name}"`)

  const moves = draft.wants.filter((m) => sp.moves.includes(m))
  // Top up from whatever this species can legally learn.
  for (const m of sp.moves) {
    if (moves.length >= MAX_MOVES) break
    if (!moves.includes(m)) moves.push(m)
  }
  if (moves.length === 0) throw new Error(`${draft.name} has no legal moves`)

  // Abilities are species-specific, so a typo here must fail loudly at boot
  // rather than quietly handing the bot a blank ability.
  if (!sp.abilities.some((a) => a.name === draft.ability)) {
    throw new Error(
      `${draft.name} cannot have "${draft.ability}" — legal: ${sp.abilities.map((a) => a.name).join(', ') || 'none'}`,
    )
  }

  return {
    speciesId: sp.id,
    moves: moves.slice(0, MAX_MOVES),
    nature: draft.nature,
    ability: draft.ability,
  }
}

const DRAFTS: { name: string; blurb: string; team: Draft[] }[] = [
  {
    name: 'Rival',
    blurb: 'A balanced starter-led team.',
    team: [
      { name: 'charizard', wants: ['flamethrower', 'air-slash', 'dragon-claw', 'earthquake'], nature: 'modest', ability: 'blaze' },
      { name: 'blastoise', wants: ['surf', 'ice-beam', 'body-slam', 'bite'], nature: 'modest', ability: 'torrent' },
      { name: 'venusaur', wants: ['giga-drain', 'sludge-bomb', 'sleep-powder', 'body-slam'], nature: 'modest', ability: 'overgrow' },
      { name: 'pidgeot', wants: ['air-slash', 'quick-attack', 'steel-wing', 'double-edge'], nature: 'jolly', ability: 'keen-eye' },
      { name: 'rhydon', wants: ['earthquake', 'rock-slide', 'megahorn', 'body-slam'], nature: 'adamant', ability: 'rock-head' },
      { name: 'gyarados', wants: ['waterfall', 'crunch', 'ice-fang', 'body-slam'], nature: 'adamant', ability: 'intimidate' },
    ],
  },
  {
    name: 'Gym Leader',
    blurb: 'Bulky and awkward to break.',
    team: [
      { name: 'snorlax', wants: ['body-slam', 'earthquake', 'crunch', 'ice-punch'], nature: 'adamant', ability: 'thick-fat' },
      { name: 'lapras', wants: ['surf', 'ice-beam', 'thunderbolt', 'body-slam'], nature: 'modest', ability: 'water-absorb' },
      { name: 'machamp', wants: ['cross-chop', 'earthquake', 'rock-slide', 'fire-punch'], nature: 'adamant', ability: 'no-guard' },
      { name: 'golem', wants: ['earthquake', 'rock-slide', 'fire-punch', 'body-slam'], nature: 'adamant', ability: 'sturdy' },
      { name: 'arcanine', wants: ['flamethrower', 'crunch', 'wild-charge', 'extreme-speed'], nature: 'adamant', ability: 'intimidate' },
      { name: 'vileplume', wants: ['giga-drain', 'sludge-bomb', 'sleep-powder', 'dazzling-gleam'], nature: 'modest', ability: 'effect-spore' },
    ],
  },
  {
    name: 'Elite',
    blurb: 'Fast and hits very hard.',
    team: [
      { name: 'alakazam', wants: ['psychic', 'shadow-ball', 'thunder-punch', 'calm-mind'], nature: 'timid', ability: 'magic-guard' },
      { name: 'gengar', wants: ['shadow-ball', 'sludge-bomb', 'thunderbolt', 'dazzling-gleam'], nature: 'timid', ability: 'cursed-body' },
      { name: 'jolteon', wants: ['thunderbolt', 'shadow-ball', 'quick-attack', 'double-kick'], nature: 'timid', ability: 'volt-absorb' },
      { name: 'dragonite', wants: ['dragon-claw', 'earthquake', 'fire-punch', 'thunder-punch'], nature: 'adamant', ability: 'multiscale' },
      { name: 'starmie', wants: ['surf', 'psychic', 'ice-beam', 'thunderbolt'], nature: 'timid', ability: 'natural-cure' },
      { name: 'mewtwo', wants: ['psychic', 'ice-beam', 'thunderbolt', 'aura-sphere'], nature: 'timid', ability: 'pressure' },
    ],
  },
]

export type Opponent = {
  id: string
  name: string
  blurb: string
  difficulty: 'easy' | 'normal'
  team: TeamSlot[]
}

/**
 * Filled by `buildOpponents()` once the dex has loaded.
 *
 * The learnsets these presets are checked against arrive asynchronously, so
 * this cannot be built at import time — it would validate against an empty
 * dex and reject every roster.
 */
export const OPPONENTS: Opponent[] = []

/**
 * Build and check the presets. Call once, after the dex is ready.
 *
 * Throws rather than serving a broken opponent: an illegal roster would fail
 * at the start of someone's match instead of at boot, which is far worse.
 */
export function buildOpponents(): Opponent[] {
  OPPONENTS.length = 0
  DRAFTS.forEach((d, i) => {
    OPPONENTS.push({
      id: d.name.toLowerCase().replace(/\s+/g, '-'),
      name: d.name,
      blurb: d.blurb,
      // The first preset is the gentle one.
      difficulty: i === 0 ? 'easy' : 'normal',
      team: d.team.map(slot),
    })
  })

  for (const o of OPPONENTS) {
    const errs = validateTeam(o.team)
    if (errs.length) {
      throw new Error(`practice opponent "${o.name}" is illegal: ${errs.join('; ')}`)
    }
    // Players choose a nature and an ability for all six, so the bot must too —
    // a preset that quietly leaves them blank is fighting with a handicap.
    o.team.forEach((t, i) => {
      if (!t.nature) throw new Error(`practice opponent "${o.name}" slot ${i + 1} has no nature`)
      if (!t.ability) throw new Error(`practice opponent "${o.name}" slot ${i + 1} has no ability`)
    })
  }
  return OPPONENTS
}

export const getOpponent = (id: string) => OPPONENTS.find((o) => o.id === id)
