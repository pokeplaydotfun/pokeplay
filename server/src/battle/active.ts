/**
 * The battle engine the server actually runs.
 *
 * Every consumer (rooms, replay, queue, tournaments, the API) imports from
 * here rather than naming an engine directly, so switching engines — or
 * rolling one back — is a change to this file alone.
 *
 * Currently: v2, the @pkmn/sim adapter. v1 (`engine.ts` + `data.ts` + `ai.ts`)
 * is still in the tree and still passing its own tests; to roll back, re-point
 * the three blocks below at it.
 *
 * `dexReady` must be awaited before serving traffic — @pkmn loads learnsets
 * asynchronously, and team validation is wrong until it has.
 */

export {
  createBattle,
  resolveTurn,
  replaceFainted,
  validateAction,
  publicState,
  isTeamWiped,
  firstLegalAction,
  viewerEvents,
  LEVEL,
  type Action,
  type BattleEvent,
  type TeamSlot,
  type Battle2 as Battle,
  type Side2 as Side,
  type PublicMon,
} from './engine2.js'

export {
  validateTeam,
  ready as dexReady,
  MOVES,
  SPECIES,
  SPECIES_BY_NAME,
  ABILITIES,
  allSpecies,
  EXCLUDED_MOVES,
  TEAM_SIZE,
  MAX_MOVES,
  NO_ABILITY,
  type DexMove,
  type DexSpecies,
} from './dex2.js'

export { chooseAction, type Difficulty } from './ai2.js'
