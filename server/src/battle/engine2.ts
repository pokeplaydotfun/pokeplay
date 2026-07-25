/**
 * Battle engine v2 — a thin adapter over @pkmn/sim (Pokémon Showdown's engine).
 *
 * Why this exists: v1 (`engine.ts`) is a hand-written engine that could only
 * model a subset of moves, so ~191 moves the first 151 can legally learn were
 * excluded from team building entirely. Showdown's engine implements all of
 * them correctly and is validated by millions of real games.
 *
 * This module deliberately presents the SAME shape as v1 — createBattle,
 * resolveTurn, replaceFainted, validateAction, publicState — so rooms, replays
 * and the queue barely change.
 *
 * v1 is kept, frozen, for re-deriving battles that were played on it. Never
 * change v1's behaviour: every historical replay is verified by re-running it.
 *
 * Determinism: the sim is driven by a seed derived from the match's revealed
 * commit/reveal seed, so a replay reproduces a match exactly, which is what
 * makes the wager provably fair.
 */
import { createHash } from 'node:crypto'
import { Battle as SimBattle, Dex } from '@pkmn/sim'
import type { Action, BattleEvent, BoostKey, Status, TeamSlot, Weather } from './engine.js'

export type { Action, BattleEvent, TeamSlot }

/** Gen 9 mechanics (modern damage, abilities, natures), first 151 only. */
const GEN = 9
export const dex = Dex.forGen(GEN)

/** Level, IVs and EVs are fixed for every Pokémon, exactly as in v1. */
export const LEVEL = 100
const IVS = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }
const EVS = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }

/* ------------------------------------------------------------------ */
/* names                                                               */
/* ------------------------------------------------------------------ */

/**
 * Our canonical move/ability keys are hyphenated ('body-slam'); the sim uses
 * bare ids ('bodyslam'). Stripping hyphens is the whole conversion, and it is
 * one-way, so the reverse map is built once from the dex.
 */
export const toSimId = (key: string) => key.replace(/[^a-z0-9]/gi, '').toLowerCase()

/* ------------------------------------------------------------------ */
/* seeding                                                             */
/* ------------------------------------------------------------------ */

/**
 * Turn the match's hex seed into a sim PRNG seed.
 *
 * Hashing first means any seed length works and the mapping is uniform, and
 * because it is a pure function of the revealed seed anyone can recompute it
 * and check the match for themselves.
 */
export function simSeed(seedHex: string): [number, number, number, number] {
  const h = createHash('sha256').update(seedHex).digest()
  return [h.readUInt16BE(0), h.readUInt16BE(2), h.readUInt16BE(4), h.readUInt16BE(6)]
}

/* ------------------------------------------------------------------ */
/* teams                                                               */
/* ------------------------------------------------------------------ */

/** Species name for one of the first 151, by dex number. */
const SPECIES_BY_NUM = new Map<number, string>()
for (const s of dex.species.all()) {
  if (s.num >= 1 && s.num <= 151 && !s.forme && !SPECIES_BY_NUM.has(s.num)) {
    SPECIES_BY_NUM.set(s.num, s.name)
  }
}

export const speciesName = (num: number) => SPECIES_BY_NUM.get(num) ?? null

/** Convert one of our team slots into the set shape the sim expects. */
function toSet(slot: TeamSlot) {
  const name = speciesName(slot.speciesId)
  if (!name) throw new Error(`unknown species ${slot.speciesId}`)
  const species = dex.species.get(name)
  const legal = Object.values(species.abilities).map((a) => toSimId(String(a)))
  // 'none' means the player deliberately chose no ability.
  //
  // An illegal ability is rejected here as well as in validateTeam: the sim's
  // custom-game format does no legality checking of its own, so without this a
  // crafted request could hand Magikarp Huge Power. v1 threw here too.
  let ability: string
  if (slot.ability && slot.ability !== 'none') {
    const want = toSimId(slot.ability)
    if (!legal.includes(want)) {
      throw new Error(`${species.name} cannot have ${slot.ability}`)
    }
    ability = dex.abilities.get(want).name
  } else {
    // The sim requires *an* ability; the first legal one is the neutral default.
    ability = dex.abilities.get(toSimId(String(species.abilities[0] ?? 'noability'))).name
  }
  return {
    name: species.name,
    species: species.name,
    level: LEVEL,
    gender: '' as const,
    item: '',
    ability,
    nature: slot.nature ? titleCase(slot.nature) : 'Serious',
    moves: slot.moves.map(toSimId),
    ivs: { ...IVS },
    evs: { ...EVS },
    happiness: 255,
  }
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()

/* ------------------------------------------------------------------ */
/* battle state                                                        */
/* ------------------------------------------------------------------ */

/**
 * One Pokémon, projected out of the sim into the shape our clients read.
 *
 * `boosts`, `ability` and `gender` are part of the contract v1 established and
 * the battle screen is written against — it does `Object.entries(mon.boosts)`
 * unguarded, so omitting it throws rather than degrading.
 */
export type PublicMon = {
  speciesId: number
  name: string
  types: string[]
  level: number
  hp: number
  maxHp: number
  status: Status
  fainted: boolean
  boosts: Record<string, number>
  ability: string | null
  gender: string
}

/**
 * Your own Pokémon, which additionally carries its moves and their PP — the
 * foe's never does, or a player could read their opponent's PP. This is the
 * shape the battle screen's move buttons are built from.
 */
export type OwnMon = PublicMon & {
  moves: {
    name: string
    pp: number
    maxPp: number
    /**
     * Type effectiveness of this move against the opponent currently on the
     * field: 0 (no effect), 0.25, 0.5, 1, 2 or 4. `null` for status moves,
     * which deal no damage. Lets the battle screen show a "2×" / "½×" tag.
     */
    eff: number | null
  }[]
}

export type Side2 = { player: 0 | 1; team: PublicMon[]; active: number }

export type Battle2 = {
  /** The underlying Showdown battle. */
  sim: SimBattle
  /** Stable team order; the sim reorders its own array as Pokémon switch. */
  roster: [unknown[], unknown[]]
  /**
   * The teams as the players saved them, in roster order. Kept because the sim
   * only knows its own normalised move ids, and the client's dex is keyed by the
   * original names.
   */
  teamSlots: [TeamSlot[], TeamSlot[]]
  seed: string
  turn: number
  finished: boolean
  winner: 0 | 1 | null
  pendingReplace: [boolean, boolean]
  sides: [Side2, Side2]
  opening: BattleEvent[]
  /** How much of `sim.log` has already been translated into events. */
  logRead: number
  /**
   * The raw protocol lines consumed by the most recent drain. Kept so the
   * narration can be re-rendered per viewer ("the opposing X") without
   * re-reading the sim log.
   */
  lastRaw: string[]
  /** Marks this battle as engine v2 for replay dispatch. */
  engine: 2
}

/* ------------------------------------------------------------------ */
/* log translation                                                     */
/* ------------------------------------------------------------------ */

const SIDE_OF = (ident: string): 0 | 1 => (ident.startsWith('p2') ? 1 : 0)

/** `p1a: Snorlax` → `Snorlax`. */
const nameOf = (ident: string) => ident.slice(ident.indexOf(':') + 1).trim()

/** `196/261` or `0 fnt` → [hp, maxHp | null]. */
function parseHp(field: string): [number, number | null] {
  if (!field) return [0, null]
  const [left] = field.split(' ')
  const [cur, max] = left.split('/')
  const hp = Number(cur)
  const mx = max === undefined ? null : Number(max)
  return [Number.isFinite(hp) ? hp : 0, mx !== null && Number.isFinite(mx) ? mx : null]
}

const STATUS_MAP: Record<string, Status> = {
  brn: 'brn', par: 'par', psn: 'psn', tox: 'tox', slp: 'slp', frz: 'frz',
}

/** The sim names weather by the move that set it; v1 names the condition. */
const WEATHER_MAP: Record<string, Weather | null> = {
  none: null,
  raindance: 'rain', primordialsea: 'rain',
  sunnyday: 'sun', desolateland: 'sun',
  sandstorm: 'sand',
  hail: 'hail', snow: 'hail', snowscape: 'hail',
}

/* ------------------------------------------------------------------ */
/* narration vocabulary                                                */
/* ------------------------------------------------------------------ */

/**
 * Display names for the stats a boost/unboost line names. The sim writes
 * `accuracy`/`evasion`; the projected boosts (and v1) use `acc`/`eva`, so both
 * are keyed to the same word.
 */
const STAT_LABEL: Record<string, string> = {
  atk: 'Attack', def: 'Defence', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed',
  accuracy: 'accuracy', acc: 'accuracy', evasion: 'evasiveness', eva: 'evasiveness',
}

/** What a Pokémon "did" when a status lands, phrased as in the main game. */
const STATUS_WORD: Record<string, string> = {
  brn: 'was burned', par: 'was paralysed', psn: 'was poisoned',
  tox: 'was badly poisoned', slp: 'fell asleep', frz: 'was frozen solid',
}

/** …and when it is cleared. */
const CURE_WORD: Record<string, string> = {
  brn: 'was cured of its burn', par: 'shook off the paralysis',
  psn: 'was cured of its poison', tox: 'was cured of its poison',
  slp: 'woke up', frz: 'thawed out',
}

/** Why a Pokémon could not act on its turn. */
const CANT_WORD: Record<string, string> = {
  slp: 'is fast asleep', frz: 'is frozen solid',
  par: "is paralysed! It can't move", flinch: 'flinched and could not move',
  recharge: 'must recharge',
}

/** The line announcing each weather. */
const WEATHER_ONSET: Record<string, string> = {
  rain: 'It started to rain!', sun: 'The sunlight turned harsh!',
  sand: 'A sandstorm kicked up!', hail: 'It started to hail!',
}

/** How much a stat moved, in words: 1 nothing, 2 "sharply", 3+ "drastically". */
const riseWord = (n: number) => (n >= 3 ? ' drastically' : n === 2 ? ' sharply' : '')
const fallWord = (n: number) => (n >= 3 ? ' severely' : n === 2 ? ' harshly' : '')

/**
 * Pull the `[from]`/`[of]` annotations off a protocol line. The sim appends
 * these to say what caused an effect (`[from] ability: Drought`) and who it
 * came from (`[of] p2a: Ninetales`).
 */
function fromOf(parts: string[]): { from: string; of: string } {
  let from = ''
  let of = ''
  for (const p of parts) {
    if (p.startsWith('[from]')) from = p.slice(6).trim()
    else if (p.startsWith('[of]')) of = p.slice(4).trim()
  }
  return { from, of }
}

/** `ability: Drought` → `{ kind: 'ability', name: 'Drought' }`. */
function effectName(from: string): { kind: string; name: string } {
  const idx = from.indexOf(':')
  if (idx < 0) return { kind: '', name: from }
  return { kind: from.slice(0, idx).trim(), name: from.slice(idx + 1).trim() }
}

/**
 * Turn Showdown protocol lines into our BattleEvent stream.
 *
 * `|split|pN` marks a pair of lines: the first is what player N sees (exact
 * HP), the second is the redacted version for everyone else. v1 showed exact
 * HP for both sides, so we keep the detailed line and drop the redacted one
 * rather than silently changing what players can see.
 *
 * `viewer` disambiguates the narration for that seat: the opponent's Pokémon
 * reads "the opposing Venusaur", the way it does in the real games. Without it
 * (e.g. a replay, which labels both players anyway) every mon is named plainly,
 * which reads wrong only in a same-species mirror.
 */
export function translate(b: Battle2, lines: string[], viewer?: 0 | 1): BattleEvent[] {
  const ev: BattleEvent[] = []
  const slotOf = (ident: string) => {
    const side = SIDE_OF(ident)
    const nm = nameOf(ident)
    const idx = b.sides[side].team.findIndex((m) => m.name === nm)
    return idx >= 0 ? idx : b.sides[side].active
  }
  // The opponent's Pokémon is "the opposing X" / "The opposing X" so you can
  // always tell whose is whose — most importantly in a mirror match.
  const label = (ident: string, start = false) => {
    const nm = nameOf(ident)
    if (viewer === undefined || SIDE_OF(ident) === viewer) return nm
    return `${start ? 'The' : 'the'} opposing ${nm}`
  }
  // Push a narration line, tagged with the side it is about when it names a
  // Pokémon (`p1a: …`/`p2a: …`), so the log can label it "You" vs the opponent.
  // Neutral lines (weather, "super effective", turn dividers) pass no ident.
  const say = (msg: string, ident?: string) => {
    const side = ident && /^p[12]/.test(ident) ? SIDE_OF(ident) : undefined
    ev.push(side === undefined ? { t: 'text', msg } : { t: 'text', msg, side })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('|')) continue
    const parts = line.slice(1).split('|')
    const tag = parts[0]

    // Keep the detailed half of a split pair, skip its redacted twin.
    if (tag === 'split') {
      const detailed = lines[i + 1]
      if (detailed !== undefined) {
        ev.push(...translate(b, [detailed], viewer))
        i += 2
      }
      continue
    }

    switch (tag) {
      case 'turn':
        say(`— Turn ${parts[1]} —`)
        break
      case 'move':
        say(`${label(parts[1], true)} used ${parts[2]}!`, parts[1])
        break
      case 'switch':
      case 'drag': {
        const side = SIDE_OF(parts[1])
        const slot = slotOf(parts[1])
        ev.push({ t: 'switch', side, slot })
        // Your own switch reads "Go! X!"; the opponent's, "The opposing X…".
        say(
          viewer !== undefined && side !== viewer
            ? `${label(parts[1], true)} was sent out!`
            : `Go! ${nameOf(parts[1])}!`,
          parts[1],
        )
        break
      }
      case 'faint': {
        const side = SIDE_OF(parts[1])
        ev.push({ t: 'faint', side, slot: slotOf(parts[1]) })
        say(`${label(parts[1], true)} fainted!`, parts[1])
        break
      }
      case '-damage':
      case '-heal': {
        const side = SIDE_OF(parts[1])
        const slot = slotOf(parts[1])
        const [hp, mx] = parseHp(parts[2])
        const maxHp = mx ?? b.sides[side].team[slot]?.maxHp ?? 0
        ev.push({ t: tag === '-damage' ? 'damage' : 'heal', side, slot, hp, maxHp })
        // Explain HP that moved for a reason other than a plain hit — a burn
        // tick, poison, Leech Seed, weather chip, or an ability draining/healing.
        // `[silent]` marks changes the games never narrate (Rest's own heal,
        // Leech Seed's drain back to the seeder).
        if (!parts.includes('[silent]')) {
          const { from } = fromOf(parts)
          const eff = effectName(from)
          if (tag === '-damage') {
            const msg =
              from === 'brn' ? `${label(parts[1], true)} was hurt by its burn!`
              : from === 'psn' || from === 'tox' ? `${label(parts[1], true)} was hurt by poison!`
              : from === 'confusion' ? 'It hurt itself in its confusion!'
              : eff.name === 'Leech Seed' ? `${label(parts[1], true)}'s health was sapped by Leech Seed!`
              : /^sandstorm$/i.test(from) ? `${label(parts[1], true)} is buffeted by the sandstorm!`
              : /^hail$/i.test(from) ? `${label(parts[1], true)} is pelted by hail!`
              : eff.kind === 'ability' ? `${label(parts[1], true)} was hurt by its ${eff.name}!`
              : null
            if (msg) say(msg, parts[1])
          } else if (eff.kind === 'ability') {
            say(`${label(parts[1], true)}'s ${eff.name} restored its health!`, parts[1])
          }
        }
        break
      }
      case '-status': {
        const side = SIDE_OF(parts[1])
        ev.push({ t: 'status', side, slot: slotOf(parts[1]), status: STATUS_MAP[parts[2]] ?? null })
        const word = STATUS_WORD[parts[2]]
        if (word) say(`${label(parts[1], true)} ${word}!`, parts[1])
        break
      }
      case '-curestatus': {
        const side = SIDE_OF(parts[1])
        ev.push({ t: 'status', side, slot: slotOf(parts[1]), status: null })
        // A silent cure (switching out, say) is not narrated; `[msg]` marks the
        // ones the games do show, like waking up mid-battle.
        if (!parts.includes('[silent]')) {
          const word = CURE_WORD[parts[2]]
          if (word) say(`${label(parts[1], true)} ${word}!`, parts[1])
        }
        break
      }
      case '-cureteam': {
        const side = SIDE_OF(parts[1])
        ev.push({ t: 'status', side, slot: slotOf(parts[1]), status: null })
        break
      }
      case '-boost':
      case '-unboost': {
        const side = SIDE_OF(parts[1])
        const stat = parts[2] as BoostKey
        // The sim reports accuracy/evasion as accuracy/evasion; v1 calls them
        // acc/eva, and the client reads v1's names.
        const key: BoostKey =
          stat === ('accuracy' as BoostKey) ? 'acc'
          : stat === ('evasion' as BoostKey) ? 'eva'
          : stat
        const n = Number(parts[3])
        ev.push({
          t: 'boost', side, slot: slotOf(parts[1]),
          stat: key,
          by: n * (tag === '-unboost' ? -1 : 1),
        })
        const name = STAT_LABEL[stat] ?? STAT_LABEL[key] ?? String(stat)
        say(
          tag === '-boost'
            ? `${label(parts[1], true)}'s ${name} rose${riseWord(n)}!`
            : `${label(parts[1], true)}'s ${name} fell${fallWord(n)}!`,
          parts[1],
        )
        break
      }
      case '-setboost': {
        // Belly Drum and friends slam a stat to a fixed stage. No boost event is
        // emitted (the delta isn't in the line); the authoritative post-turn
        // state carries the final stage, so only the narration is needed here.
        const { from } = fromOf(parts)
        const eff = effectName(from)
        const name = STAT_LABEL[parts[2]] ?? String(parts[2])
        say(
          eff.name === 'Belly Drum'
            ? `${label(parts[1], true)} cut its own HP and maximised its Attack!`
            : `${label(parts[1], true)}'s ${name} was maximised!`,
          parts[1],
        )
        break
      }
      case '-weather': {
        // `|-weather|none` clears; `[upkeep]` is a per-turn tick, not a change.
        if (parts.includes('[upkeep]')) break
        const kind = WEATHER_MAP[toSimId(parts[1])] ?? null
        ev.push({ t: 'weather', kind })
        const { from, of } = fromOf(parts)
        const eff = effectName(from)
        if (kind) {
          // Weather an ability summoned (Drought, Sand Stream) is credited to it.
          if (eff.kind === 'ability' && of) {
            say(`${label(of, true)}'s ${eff.name}!`, of)
          }
          if (WEATHER_ONSET[kind]) say(WEATHER_ONSET[kind])
        } else {
          say('The weather cleared up.')
        }
        break
      }
      case 'win': {
        const winner = b.sim.sides[0].name === parts[1] ? 0 : 1
        ev.push({ t: 'end', winner: winner as 0 | 1 })
        break
      }
      case 'tie':
        ev.push({ t: 'end', winner: null })
        break
      // Everything else that carries player-visible meaning becomes text.
      case '-fail': {
        const { from } = fromOf(parts)
        const eff = effectName(from)
        // A drop refused by Clear Body / Hyper Cutter etc. reads as the ability
        // holding the line, not as an unexplained "it failed".
        say(
          eff.kind === 'ability'
            ? `${label(parts[1] ?? '', true)}'s ${eff.name} prevented it!`
            : `${label(parts[1] ?? '', true)} — but it failed!`,
          parts[1],
        )
        break
      }
      case '-immune': {
        const { from } = fromOf(parts)
        const eff = effectName(from)
        say(
          eff.kind === 'ability'
            ? `${label(parts[1] ?? '', true)}'s ${eff.name} made it immune!`
            : `It doesn't affect ${label(parts[1] ?? '')}…`,
          parts[1],
        )
        break
      }
      // An ability announcing itself: Intimidate, Sturdy, Speed Boost, Trace…
      case '-ability': {
        const abil = parts[2] ?? ''
        const { from, of } = fromOf(parts)
        const eff = effectName(from)
        say(
          eff.name === 'Trace' && of
            ? `${label(parts[1], true)} traced ${label(of)}'s ${abil}!`
            : `${label(parts[1], true)}'s ${abil}!`,
          parts[1],
        )
        break
      }
      // A lasting effect beginning on a Pokémon: Flash Fire, confusion, a seed…
      case '-start': {
        const raw = parts[2] ?? ''
        const eff = effectName(raw)
        const msg =
          eff.kind === 'ability' && eff.name === 'Flash Fire'
            ? `${label(parts[1], true)}'s Flash Fire powered up its Fire moves!`
          : eff.kind === 'ability' ? `${label(parts[1], true)}'s ${eff.name} kicked in!`
          : raw === 'confusion' ? `${label(parts[1], true)} became confused!`
          : raw === 'Substitute' ? `${label(parts[1], true)} put up a substitute!`
          : eff.name === 'Leech Seed' ? `${label(parts[1], true)} was seeded!`
          : null
        if (msg) say(msg, parts[1])
        break
      }
      // …and ending.
      case '-end': {
        const raw = parts[2] ?? ''
        const msg =
          raw === 'confusion' ? `${label(parts[1], true)} snapped out of its confusion!`
          : raw === 'Substitute' ? `${label(parts[1], true)}'s substitute faded!`
          : null
        if (msg) say(msg, parts[1])
        break
      }
      // A one-off trigger: a confused hit, a Protect blocking, an ability firing.
      case '-activate': {
        const raw = parts[2] ?? ''
        const eff = effectName(raw)
        const msg =
          raw === 'confusion' ? `${label(parts[1], true)} is confused!`
          : eff.name === 'Protect' ? `${label(parts[1], true)} protected itself!`
          : eff.name === 'Substitute' ? `${label(parts[1], true)}'s substitute blocked the attack!`
          : eff.kind === 'ability' ? `${label(parts[1], true)}'s ${eff.name} activated!`
          : null
        if (msg) say(msg, parts[1])
        break
      }
      // A Pokémon that could not move — paralysis, sleep, freeze, flinch, an
      // ability like Truant, or needing to recharge.
      case 'cant': {
        const reason = parts[2] ?? ''
        const eff = effectName(reason)
        say(
          eff.kind === 'ability'
            ? `${label(parts[1], true)} could not move because of its ${eff.name}!`
            : `${label(parts[1], true)} ${CANT_WORD[reason] ?? 'could not move'}!`,
          parts[1],
        )
        break
      }
      case '-supereffective':
        say("It's super effective!")
        break
      case '-resisted':
        say("It's not very effective…")
        break
      case '-crit':
        say('A critical hit!')
        break
      case '-miss':
        say(`${label(parts[1] ?? '', true)}'s attack missed!`, parts[1])
        break
      default:
        break
    }
  }
  return ev
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

/** Any Pokémon object out of the sim, narrowed to what we read off it. */
type SimMon = {
  name: string
  hp: number
  maxhp: number
  fainted: boolean
  status: string
  species: { num: number; types: string[] }
  isActive: boolean
  /** In the order the set listed them, so PP can be matched back by id. */
  moveSlots: { id: string; pp: number; maxpp: number }[]
  boosts: Record<string, number>
  ability: string
  gender: string
}

/** The sim spells these two out; v1 and the client use the short forms. */
const BOOST_KEY: Record<string, string> = { accuracy: 'acc', evasion: 'eva' }

/** 'Thick Fat' -> 'thick-fat', the key the client's dex uses. */
const hyphenate = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const project = (p: SimMon): PublicMon => ({
  speciesId: p.species.num,
  name: p.name,
  types: [...p.species.types],
  level: LEVEL,
  hp: p.hp,
  maxHp: p.maxhp,
  status: (STATUS_MAP[p.status] ?? null) as Status,
  fainted: p.fainted,
  boosts: Object.fromEntries(
    Object.entries(p.boosts ?? {}).map(([k, v]) => [BOOST_KEY[k] ?? k, v]),
  ),
  // Hyphenated to match the dex the client fetched: the sim's id is
  // 'thickfat', the client looks up 'thick-fat'.
  ability: p.ability ? hyphenate(dex.abilities.get(p.ability)?.name ?? p.ability) : null,
  // v1 used 'N' for the genderless; the sim uses ''.
  gender: p.gender || 'N',
})

/**
 * Refresh the projected view from the sim.
 *
 * `roster` holds our stable team order — the sim shuffles its own array so the
 * active Pokémon sits at index 0, which would otherwise scramble the indices
 * the client sends back.
 */
function sync(b: Battle2) {
  for (const side of [0, 1] as const) {
    const roster = b.roster[side] as SimMon[]
    b.sides[side].team = roster.map(project)
    const activeIdx = roster.findIndex((p) => p.isActive)
    b.sides[side].active = activeIdx >= 0 ? activeIdx : b.sides[side].active
  }
  b.turn = b.sim.turn
  b.finished = b.sim.ended
  const w = b.sim.winner
  b.winner = w === undefined || w === '' ? null : w === b.sim.sides[0].name ? 0 : 1
  // The sim asks for a replacement by raising forceSwitch on that side. This
  // also fires mid-turn for pivot moves (U-turn, Volt Switch), not just faints.
  for (const side of [0, 1] as const) {
    const req = (b.sim.sides[side] as { activeRequest?: { forceSwitch?: boolean[] } }).activeRequest
    b.pendingReplace[side] = Boolean(req?.forceSwitch?.[0]) && !b.finished
  }
}

/** Translate whatever the sim has logged since we last looked. */
function drain(b: Battle2): BattleEvent[] {
  const fresh = b.sim.log.slice(b.logRead)
  b.logRead = b.sim.log.length
  b.lastRaw = fresh
  sync(b)
  // Plain (viewer-agnostic) events for the caller — replay uses these. The live
  // room re-renders per viewer from `lastRaw` via `viewerEvents`.
  return translate(b, fresh)
}

/** The last drained lines rendered from one player's seat. */
export function viewerEvents(b: Battle2, viewer: 0 | 1, lines?: string[]): BattleEvent[] {
  return translate(b, lines ?? b.lastRaw, viewer)
}

export function createBattle(teams: [TeamSlot[], TeamSlot[]], seed: string): Battle2 {
  const sim = new SimBattle({
    formatid: 'gen9customgame' as never,
    seed: simSeed(seed) as never,
    strictChoices: false,
    p1: { name: 'p1', team: teams[0].map(toSet) as never },
    p2: { name: 'p2', team: teams[1].map(toSet) as never },
  })

  const b: Battle2 = {
    sim,
    roster: [[], []],
    teamSlots: [teams[0], teams[1]],
    seed,
    turn: 0,
    finished: false,
    winner: null,
    pendingReplace: [false, false],
    sides: [
      { player: 0, team: [], active: 0 },
      { player: 1, team: [], active: 0 },
    ],
    opening: [],
    logRead: 0,
    lastRaw: [],
    engine: 2,
  }

  // This game has no team preview — you bring six and lead with the first —
  // so answer it in fixed order and let the match start.
  const order = (t: TeamSlot[]) => `team ${t.map((_, i) => i + 1).join(',')}`
  sim.makeChoices(order(teams[0]), order(teams[1]))

  // Capture the stable order once, before anything switches.
  b.roster = [
    [...(sim.sides[0].pokemon as unknown as SimMon[])],
    [...(sim.sides[1].pokemon as unknown as SimMon[])],
  ]
  b.opening = drain(b)
  return b
}

/** Our action → the sim's choice string, using the stable roster order. */
function choiceFor(b: Battle2, side: 0 | 1, action: Action): string {
  if (action.kind === 'switch') {
    const target = (b.roster[side] as SimMon[])[action.index]
    // `switch N` counts positions in the sim's *current* array, not ours.
    const pos = (b.sim.sides[side].pokemon as unknown as SimMon[]).indexOf(target)
    return `switch ${pos + 1}`
  }
  return `move ${action.index + 1}`
}

/**
 * What the sim is waiting on from this side right now.
 *
 * After a faint only the fainted side gets a request and the other is put in
 * `wait` — answering for a waiting side is rejected as "not all choices done",
 * so every choice has to be routed by what the sim actually asked for.
 */
function pending(b: Battle2, side: 0 | 1): 'move' | 'switch' | null {
  const req = (b.sim.sides[side] as {
    activeRequest?: { wait?: boolean; forceSwitch?: boolean[]; teamPreview?: boolean }
  }).activeRequest
  if (!req || req.wait) return null
  if (req.forceSwitch?.[0]) return 'switch'
  return 'move'
}

export function resolveTurn(b: Battle2, actions: [Action, Action]): BattleEvent[] {
  if (b.finished) return []
  for (const side of [0, 1] as const) {
    if (pending(b, side) === 'move') {
      b.sim.choose(side === 0 ? 'p1' : 'p2', choiceFor(b, side, actions[side]))
    }
  }
  return drain(b)
}

/**
 * Handles a forced replacement (does not consume a turn).
 *
 * Also covers pivot moves like U-turn, where the active Pokémon must leave but
 * has not fainted. An index pointing at the active or a fainted Pokémon would
 * be rejected by the sim and leave the battle waiting forever, so it is
 * corrected to the first legal choice rather than trusted.
 */
export function replaceFainted(b: Battle2, side: 0 | 1, index: number): BattleEvent[] {
  if (pending(b, side) !== 'switch') return []
  const roster = b.roster[side] as SimMon[]
  const legal = (i: number) => roster[i] && !roster[i].fainted && !roster[i].isActive
  const target = legal(index) ? index : roster.findIndex((_, i) => legal(i))
  if (target < 0) return []
  b.sim.choose(side === 0 ? 'p1' : 'p2', choiceFor(b, side, { kind: 'switch', index: target }))
  return drain(b)
}

export function isTeamWiped(side: Side2): boolean {
  return side.team.every((m) => m.fainted)
}

/**
 * The first action the sim will actually accept from this side.
 *
 * Used when a player runs out of clock — a wagered match must never stall
 * because someone stopped choosing. Asking the sim rather than scanning move
 * PP means this respects everything that restricts a choice: recharging after
 * Hyper Beam, being locked into Outrage, a disabled move, or owing a switch.
 */
export function firstLegalAction(b: Battle2, side: 0 | 1): Action {
  const roster = b.roster[side] as SimMon[]
  if (pending(b, side) === 'switch') {
    const i = roster.findIndex((m) => !m.fainted && !m.isActive)
    return { kind: 'switch', index: i >= 0 ? i : 0 }
  }
  const req = (b.sim.sides[side] as {
    activeRequest?: { active?: { moves?: { disabled?: boolean; pp?: number }[] }[] }
  }).activeRequest
  const moves = req?.active?.[0]?.moves
  if (moves) {
    const i = moves.findIndex((m) => !m.disabled && (m.pp === undefined || m.pp > 0))
    // Nothing available means the sim falls back to Struggle on its own.
    if (i >= 0) return { kind: 'move', index: i }
  }
  return { kind: 'move', index: 0 }
}

/** Rejects an action before it reaches the sim, with a message for the player. */
export function validateAction(b: Battle2, side: 0 | 1, action: Action): string | null {
  const s = b.sides[side]
  if (b.finished) return 'the battle is over'
  if (action.kind === 'switch') {
    const t = s.team[action.index]
    if (!t) return 'no such Pokémon'
    if (t.fainted) return 'that Pokémon has fainted'
    if (action.index === s.active) return 'that Pokémon is already out'
    return null
  }
  if (b.pendingReplace[side]) return 'you must send out a replacement first'
  const req = (b.sim.sides[side] as {
    activeRequest?: { active?: { moves?: { disabled?: boolean }[] }[] }
  }).activeRequest
  const moves = req?.active?.[0]?.moves
  if (moves && !moves[action.index]) return 'no such move'
  if (moves && moves[action.index]?.disabled) return 'that move cannot be used right now'
  return null
}

/**
 * Your own team, with the moves and PP the battle screen needs.
 *
 * The names are the ones the player's saved team uses (`hyper-beam`), NOT the
 * sim's normalised id (`hyperbeam`): the client looks each one up in the dex it
 * fetched from /api/pokedex, which is keyed the first way. PP is matched back by
 * id rather than by position, so a set the sim reorders still lines up.
 */
/**
 * Abilities that grant a flat immunity to one whole type. The foe's ability is
 * visible to the player (publicState sends it), so it is honest to factor it
 * into the multiplier — a Ground move reads "0×" into a Levitate Pokémon, not a
 * misleading "1×".
 */
const TYPE_IMMUNITY_ABILITY: Record<string, string> = {
  levitate: 'Ground',
  flashfire: 'Fire',
  voltabsorb: 'Electric',
  lightningrod: 'Electric',
  motordrive: 'Electric',
  waterabsorb: 'Water',
  dryskin: 'Water',
  stormdrain: 'Water',
  sapsipper: 'Grass',
}

/**
 * Type effectiveness of a move against one Pokémon: 0, 0.25, 0.5, 1, 2 or 4.
 *
 * `damageTaken` hangs off the DEFENDING type and is keyed by the attacking type
 * (1 = weak/2×, 2 = resist/½×, 3 = immune). Status moves and moves with no type
 * damage return null. Ability immunities are applied on top of the type chart.
 */
function moveEffectiveness(moveKey: string, foe: SimMon | null): number | null {
  if (!foe) return null
  const m = dex.moves.get(toSimId(moveKey))
  if (!m || !m.exists || m.category === 'Status' || !m.basePower) return null

  const ability = foe.ability ? toSimId(foe.ability) : ''
  if (TYPE_IMMUNITY_ABILITY[ability] === m.type) return 0

  let mult = 1
  for (const t of foe.species.types) {
    const eff = dex.types.get(t)?.damageTaken?.[m.type]
    mult *= eff === 1 ? 2 : eff === 2 ? 0.5 : eff === 3 ? 0 : 1
  }
  return mult
}

function activeFoe(b: Battle2, side: 0 | 1): SimMon | null {
  const roster = b.roster[(1 - side) as 0 | 1] as SimMon[]
  return roster.find((m) => m.isActive) ?? null
}

function ownTeam(b: Battle2, side: 0 | 1): OwnMon[] {
  const roster = b.roster[side] as SimMon[]
  const slots = b.teamSlots[side]
  const foe = activeFoe(b, side)
  return b.sides[side].team.map((mon, i) => {
    const sim = roster[i]
    return {
      ...mon,
      moves: (slots[i]?.moves ?? []).map((name) => {
        const slot = sim?.moveSlots?.find((m) => m.id === toSimId(name))
        return {
          name,
          pp: slot?.pp ?? 0,
          maxPp: slot?.maxpp ?? 0,
          eff: moveEffectiveness(name, foe),
        }
      }),
    }
  })
}

/**
 * What one player is allowed to see of the battle.
 *
 * `weather`, `mustReplace` and your own `moves` are part of the contract the
 * battle screen is written against — v1 sent all three, and without them the
 * move buttons throw, the forced-switch flow never opens and the weather banner
 * never shows.
 */
export function publicState(b: Battle2, viewer: 0 | 1) {
  const foe = (1 - viewer) as 0 | 1
  const weather = (b.sim as unknown as { field?: { weather?: string } }).field?.weather
  return {
    turn: b.turn,
    weather: WEATHER_MAP[toSimId(String(weather ?? 'none'))] ?? null,
    finished: b.finished,
    winner: b.winner,
    mustReplace: b.pendingReplace[viewer],
    you: { active: b.sides[viewer].active, team: ownTeam(b, viewer) },
    foe: { active: b.sides[foe].active, team: b.sides[foe].team },
  }
}
