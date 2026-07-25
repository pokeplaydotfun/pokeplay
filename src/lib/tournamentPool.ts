/**
 * Tournament-pool contract bindings.
 *
 * The ABI below is transcribed from `contracts/src/PokePlayTournamentPool.sol`
 * in this repo — the real thing, not a guess. If the contract changes, this file
 * must change with it. The sibling of escrow.ts.
 *
 * `TOURNAMENT_POOL_ADDRESS` is empty until the pool is deployed. Everything here
 * treats an unset address as a normal, expected state: `poolReady` is false and
 * the UI offers free tournaments only rather than pretending paid works.
 */

import { parseEventLogs } from 'viem'
import type { TransactionReceipt } from 'viem'
import { TOURNAMENT_POOL_ADDRESS } from '../config'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/** The deployed pool, or null when it has not been deployed yet. */
export const poolAddress: `0x${string}` | null = ADDRESS_RE.test(TOURNAMENT_POOL_ADDRESS)
  ? (TOURNAMENT_POOL_ADDRESS as `0x${string}`)
  : null

/** True only when there is a real pool to talk to. Gate paid flows on this. */
export const poolReady = poolAddress !== null

/* ------------------------------------------------------------------ */
/* abi                                                                 */
/* ------------------------------------------------------------------ */

export const poolAbi = [
  /* ---- lifecycle ---- */
  {
    type: 'function',
    name: 'createTournament',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'entryFee', type: 'uint256' },
      { name: 'maxPlayers', type: 'uint32' },
      { name: 'registrationDeadline', type: 'uint64' },
    ],
    outputs: [{ name: 'id', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'joinTournament',
    stateMutability: 'payable',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'winner', type: 'address' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'leaveTournament',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'cancelTournament',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'extendDeadline',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'newDeadline', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claimRefund',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [],
  },

  /* ---- pull payments ---- */
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balances',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },

  /* ---- views ---- */
  {
    type: 'function',
    name: 'getTournament',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'organizer', type: 'address' },
          { name: 'registrationDeadline', type: 'uint64' },
          { name: 'status', type: 'uint8' },
          { name: 'maxPlayers', type: 'uint32' },
          { name: 'playerCount', type: 'uint32' },
          { name: 'createdAt', type: 'uint64' },
          { name: 'entryFee', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'statusOf',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'isEntrant',
    stateMutability: 'view',
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'player', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'potOf',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'timeoutAt',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'feeBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint16' }],
  },

  /* ---- events ---- */
  {
    type: 'event',
    name: 'TournamentCreated',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'organizer', type: 'address', indexed: true },
      { name: 'entryFee', type: 'uint256', indexed: false },
      { name: 'maxPlayers', type: 'uint32', indexed: false },
      { name: 'registrationDeadline', type: 'uint64', indexed: false },
      { name: 'nonce', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PlayerJoined',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'playerCount', type: 'uint32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TournamentSettled',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'winner', type: 'address', indexed: true },
      { name: 'pot', type: 'uint256', indexed: false },
      { name: 'payout', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
    ],
  },

  /* ---- custom errors, so reverts read as sentences ---- */
  { type: 'error', name: 'ZeroEntryFee', inputs: [] },
  { type: 'error', name: 'NotOrganizer', inputs: [{ name: 'id', type: 'uint256' }, { name: 'caller', type: 'address' }] },
  { type: 'error', name: 'DeadlineNotLater', inputs: [{ name: 'current', type: 'uint64' }, { name: 'provided', type: 'uint64' }] },
  { type: 'error', name: 'DeadlineTooFar', inputs: [{ name: 'provided', type: 'uint64' }, { name: 'max', type: 'uint64' }] },
  { type: 'error', name: 'EntryFeeMismatch', inputs: [{ name: 'expected', type: 'uint256' }, { name: 'provided', type: 'uint256' }] },
  { type: 'error', name: 'RegistrationClosed', inputs: [{ name: 'id', type: 'uint256' }, { name: 'deadline', type: 'uint64' }] },
  { type: 'error', name: 'TournamentFull', inputs: [{ name: 'id', type: 'uint256' }, { name: 'maxPlayers', type: 'uint32' }] },
  { type: 'error', name: 'AlreadyJoined', inputs: [{ name: 'id', type: 'uint256' }, { name: 'player', type: 'address' }] },
  { type: 'error', name: 'TournamentNotOpen', inputs: [{ name: 'id', type: 'uint256' }, { name: 'status', type: 'uint8' }] },
  { type: 'error', name: 'NotEnoughPlayers', inputs: [{ name: 'id', type: 'uint256' }, { name: 'playerCount', type: 'uint32' }] },
  { type: 'error', name: 'WinnerNotEntrant', inputs: [{ name: 'id', type: 'uint256' }, { name: 'winner', type: 'address' }] },
  { type: 'error', name: 'InvalidArbiterSignature', inputs: [{ name: 'id', type: 'uint256' }, { name: 'recovered', type: 'address' }] },
  { type: 'error', name: 'NotEntrantOrAlreadyRefunded', inputs: [{ name: 'id', type: 'uint256' }, { name: 'caller', type: 'address' }] },
  { type: 'error', name: 'NotRefundable', inputs: [{ name: 'id', type: 'uint256' }, { name: 'status', type: 'uint8' }] },
  { type: 'error', name: 'TimeoutNotReached', inputs: [{ name: 'id', type: 'uint256' }, { name: 'claimableAt', type: 'uint64' }] },
  { type: 'error', name: 'CannotCancel', inputs: [{ name: 'id', type: 'uint256' }] },
  { type: 'error', name: 'NothingToWithdraw', inputs: [{ name: 'account', type: 'address' }] },
  { type: 'error', name: 'DirectPaymentRejected', inputs: [] },
] as const

/** Mirrors `PokePlayTournamentPool.Status`. */
export const TournamentStatus = {
  NONE: 0,
  OPEN: 1,
  SETTLED: 2,
  REFUNDING: 3,
} as const

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * How long registration stays open, on chain. The server closes sign-ups on its
 * own schedule; this is deliberately generous so the on-chain join never fails
 * while the server still advertises the tournament as open. The refund timeout
 * only starts AFTER this, so a longer window costs entrants nothing.
 */
export const REGISTRATION_WINDOW_SECONDS = 24 * 60 * 60

export function deadlineFromNow(seconds = REGISTRATION_WINDOW_SECONDS): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + seconds)
}

/**
 * Pull the new tournament id out of a `createTournament` receipt. A transaction
 * cannot return a value, so the `TournamentCreated` event is the only way to
 * read it back.
 */
export function tournamentIdFromReceipt(receipt: TransactionReceipt): bigint | null {
  const mine = poolAddress
    ? receipt.logs.filter((l) => l.address.toLowerCase() === poolAddress.toLowerCase())
    : receipt.logs
  const parsed = parseEventLogs({ abi: poolAbi, eventName: 'TournamentCreated', logs: mine })
  return parsed[0] ? parsed[0].args.id : null
}
