/**
 * Every ability the first 151 Pokémon can have — all 123 of them.
 *
 * Each one is a descriptor rather than a lump of code, so this file stays the
 * single answer to "what does X actually do here" and the engine just reads
 * flags. Where an ability genuinely does nothing in this format — no items, no
 * allies, no wild encounters — it carries an `inert` note explaining why, and
 * the builder shows that note. That is different from an ability being
 * unimplemented: Pickup really does nothing in a trainer battle.
 */
import type { PokeType } from './typechart.js'

export type Status = 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz'
export type Weather = 'sun' | 'rain' | 'sand' | 'hail'

export type Ability = {
  name: string
  /** One line, shown in the team builder. */
  text: string
  /** Set when the ability has no effect in this format, and why. */
  inert?: string

  /* --- type interactions ------------------------------------------- */
  /** Boost own moves of this type by 1.5x below 1/3 HP. */
  pinchType?: PokeType
  /** Immune to this type entirely. */
  immuneTo?: PokeType
  /** Immune to this type and heals 25% max HP instead. */
  absorbs?: PokeType
  /** Immune to this type; being hit by it boosts own moves of that type. */
  drawsIn?: PokeType
  /** Immune to this type; being hit raises a stat instead. */
  liftsOnHit?: { type: PokeType; stat: 'atk' | 'def' | 'spa' | 'spd' | 'spe'; by: number }
  /** Incoming damage from these types is halved. */
  resists?: PokeType[]
  /** Normal and Fighting moves can hit Ghost. */
  scrappy?: boolean
  /** Immune to sound-based moves. */
  soundproof?: boolean

  /* --- contact and retaliation -------------------------------------- */
  /** Chance (%) to inflict one of these statuses on an attacker who made contact. */
  contact?: { status: Status[]; chance: number }
  /** Chance (%) that this Pokémon's own contact moves poison the target. */
  poisonTouch?: number
  /** Attacker loses 25% max HP when this Pokémon faints to a contact move. */
  aftermath?: boolean
  /** Chance (%) that a contact move that hits this Pokémon gets disabled. */
  cursedBody?: number
  /** Passes any status this Pokémon receives back to whoever caused it. */
  synchronize?: boolean

  /* --- status -------------------------------------------------------- */
  /** Statuses this Pokémon can never receive. */
  statusImmune?: (Status | 'confusion' | 'flinch' | 'infatuation')[]
  /** Status is cured when this Pokémon switches out. */
  cureOnSwitch?: boolean
  /** Chance (%) each turn to shake off a status. */
  shedSkin?: number
  /** Wakes up in half the usual time. */
  earlyBird?: boolean
  /** Cannot be statused while the sun is up. */
  leafGuard?: boolean
  /** Cures status at the end of each turn while it rains. */
  hydration?: boolean

  /* --- raw stats ------------------------------------------------------ */
  /** Multiply own Attack when statused (Guts) or always (Huge Power). */
  atkMult?: { when: 'statused' | 'always'; value: number }
  /** Multiply own Defence when statused (Marvel Scale). */
  defMult?: { when: 'statused'; value: number }
  /** Speed x1.5 when statused, and paralysis stops cutting it. */
  quickFeet?: boolean
  /** Physical moves hit harder but less accurately (Hustle). */
  hustle?: boolean
  /** On switch-in, raise Attack or Sp. Atk against the foe's weaker defence. */
  download?: boolean

  /* --- damage shaping -------------------------------------------------- */
  /** Same-type attack bonus becomes this instead of 1.5. */
  stab?: number
  /** Moves at or below this base power hit 1.5x harder. */
  technicianCap?: number
  /** Multiplier applied when the move is super effective (Solid Rock). */
  superEffectiveTaken?: number
  /** Multiplier applied when own move is not very effective (Tinted Lens). */
  notVeryEffectiveDealt?: number
  /** Halves damage taken while at full HP. */
  multiscale?: boolean
  /** Own moves hit 1.3x harder when moving after the opponent. */
  analytic?: boolean
  /** Boost own moves belonging to a tagged group (punch, bite, sound…). */
  moveGroup?: { group: MoveGroup; mult: number }
  /** Ignores the opponent's stat stages, both ways. */
  unaware?: boolean
  /** Ignores the target's damage-shaping abilities. */
  moldBreaker?: boolean
  /** Multi-hit moves always hit the maximum number of times. */
  skillLink?: boolean
  /** Drain moves used against this Pokémon damage the drainer instead. */
  liquidOoze?: boolean
  /** Attack rises 25% against the same gender, falls 25% against the other. */
  rivalry?: boolean

  /* --- recoil, accuracy, crits ------------------------------------------ */
  /** Recoil damage is skipped. */
  noRecoil?: boolean
  /** Recoil moves hit 1.2x harder. */
  recoilBoost?: number
  /** Multiply own accuracy. */
  accuracy?: number
  /** Moves never miss. */
  noMiss?: boolean
  /** Status moves aimed at this Pokémon have their accuracy halved. */
  wonderSkin?: boolean
  /** Evasion x1.25 while confused. */
  tangledFeet?: boolean
  /** Cannot be hit by a critical hit. */
  critProof?: boolean
  /** Raises own critical-hit stage. */
  critStage?: number
  /** Critical hits deal this multiplier instead of 1.5x. */
  critDamage?: number
  /** Attack maxes out when struck by a critical hit. */
  angerPoint?: boolean

  /* --- secondary effects ------------------------------------------------- */
  /** Secondary-effect chances are multiplied by this (Serene Grace). */
  secondaryMult?: number
  /** Trades added effects for raw power (Sheer Force). */
  sheerForce?: boolean
  /** Immune to the added effects of attacks (Shield Dust). */
  shieldDust?: boolean
  /** Own damaging moves gain a 10% flinch chance (Stench). */
  stench?: boolean

  /* --- reacting to what happens ------------------------------------------ */
  /** Raise a stat when hit by a move of one of these types. */
  onHitBoost?: { types: PokeType[]; stat: 'atk' | 'def' | 'spa' | 'spd' | 'spe'; by: number }
  /** Physical hits drop Defence one stage and raise Speed two (Weak Armor). */
  weakArmor?: boolean
  /** Raise Speed one stage when made to flinch (Steadfast). */
  steadfast?: boolean
  /** Raise a stat when the opponent lowers one of yours. */
  onDrop?: { stat: 'atk' | 'spa'; by: number }
  /** Raise Attack one stage after knocking a Pokémon out. */
  moxie?: boolean

  /* --- field presence ------------------------------------------------------ */
  /** Lowers the opponent's Attack by one stage on switch-in. */
  intimidate?: boolean
  /** Ignores Intimidate and infatuation. */
  oblivious?: boolean
  /** Stats the opponent cannot lower. 'all' covers everything. */
  dropProof?: 'all' | ('atk' | 'def' | 'spa' | 'spd' | 'spe' | 'acc' | 'eva')[]
  /** Chance (%) to infatuate an attacker who made contact. */
  cuteCharm?: number
  /** Opponent cannot switch out. 'all', or only those weak to the given type. */
  traps?: 'all' | 'ground' | 'steel'
  /** Opponent's moves lose two PP per use instead of one. */
  pressure?: boolean
  /** Blocks self-destructing moves from either side. */
  damp?: boolean
  /** Copies the opponent's ability on switch-in. */
  trace?: boolean
  /** Becomes a copy of the opponent on switch-in. */
  imposter?: boolean
  /** Suppresses every other ability on the field. */
  neutralizingGas?: boolean
  /** Names the opponent's strongest move on switch-in. */
  forewarn?: boolean
  /** Warns when the opponent is carrying a super-effective move. */
  anticipation?: boolean

  /* --- recovery and residuals ------------------------------------------------ */
  /** Restores a third of max HP when switching out. */
  regenerator?: boolean
  /** Immune to damage that is not a direct hit: burn, poison, recoil, weather. */
  magicGuard?: boolean
  /** Takes no weather damage. */
  weatherProof?: boolean
  /** Survive a KO from full HP on 1 HP. */
  endure?: boolean

  /* --- weather ----------------------------------------------------------------- */
  /** Sets this weather on switch-in. */
  setsWeather?: Weather
  /** Cancels all weather effects while on the field. */
  suppressWeather?: boolean
  /** Doubles Speed in this weather. */
  speedX2In?: Weather
  /** Evasion x1.25 in this weather. */
  evasionUpIn?: Weather
  /** Heals 1/16 max HP each turn in this weather. */
  healsIn?: Weather
  /** Sp. Atk x1.5 in sun, at a cost of 1/8 max HP each turn. */
  solarPower?: boolean
  /** Water heals, Fire hurts more, sun burns and rain soothes. */
  drySkin?: boolean
  /** Rock, Ground and Steel moves hit 1.3x harder in a sandstorm. */
  sandForce?: boolean
}

/** Move tags PokeAPI does not expose, so they are listed explicitly. */
export type MoveGroup = 'punch' | 'sound' | 'bite' | 'pulse'

export const MOVE_GROUPS: Record<MoveGroup, Set<string>> = {
  punch: new Set([
    'bullet-punch', 'comet-punch', 'dizzy-punch', 'drain-punch', 'dynamic-punch',
    'fire-punch', 'focus-punch', 'hammer-arm', 'ice-punch', 'mach-punch',
    'mega-punch', 'meteor-mash', 'power-up-punch', 'shadow-punch', 'sky-uppercut',
    'thunder-punch', 'plasma-fists', 'double-iron-bash', 'ice-hammer', 'jet-punch',
    'rage-fist', 'headlong-rush', 'wicked-blow', 'surging-strikes',
  ]),
  sound: new Set([
    'growl', 'roar', 'sing', 'supersonic', 'screech', 'snore', 'uproar',
    'hyper-voice', 'metal-sound', 'grass-whistle', 'howl', 'bug-buzz',
    'chatter', 'heal-bell', 'perish-song', 'echoed-voice', 'relic-song',
    'round', 'snarl', 'noble-roar', 'disarming-voice', 'parting-shot',
    'boomburst', 'confide', 'sparkling-aria', 'clanging-scales', 'overdrive',
    'eerie-spell', 'torch-song', 'alluring-voice', 'psychic-noise',
  ]),
  bite: new Set([
    'bite', 'crunch', 'fire-fang', 'ice-fang', 'thunder-fang', 'poison-fang',
    'hyper-fang', 'psychic-fangs', 'fishious-rend', 'jaw-lock',
  ]),
  pulse: new Set([
    'aura-sphere', 'dark-pulse', 'dragon-pulse', 'heal-pulse', 'water-pulse',
    'origin-pulse', 'terrain-pulse',
  ]),
}

export const inGroup = (move: string, group: MoveGroup) => MOVE_GROUPS[group].has(move)

const list: Ability[] = [
  /* --- pinch boosts ------------------------------------------------ */
  { name: 'overgrow', text: 'Grass moves hit 50% harder below ⅓ HP.', pinchType: 'grass' },
  { name: 'blaze', text: 'Fire moves hit 50% harder below ⅓ HP.', pinchType: 'fire' },
  { name: 'torrent', text: 'Water moves hit 50% harder below ⅓ HP.', pinchType: 'water' },
  { name: 'swarm', text: 'Bug moves hit 50% harder below ⅓ HP.', pinchType: 'bug' },

  /* --- type immunities --------------------------------------------- */
  { name: 'levitate', text: 'Immune to Ground moves.', immuneTo: 'ground' },
  { name: 'water-absorb', text: 'Water moves heal 25% instead of damaging.', absorbs: 'water' },
  { name: 'volt-absorb', text: 'Electric moves heal 25% instead of damaging.', absorbs: 'electric' },
  { name: 'flash-fire', text: 'Immune to Fire; being hit powers up your Fire moves.', drawsIn: 'fire' },
  { name: 'lightning-rod', text: 'Immune to Electric; being hit raises Sp. Atk.', liftsOnHit: { type: 'electric', stat: 'spa', by: 1 } },
  { name: 'storm-drain', text: 'Immune to Water; being hit raises Sp. Atk.', liftsOnHit: { type: 'water', stat: 'spa', by: 1 } },
  { name: 'sap-sipper', text: 'Immune to Grass; being hit raises Attack.', liftsOnHit: { type: 'grass', stat: 'atk', by: 1 } },
  { name: 'motor-drive', text: 'Immune to Electric; being hit raises Speed.', liftsOnHit: { type: 'electric', stat: 'spe', by: 1 } },
  { name: 'soundproof', text: 'Immune to sound-based moves.', soundproof: true },

  /* --- contact punishment ------------------------------------------- */
  { name: 'static', text: '30% chance to paralyse an attacker.', contact: { status: ['par'], chance: 30 } },
  { name: 'poison-point', text: '30% chance to poison an attacker.', contact: { status: ['psn'], chance: 30 } },
  { name: 'flame-body', text: '30% chance to burn an attacker.', contact: { status: ['brn'], chance: 30 } },
  { name: 'effect-spore', text: '30% chance to poison, paralyse or sleep an attacker.', contact: { status: ['psn', 'par', 'slp'], chance: 30 } },
  { name: 'cute-charm', text: '30% chance to infatuate an attacker of the opposite gender.', cuteCharm: 30 },
  { name: 'poison-touch', text: 'Your contact moves have a 30% chance to poison.', poisonTouch: 30 },
  { name: 'aftermath', text: 'Deals 25% to whoever knocks you out by contact.', aftermath: true },
  { name: 'cursed-body', text: '30% chance to disable a move that hits you.', cursedBody: 30 },
  { name: 'synchronize', text: 'Passes burn, poison and paralysis back to whoever caused it.', synchronize: true },

  /* --- status immunity ---------------------------------------------- */
  { name: 'immunity', text: 'Cannot be poisoned.', statusImmune: ['psn', 'tox'] },
  { name: 'limber', text: 'Cannot be paralysed.', statusImmune: ['par'] },
  { name: 'insomnia', text: 'Cannot be put to sleep.', statusImmune: ['slp'] },
  { name: 'vital-spirit', text: 'Cannot be put to sleep.', statusImmune: ['slp'] },
  { name: 'water-veil', text: 'Cannot be burned.', statusImmune: ['brn'] },
  { name: 'magma-armor', text: 'Cannot be frozen.', statusImmune: ['frz'] },
  { name: 'own-tempo', text: 'Cannot be confused.', statusImmune: ['confusion'] },
  { name: 'inner-focus', text: 'Cannot be made to flinch.', statusImmune: ['flinch'] },
  { name: 'oblivious', text: 'Cannot be infatuated, and ignores Intimidate.', statusImmune: ['infatuation'], oblivious: true },
  { name: 'early-bird', text: 'Wakes from sleep twice as fast.', earlyBird: true },
  { name: 'shed-skin', text: '30% chance each turn to shake off status.', shedSkin: 30 },
  { name: 'natural-cure', text: 'Status clears when you switch out.', cureOnSwitch: true },
  { name: 'leaf-guard', text: 'Cannot be statused while the sun is up.', leafGuard: true },
  { name: 'hydration', text: 'Status clears at the end of each turn in rain.', hydration: true },

  /* --- damage shaping ------------------------------------------------ */
  { name: 'thick-fat', text: 'Halves Fire and Ice damage taken.', resists: ['fire', 'ice'] },
  { name: 'sturdy', text: 'Survives a one-hit KO from full HP.', endure: true },
  { name: 'solid-rock', text: 'Super-effective hits deal 25% less.', superEffectiveTaken: 0.75 },
  { name: 'filter', text: 'Super-effective hits deal 25% less.', superEffectiveTaken: 0.75 },
  { name: 'multiscale', text: 'Halves damage taken while at full HP.', multiscale: true },
  { name: 'tinted-lens', text: 'Your not-very-effective moves deal double.', notVeryEffectiveDealt: 2 },
  { name: 'adaptability', text: 'Same-type moves get a 2x bonus instead of 1.5x.', stab: 2 },
  { name: 'technician', text: 'Moves of 60 power or less hit 50% harder.', technicianCap: 60 },
  { name: 'analytic', text: 'Your moves hit 30% harder when you move second.', analytic: true },
  { name: 'iron-fist', text: 'Punching moves hit 20% harder.', moveGroup: { group: 'punch', mult: 1.2 } },
  { name: 'skill-link', text: 'Multi-hit moves always hit the maximum number of times.', skillLink: true },
  { name: 'unaware', text: "Ignores the opponent's stat changes.", unaware: true },
  { name: 'mold-breaker', text: "Ignores the opponent's defensive abilities.", moldBreaker: true },
  { name: 'scrappy', text: 'Normal and Fighting moves can hit Ghost types.', scrappy: true },
  { name: 'liquid-ooze', text: 'Draining moves used on you damage the drainer instead.', liquidOoze: true },
  { name: 'huge-power', text: 'Doubles Attack.', atkMult: { when: 'always', value: 2 } },
  { name: 'pure-power', text: 'Doubles Attack.', atkMult: { when: 'always', value: 2 } },
  { name: 'guts', text: 'Attack rises 50% while statused.', atkMult: { when: 'statused', value: 1.5 } },
  { name: 'marvel-scale', text: 'Defence rises 50% while statused.', defMult: { when: 'statused', value: 1.5 } },
  { name: 'quick-feet', text: 'Speed rises 50% while statused, and paralysis stops slowing you.', quickFeet: true },
  { name: 'hustle', text: 'Physical moves hit 50% harder but are less accurate.', hustle: true },
  { name: 'download', text: "On entry, raises Attack or Sp. Atk against the foe's weaker defence.", download: true },
  { name: 'rivalry', text: 'Hits 25% harder against the same gender, 25% softer against the other.', rivalry: true },
  { name: 'rock-head', text: 'Takes no recoil damage.', noRecoil: true },
  { name: 'reckless', text: 'Recoil moves hit 20% harder.', recoilBoost: 1.2 },
  { name: 'magic-guard', text: 'Only takes damage from direct attacks.', magicGuard: true },
  { name: 'overcoat', text: 'Takes no weather damage.', weatherProof: true },

  /* --- accuracy and crits --------------------------------------------- */
  { name: 'compound-eyes', text: 'Accuracy raised by 30%.', accuracy: 1.3 },
  { name: 'no-guard', text: 'Every move hits, from both sides.', noMiss: true },
  { name: 'wonder-skin', text: 'Status moves aimed at you are half as accurate.', wonderSkin: true },
  { name: 'tangled-feet', text: 'Harder to hit while confused.', tangledFeet: true },
  { name: 'shell-armor', text: 'Cannot be struck by a critical hit.', critProof: true },
  { name: 'battle-armor', text: 'Cannot be struck by a critical hit.', critProof: true },
  { name: 'super-luck', text: 'Critical hits land more often.', critStage: 1 },
  { name: 'sniper', text: 'Critical hits deal 2.25x instead of 1.5x.', critDamage: 2.25 },
  { name: 'anger-point', text: 'Attack maxes out when struck by a critical hit.', angerPoint: true },

  /* --- secondary effects ------------------------------------------------ */
  { name: 'serene-grace', text: 'Doubles the chance of added effects.', secondaryMult: 2 },
  { name: 'sheer-force', text: 'Moves with added effects lose them but hit 30% harder.', sheerForce: true },
  { name: 'shield-dust', text: 'Immune to the added effects of attacks.', shieldDust: true },
  { name: 'stench', text: 'Your damaging moves gain a 10% chance to flinch.', stench: true },

  /* --- reacting --------------------------------------------------------- */
  { name: 'justified', text: 'Attack rises when hit by a Dark move.', onHitBoost: { types: ['dark'], stat: 'atk', by: 1 } },
  { name: 'rattled', text: 'Speed rises when hit by a Bug, Dark or Ghost move.', onHitBoost: { types: ['bug', 'dark', 'ghost'], stat: 'spe', by: 1 } },
  { name: 'weak-armor', text: 'Physical hits lower Defence but sharply raise Speed.', weakArmor: true },
  { name: 'steadfast', text: 'Speed rises whenever you flinch.', steadfast: true },
  { name: 'defiant', text: 'Attack rises sharply when the opponent lowers a stat.', onDrop: { stat: 'atk', by: 2 } },
  { name: 'competitive', text: 'Sp. Atk rises sharply when the opponent lowers a stat.', onDrop: { stat: 'spa', by: 2 } },
  { name: 'moxie', text: 'Attack rises after knocking a Pokémon out.', moxie: true },
  { name: 'regenerator', text: 'Restores a third of max HP when switching out.', regenerator: true },

  /* --- field presence ----------------------------------------------------- */
  { name: 'intimidate', text: "Lowers the opponent's Attack on switch-in.", intimidate: true },
  { name: 'clear-body', text: 'Opponents cannot lower your stats.', dropProof: 'all' },
  { name: 'white-smoke', text: 'Opponents cannot lower your stats.', dropProof: 'all' },
  { name: 'hyper-cutter', text: 'Your Attack cannot be lowered.', dropProof: ['atk'] },
  { name: 'keen-eye', text: 'Your accuracy cannot be lowered.', dropProof: ['acc'] },
  { name: 'big-pecks', text: 'Your Defence cannot be lowered.', dropProof: ['def'] },
  { name: 'arena-trap', text: 'Grounded opponents cannot switch out.', traps: 'ground' },
  { name: 'magnet-pull', text: 'Steel-type opponents cannot switch out.', traps: 'steel' },
  { name: 'pressure', text: "The opponent's moves lose two PP per use.", pressure: true },
  { name: 'damp', text: 'Prevents self-destructing moves from either side.', damp: true },
  { name: 'trace', text: "Copies the opponent's ability on switch-in.", trace: true },
  { name: 'imposter', text: 'Becomes a copy of the opponent on switch-in.', imposter: true },
  { name: 'neutralizing-gas', text: 'Suppresses every other ability while on the field.', neutralizingGas: true },
  { name: 'forewarn', text: "Names the opponent's strongest move on switch-in.", forewarn: true },
  { name: 'anticipation', text: 'Warns you when the opponent has a super-effective move.', anticipation: true },

  /* --- weather -------------------------------------------------------------- */
  { name: 'drought', text: 'Summons harsh sunlight on switch-in.', setsWeather: 'sun' },
  { name: 'cloud-nine', text: 'Cancels all weather effects.', suppressWeather: true },
  { name: 'air-lock', text: 'Cancels all weather effects.', suppressWeather: true },
  { name: 'chlorophyll', text: 'Doubles Speed in harsh sunlight.', speedX2In: 'sun' },
  { name: 'swift-swim', text: 'Doubles Speed in rain.', speedX2In: 'rain' },
  { name: 'sand-rush', text: 'Doubles Speed in a sandstorm, and shrugs off the damage.', speedX2In: 'sand', weatherProof: true },
  { name: 'sand-veil', text: 'Harder to hit in a sandstorm, and shrugs off the damage.', evasionUpIn: 'sand', weatherProof: true },
  { name: 'snow-cloak', text: 'Harder to hit in hail, and shrugs off the damage.', evasionUpIn: 'hail', weatherProof: true },
  { name: 'rain-dish', text: 'Restores a little HP each turn in rain.', healsIn: 'rain' },
  { name: 'ice-body', text: 'Restores a little HP each turn in hail, and shrugs off the damage.', healsIn: 'hail', weatherProof: true },
  { name: 'solar-power', text: 'Sp. Atk rises 50% in sun, at the cost of ⅛ HP each turn.', solarPower: true },
  { name: 'dry-skin', text: 'Water heals you, Fire hurts more, sun drains you and rain restores you.', drySkin: true, absorbs: 'water' },
  { name: 'sand-force', text: 'Rock, Ground and Steel moves hit 30% harder in a sandstorm, and shrugs off the damage.', sandForce: true, weatherProof: true },

  /* --- no effect in this format ----------------------------------------------- */
  { name: 'run-away', text: 'Guarantees escape from wild Pokémon.', inert: 'There are no wild battles here.' },
  { name: 'illuminate', text: 'Raises the wild encounter rate.', inert: 'There are no wild battles here.' },
  { name: 'pickup', text: 'Picks up items after a battle.', inert: 'There are no items here.' },
  { name: 'unnerve', text: 'Stops the opponent eating its Berry.', inert: 'There are no held items here.' },
  { name: 'gluttony', text: 'Eats a pinch Berry earlier than usual.', inert: 'There are no held items here.' },
  { name: 'harvest', text: 'May recycle a used Berry.', inert: 'There are no held items here.' },
  { name: 'sticky-hold', text: 'Its held item cannot be taken.', inert: 'There are no held items here.' },
  { name: 'frisk', text: "Checks the opponent's held item.", inert: 'There are no held items here.' },
  { name: 'unburden', text: 'Doubles Speed after using up its held item.', inert: 'There are no held items here.' },
  { name: 'infiltrator', text: 'Ignores screens and Substitute.', inert: 'This simulator has neither.' },
  { name: 'friend-guard', text: 'Reduces damage taken by allies.', inert: 'Battles here are one on one.' },
  { name: 'healer', text: 'May heal an ally of its status.', inert: 'Battles here are one on one.' },
]

export const ABILITIES = new Map(list.map((a) => [a.name, a]))

export const isSupportedAbility = (name: string) => ABILITIES.has(name)

/** No ability. Always legal. */
export const NO_ABILITY = 'none'
