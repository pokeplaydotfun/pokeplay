/**
 * Bakes the first 151 Pokémon and every move they can learn into
 * `data/pokedex.json`, straight from PokeAPI.
 *
 * Run once (`node scripts/build-pokedex.mjs`); the result is committed so the
 * battle server never depends on PokeAPI being up, and so every player is
 * simulating against byte-identical data.
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const API = 'https://pokeapi.co/api/v2'
const OUT = new URL('../data/pokedex.json', import.meta.url)
const CACHE = new URL('../data/.cache.json', import.meta.url)

const cache = existsSync(CACHE) ? JSON.parse(await readFile(CACHE, 'utf8')) : {}
let fetched = 0

async function get(url) {
  if (cache[url]) return cache[url]
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  const json = await res.json()
  cache[url] = json
  fetched++
  return json
}

/** Runs `fn` over `items` with a bounded number of in-flight requests. */
async function pool(items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++
        out[idx] = await fn(items[idx], idx)
      }
    }),
  )
  return out
}

const STAT_KEY = {
  hp: 'hp',
  attack: 'atk',
  defense: 'def',
  'special-attack': 'spa',
  'special-defense': 'spd',
  speed: 'spe',
}

console.log('Fetching 151 Pokémon…')
const ids = Array.from({ length: 151 }, (_, i) => i + 1)

const pokemon = await pool(ids, 10, async (id) => {
  const p = await get(`${API}/pokemon/${id}`)
  // Gender ratio lives on the species resource, not the pokemon one.
  const sp = await get(`${API}/pokemon-species/${id}`)
  const stats = {}
  for (const s of p.stats) stats[STAT_KEY[s.stat.name]] = s.base_stat

  return {
    id: p.id,
    name: p.name,
    types: p.types.map((t) => t.type.name),
    stats,
    /** -1 means genderless; otherwise eighths female (0 = always male). */
    genderRate: sp.gender_rate,
    sprites: {
      front: p.sprites.front_default,
      back: p.sprites.back_default,
      frontShiny: p.sprites.front_shiny,
      art: p.sprites.other?.['official-artwork']?.front_default ?? null,
    },
    // Every move the species can learn, in any version group.
    moves: [...new Set(p.moves.map((m) => m.move.name))].sort(),
    // Abilities this species can legally have, hidden ones included.
    abilities: p.abilities
      .map((a) => ({ name: a.ability.name, hidden: a.is_hidden }))
      .sort((a, b) => Number(a.hidden) - Number(b.hidden)),
  }
})

const moveNames = [...new Set(pokemon.flatMap((p) => p.moves))].sort()
console.log(`Fetching ${moveNames.length} moves…`)

const moves = await pool(moveNames, 10, async (name) => {
  const m = await get(`${API}/move/${name}`)
  const meta = m.meta ?? {}

  return {
    name: m.name,
    type: m.type.name,
    // "physical" | "special" | "status"
    category: m.damage_class.name,
    power: m.power,
    // null accuracy in PokeAPI means the move cannot miss.
    accuracy: m.accuracy,
    pp: m.pp,
    priority: m.priority,
    target: m.target.name,
    ailment: meta.ailment?.name && meta.ailment.name !== 'none' ? meta.ailment.name : null,
    ailmentChance: meta.ailment_chance ?? 0,
    critRate: meta.crit_rate ?? 0,
    drain: meta.drain ?? 0,
    healing: meta.healing ?? 0,
    flinchChance: meta.flinch_chance ?? 0,
    statChance: meta.stat_chance ?? 0,
    minHits: meta.min_hits ?? null,
    maxHits: meta.max_hits ?? null,
    statChanges: (m.stat_changes ?? []).map((s) => ({
      stat: STAT_KEY[s.stat.name] ?? s.stat.name,
      change: s.change,
    })),
  }
})

await mkdir(new URL('../data/', import.meta.url), { recursive: true })
await writeFile(CACHE, JSON.stringify(cache))
await writeFile(
  OUT,
  JSON.stringify(
    { generatedAt: new Date().toISOString(), source: 'https://pokeapi.co/', pokemon, moves },
    null,
    0,
  ),
)

console.log(`Done. ${pokemon.length} Pokémon, ${moves.length} moves (${fetched} new requests).`)
