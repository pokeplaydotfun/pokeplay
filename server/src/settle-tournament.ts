import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, defineChain, getAddress, http } from 'viem'

/**
 * Signs tournament results for the PokePlayTournamentPool contract.
 *
 * The sibling of settle.ts. It uses the SAME arbiter key (the game server signs
 * for both the 1v1 escrow and the tournament pool), but a different EIP-712
 * domain and a different signed struct. Everything here is a deliberate mirror
 * of settle.ts so the two read the same way and fail the same way.
 *
 * ⚠ The arbiter key can move any pot to any entrant of that tournament. It lives
 * only in the server environment. The pool's timeout refund protects players if
 * this key is LOST; it is not protection if it is stolen.
 */
function loadArbiter(): ReturnType<typeof privateKeyToAccount> | null {
  const raw = process.env.ARBITER_PRIVATE_KEY?.trim()
  if (!raw) return null
  const hex = (raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`
  try {
    return privateKeyToAccount(hex)
  } catch (e) {
    console.error(
      `✖ ARBITER_PRIVATE_KEY is set but not a valid private key — tournament settlement DISABLED. ` +
        `${(e as Error).message.split('\n')[0]}`,
    )
    return null
  }
}

const POOL = process.env.TOURNAMENT_POOL_ADDRESS as `0x${string}` | undefined
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 4663)

const account = loadArbiter()

/**
 * Paid tournaments are live only with a valid arbiter key AND a pool address.
 * A malformed key leaves this false and the server runs tournaments free-only,
 * exactly as it does today.
 */
export const tournamentSettlementEnabled = Boolean(account && POOL)

export const tournamentArbiterAddress = account?.address ?? null
export const tournamentPoolAddress = POOL ?? null

/** Must match `EIP712("PokePlayTournamentPool", "1")` in the contract exactly. */
const DOMAIN_NAME = 'PokePlayTournamentPool'
const DOMAIN_VERSION = '1'

const domain = () => ({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  chainId: CHAIN_ID,
  verifyingContract: getAddress(POOL!),
})

const types = {
  TournamentResult: [
    { name: 'tournamentId', type: 'uint256' },
    { name: 'winner', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

/* ------------------------------------------------------------------ */
/* chain reads                                                         */
/* ------------------------------------------------------------------ */

const chain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'] } },
})

const publicClient = createPublicClient({ chain, transport: http() })

const GET_TOURNAMENT_ABI = [
  {
    type: 'function',
    name: 'getTournament',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [
      {
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
] as const

const IS_ENTRANT_ABI = [
  {
    type: 'function',
    name: 'isEntrant',
    stateMutability: 'view',
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'player', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

/**
 * Confirms the pool we are pointed at will accept our signatures, at startup.
 * Same silent-failure reasoning as the escrow: a wrong domain or arbiter makes
 * every settle revert while the server reports success, so refuse to start.
 */
export async function verifyTournamentConfig(): Promise<void> {
  if (!POOL) return
  const read = async <T,>(fn: () => Promise<T>, what: string): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      throw new Error(
        `could not read ${what} from the tournament pool at ${POOL} on chain ${CHAIN_ID} ` +
          `(rpc ${chain.rpcUrls.default.http[0]}) — is it deployed there? ` +
          `underlying: ${(e as Error).message.split('\n')[0]}`,
      )
    }
  }

  const [, name, version, chainId, verifying] = (await read(() => publicClient.readContract({
    address: getAddress(POOL),
    abi: [{
      type: 'function', name: 'eip712Domain', stateMutability: 'view', inputs: [],
      outputs: [
        { type: 'bytes1' }, { type: 'string' }, { type: 'string' },
        { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256[]' },
      ],
    }],
    functionName: 'eip712Domain',
  }), 'the EIP-712 domain')) as [string, string, string, bigint, string, string, bigint[]]

  const problems: string[] = []
  if (name !== DOMAIN_NAME) problems.push(`name: contract "${name}", server "${DOMAIN_NAME}"`)
  if (version !== DOMAIN_VERSION) {
    problems.push(`version: contract "${version}", server "${DOMAIN_VERSION}"`)
  }
  if (Number(chainId) !== CHAIN_ID) {
    problems.push(`chainId: contract ${chainId}, server ${CHAIN_ID}`)
  }
  if (getAddress(verifying) !== getAddress(POOL)) {
    problems.push(`verifyingContract: contract ${verifying}, server ${POOL}`)
  }

  const [onChainArbiter, owner, paused] = await read(() => Promise.all([
    publicClient.readContract({
      address: getAddress(POOL),
      abi: [{ type: 'function', name: 'arbiter', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }],
      functionName: 'arbiter',
    }) as Promise<`0x${string}`>,
    publicClient.readContract({
      address: getAddress(POOL),
      abi: [{ type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }],
      functionName: 'owner',
    }) as Promise<`0x${string}`>,
    publicClient.readContract({
      address: getAddress(POOL),
      abi: [{ type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] }],
      functionName: 'paused',
    }) as Promise<boolean>,
  ]), 'the arbiter and owner')

  if (!account) {
    problems.push('no arbiter key loaded')
  } else if (getAddress(onChainArbiter) !== getAddress(account.address)) {
    problems.push(
      `arbiter: contract expects ${onChainArbiter}, this server signs as ${account.address}`,
    )
  }

  if (problems.length) {
    throw new Error(
      `tournament settlement is misconfigured — every signature would be rejected:\n  ` +
        problems.join('\n  '),
    )
  }

  if (account && getAddress(owner) === getAddress(account.address)) {
    console.warn(
      '  ⚠  the tournament arbiter key is also the pool owner — one compromise loses both roles.',
    )
  }
  if (paused) console.warn('  ⚠  the tournament pool is PAUSED; no new tournaments can be created or joined.')
}

/** The pool's current fee, in basis points. */
export async function tournamentFeeBps(): Promise<number> {
  if (!POOL) throw new Error('tournament settlement not configured')
  const bps = await publicClient.readContract({
    address: getAddress(POOL),
    abi: [{ type: 'function', name: 'feeBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] }],
    functionName: 'feeBps',
  })
  return Number(bps)
}

async function tournament(id: bigint) {
  if (!POOL) throw new Error('tournament settlement not configured')
  return publicClient.readContract({
    address: getAddress(POOL),
    abi: GET_TOURNAMENT_ABI,
    functionName: 'getTournament',
    args: [id],
  })
}

/** The tournament's on-chain status, as the contract's Status enum ordinal. */
export async function tournamentStatus(id: bigint): Promise<number> {
  return Number((await tournament(id)).status)
}

/** Read the nonce from the contract, never derive it — see settle.ts. */
export async function tournamentNonce(id: bigint): Promise<bigint> {
  return (await tournament(id)).nonce
}

export async function tournamentPlayerCount(id: bigint): Promise<number> {
  return Number((await tournament(id)).playerCount)
}

/** Whether `player` actually paid into this tournament on chain. */
export async function isOnchainEntrant(id: bigint, player: `0x${string}`): Promise<boolean> {
  if (!POOL) throw new Error('tournament settlement not configured')
  return publicClient.readContract({
    address: getAddress(POOL),
    abi: IS_ENTRANT_ABI,
    functionName: 'isEntrant',
    args: [id, getAddress(player)],
  }) as Promise<boolean>
}

export async function signTournamentResult(
  tournamentId: bigint,
  winner: `0x${string}`,
  nonce: bigint,
): Promise<`0x${string}`> {
  if (!account || !POOL) throw new Error('tournament settlement not configured')
  return account.signTypedData({
    domain: domain(),
    types,
    primaryType: 'TournamentResult',
    message: { tournamentId, winner: getAddress(winner), nonce },
  })
}
