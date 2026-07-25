/**
 * Escrow contract bindings.
 *
 * The ABI below is transcribed from `contracts/src/PokePlayEscrow.sol` in
 * this repo — the real thing, not a guess. If the contract changes, this file
 * must change with it.
 *
 * `ESCROW_ADDRESS` is empty until the contract is deployed. Everything here is
 * written so that an unset address is a normal, expected state: `escrowReady`
 * is false and the UI disables paid wagering rather than pretending it works.
 */

import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, parseEventLogs } from 'viem'
import type { TransactionReceipt } from 'viem'
import { ESCROW_ADDRESS } from '../config'

/* ------------------------------------------------------------------ */
/* address                                                             */
/* ------------------------------------------------------------------ */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/** The deployed escrow, or null when it has not been deployed yet. */
export const escrowAddress: `0x${string}` | null = ADDRESS_RE.test(ESCROW_ADDRESS)
  ? (ESCROW_ADDRESS as `0x${string}`)
  : null

/** True only when there is a real contract to talk to. Gate paid flows on this. */
export const escrowReady = escrowAddress !== null

/**
 * The escrow address, or a thrown error.
 *
 * Callers should have already gated on `escrowReady`; this exists so a write
 * path can bind a non-null address to a local (narrowing an imported binding
 * does not survive into a closure) and so a missed gate fails loudly instead of
 * silently sending a transaction to nowhere.
 */
export function requireEscrow(): `0x${string}` {
  if (!escrowAddress) throw new Error('The escrow contract has not been deployed yet.')
  return escrowAddress
}

/* ------------------------------------------------------------------ */
/* abi                                                                 */
/* ------------------------------------------------------------------ */

export const escrowAbi = [
  /* ---- wager lifecycle ---- */
  {
    type: 'function',
    name: 'createWager',
    stateMutability: 'payable',
    inputs: [
      { name: 'stakeWei', type: 'uint256' },
      { name: 'expiry', type: 'uint64' },
    ],
    outputs: [{ name: 'id', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'acceptWager',
    stateMutability: 'payable',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'cancelWager',
    stateMutability: 'nonpayable',
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
    name: 'settleDraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claimTimeout',
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
    name: 'getWager',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'creator', type: 'address' },
          { name: 'expiry', type: 'uint64' },
          { name: 'status', type: 'uint8' },
          { name: 'opponent', type: 'address' },
          { name: 'acceptedAt', type: 'uint64' },
          { name: 'stake', type: 'uint256' },
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
  {
    type: 'function',
    name: 'arbiter',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'paused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },

  /* ---- events ---- */
  {
    type: 'event',
    name: 'WagerCreated',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'stake', type: 'uint256', indexed: false },
      { name: 'expiry', type: 'uint64', indexed: false },
      { name: 'nonce', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'WagerAccepted',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'opponent', type: 'address', indexed: true },
      { name: 'acceptedAt', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'WagerCancelled',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'by', type: 'address', indexed: true },
      { name: 'refund', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'WagerSettled',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'winner', type: 'address', indexed: true },
      { name: 'loser', type: 'address', indexed: true },
      { name: 'payout', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'WagerDrawn',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'refundEach', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'WagerTimedOut',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'by', type: 'address', indexed: true },
      { name: 'refundEach', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Withdrawal',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },

  /* ---- custom errors, so reverts read as sentences ---- */
  { type: 'error', name: 'StakeMismatch', inputs: [{ name: 'expected', type: 'uint256' }, { name: 'provided', type: 'uint256' }] },
  { type: 'error', name: 'ExpiryInPast', inputs: [{ name: 'provided', type: 'uint64' }, { name: 'nowTs', type: 'uint256' }] },
  { type: 'error', name: 'WagerNotOpen', inputs: [{ name: 'id', type: 'uint256' }, { name: 'status', type: 'uint8' }] },
  { type: 'error', name: 'WagerNotActive', inputs: [{ name: 'id', type: 'uint256' }, { name: 'status', type: 'uint8' }] },
  { type: 'error', name: 'WagerExpired', inputs: [{ name: 'id', type: 'uint256' }, { name: 'expiry', type: 'uint64' }] },
  { type: 'error', name: 'CannotAcceptOwnWager', inputs: [{ name: 'id', type: 'uint256' }] },
  { type: 'error', name: 'NotCreator', inputs: [{ name: 'id', type: 'uint256' }, { name: 'caller', type: 'address' }] },
  { type: 'error', name: 'NotYetExpired', inputs: [{ name: 'id', type: 'uint256' }, { name: 'expiry', type: 'uint64' }] },
  { type: 'error', name: 'NotParticipant', inputs: [{ name: 'id', type: 'uint256' }, { name: 'caller', type: 'address' }] },
  { type: 'error', name: 'WinnerNotParticipant', inputs: [{ name: 'id', type: 'uint256' }, { name: 'winner', type: 'address' }] },
  { type: 'error', name: 'InvalidArbiterSignature', inputs: [{ name: 'id', type: 'uint256' }, { name: 'recovered', type: 'address' }] },
  { type: 'error', name: 'TimeoutNotReached', inputs: [{ name: 'id', type: 'uint256' }, { name: 'claimableAt', type: 'uint64' }] },
  { type: 'error', name: 'NothingToWithdraw', inputs: [{ name: 'account', type: 'address' }] },
  { type: 'error', name: 'TransferFailed', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }] },
  { type: 'error', name: 'DirectPaymentRejected', inputs: [] },
] as const

/** Mirrors `PokePlayEscrow.Status`. */
export const WagerStatus = {
  NONE: 0,
  OPEN: 1,
  ACTIVE: 2,
  SETTLED: 3,
  REFUNDED: 4,
  CANCELLED: 5,
} as const

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * How long an on-chain wager stays acceptable.
 *
 * The server expires board entries after an hour, so the on-chain expiry is
 * deliberately longer: the acceptance path must never fail on-chain while the
 * board still advertises the wager as open. The creator can cancel and reclaim
 * their stake at any time while it is OPEN, so a long expiry costs them nothing.
 */
export const ONCHAIN_EXPIRY_SECONDS = 2 * 60 * 60

export function expiryFromNow(seconds = ONCHAIN_EXPIRY_SECONDS): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + seconds)
}

/**
 * Pull the new wager id out of a `createWager` receipt.
 *
 * The function returns the id, but a transaction cannot give us a return value
 * — the `WagerCreated` event is the only way to read it back.
 */
export function wagerIdFromReceipt(receipt: TransactionReceipt): bigint | null {
  const mine = escrowAddress
    ? receipt.logs.filter((l) => l.address.toLowerCase() === escrowAddress.toLowerCase())
    : receipt.logs

  const parsed = parseEventLogs({ abi: escrowAbi, eventName: 'WagerCreated', logs: mine })
  const first = parsed[0]
  return first ? first.args.id : null
}

/**
 * Turn a wallet/RPC error into something a person can act on.
 *
 * The important case is the user simply declining in their wallet — that is not
 * a failure and must not be shown as a scary error.
 */
export function describeTxError(err: unknown): string {
  if (isUserRejection(err)) return 'You rejected the transaction in your wallet.'

  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName
      if (name) return `The contract rejected this: ${name}.`
      if (reverted.reason) return reverted.reason
    }
    return err.shortMessage || err.message
  }

  return err instanceof Error ? err.message : 'Something went wrong.'
}

/** True when the user declined the request in their wallet. */
export function isUserRejection(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof UserRejectedRequestError)) return true
  // Some injected wallets surface the raw EIP-1193 code instead of a viem error.
  const code = (err as { code?: unknown } | null)?.code
  return code === 4001
}
