/**
 * The 25 natures. Each raises one stat by 10% and lowers another by 10%;
 * the five where both are the same stat cancel out and are neutral.
 *
 * HP is never affected by nature.
 */
export type NatureStat = 'atk' | 'def' | 'spa' | 'spd' | 'spe'

export type Nature = {
  name: string
  up: NatureStat | null
  down: NatureStat | null
}

export const NATURES: Nature[] = [
  { name: 'hardy', up: null, down: null },
  { name: 'lonely', up: 'atk', down: 'def' },
  { name: 'brave', up: 'atk', down: 'spe' },
  { name: 'adamant', up: 'atk', down: 'spa' },
  { name: 'naughty', up: 'atk', down: 'spd' },

  { name: 'bold', up: 'def', down: 'atk' },
  { name: 'docile', up: null, down: null },
  { name: 'relaxed', up: 'def', down: 'spe' },
  { name: 'impish', up: 'def', down: 'spa' },
  { name: 'lax', up: 'def', down: 'spd' },

  { name: 'timid', up: 'spe', down: 'atk' },
  { name: 'hasty', up: 'spe', down: 'def' },
  { name: 'serious', up: null, down: null },
  { name: 'jolly', up: 'spe', down: 'spa' },
  { name: 'naive', up: 'spe', down: 'spd' },

  { name: 'modest', up: 'spa', down: 'atk' },
  { name: 'mild', up: 'spa', down: 'def' },
  { name: 'quiet', up: 'spa', down: 'spe' },
  { name: 'bashful', up: null, down: null },
  { name: 'rash', up: 'spa', down: 'spd' },

  { name: 'calm', up: 'spd', down: 'atk' },
  { name: 'gentle', up: 'spd', down: 'def' },
  { name: 'sassy', up: 'spd', down: 'spe' },
  { name: 'careful', up: 'spd', down: 'spa' },
  { name: 'quirky', up: null, down: null },
]

export const NATURE_BY_NAME = new Map(NATURES.map((n) => [n.name, n]))

export const DEFAULT_NATURE = 'hardy'

/** Multiplier a nature applies to a given stat: 1.1, 0.9, or 1. */
export function natureMultiplier(nature: Nature | undefined, stat: NatureStat): number {
  if (!nature) return 1
  if (nature.up === stat && nature.down !== stat) return 1.1
  if (nature.down === stat && nature.up !== stat) return 0.9
  return 1
}
