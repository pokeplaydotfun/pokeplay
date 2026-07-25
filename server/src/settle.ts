import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, defineChain, getAddress, http } from 'viem'

/**
 * Signs battle results for the escrow contract.
 *
 * ⚠ This key IS the arbiter. Whoever holds it can sign any result for any
 * wager and take the pot. It must live only in the server environment, never
 * in the frontend bundle, and ideally on a machine that does nothing else.
 * The contract's timeout refund is the users' protection if this key is lost;
 * it is NOT protection if the key is stolen.
 */
/**
 * Reads the arbiter key, tolerating a missing 0x prefix and stray whitespace.
 *
 * A key that is present but malformed must NOT crash the whole server — the
 * battle server runs fine without settlement, and taking the entire site down
 * (including free play) over a settlement config problem is the wrong trade.
 * A bad key disables settlement and logs loudly instead.
 */
function loadArbiter(): ReturnType<typeof privateKeyToAccount> | null {
  const raw = process.env.ARBITER_PRIVATE_KEY?.trim()
  if (!raw) return null
  const hex = (raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`
  try {
    return privateKeyToAccount(hex)
  } catch (e) {
    console.error(
      `✖ ARBITER_PRIVATE_KEY is set but not a valid private key — settlement DISABLED. ` +
        `${(e as Error).message.split('\n')[0]}`,
    )
    return null
  }
}

const ESCROW = process.env.ESCROW_ADDRESS as `0x${string}` | undefined
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 4663)

const account = loadArbiter()

// Settlement needs a VALID key and an escrow address. A malformed key leaves
// account null, so this stays false and the server runs as free-play only.
export const settlementEnabled = Boolean(account && ESCROW)

export const arbiterAddress = account?.address ?? null

/**
 * Must match `EIP712("PokePlayEscrow", "1")` in the contract exactly.
 *
 * A mismatch here does not throw anywhere — it silently produces signatures
 * the contract rejects, so every payout fails while the server reports
 * success. `verifyDomain()` checks it against the deployed contract at
 * startup rather than trusting these two strings to stay in step.
 */
const DOMAIN_NAME = 'PokePlayEscrow'
const DOMAIN_VERSION = '1'

const domain = () => ({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  chainId: CHAIN_ID,
  verifyingContract: getAddress(ESCROW!),
})

const types = {
  BattleResult: [
    { name: 'wagerId', type: 'uint256' },
    { name: 'winner', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
  DrawResult: [
    { name: 'wagerId', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

/* ------------------------------------------------------------------ */
/* nonce lookup                                                        */
/* ------------------------------------------------------------------ */

const chain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'] } },
})

const publicClient = createPublicClient({ chain, transport: http() })

const GET_WAGER_ABI = [
  {
    type: 'function',
    name: 'getWager',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [
      {
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
] as const

/**
 * Reads the wager's nonce from the contract.
 *
 * The contract keeps `wagerCount` and `nonceCounter` as separate counters that
 * happen to advance together, so today nonce == id. Deriving it from the id
 * anyway would silently produce signatures that fail to verify the moment that
 * stops being true, stranding funds until the timeout. Reading it is cheap and
 * cannot drift.
 */
/**
 * Checks that the escrow we are pointed at will actually accept our
 * signatures. Called at startup when settlement is configured.
 *
 * Both failure modes here are silent: a wrong domain or a wrong arbiter does
 * not throw anywhere in normal operation, it just makes every `settle` call
 * revert while the server happily reports success. Better to refuse to start.
 */
export async function verifySettlementConfig(): Promise<void> {
  if (!ESCROW) return
  const read = async <T,>(fn: () => Promise<T>, what: string): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      // The raw viem error buries the useful part under an ABI dump.
      throw new Error(
        `could not read ${what} from the escrow at ${ESCROW} on chain ${CHAIN_ID} ` +
          `(rpc ${chain.rpcUrls.default.http[0]}) — is it deployed there? ` +
          `underlying: ${(e as Error).message.split('\n')[0]}`,
      )
    }
  }

  const [, name, version, chainId, verifying] = (await read(() => publicClient.readContract({
    address: getAddress(ESCROW),
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
  if (getAddress(verifying) !== getAddress(ESCROW)) {
    problems.push(`verifyingContract: contract ${verifying}, server ${ESCROW}`)
  }
  // The contract only accepts signatures from the arbiter it was deployed
  // with. If our key is not that one, every settlement reverts.
  const [onChainArbiter, owner, paused] = await read(() => Promise.all([
    publicClient.readContract({
      address: getAddress(ESCROW),
      abi: [{ type: 'function', name: 'arbiter', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }],
      functionName: 'arbiter',
    }) as Promise<`0x${string}`>,
    publicClient.readContract({
      address: getAddress(ESCROW),
      abi: [{ type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }],
      functionName: 'owner',
    }) as Promise<`0x${string}`>,
    publicClient.readContract({
      address: getAddress(ESCROW),
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
      `escrow settlement is misconfigured — every signature would be rejected:\n  ` +
        problems.join('\n  '),
    )
  }

  // Not fatal, but both are worth shouting about.
  if (account && getAddress(owner) === getAddress(account.address)) {
    console.warn(
      '  ⚠  the arbiter key is also the contract owner — one compromise loses both roles.',
    )
  }
  if (paused) console.warn('  ⚠  the escrow contract is PAUSED; no new wagers can be created.')
}

/** The contract's current fee, in basis points. */
export async function currentFeeBps(): Promise<number> {
  if (!ESCROW) throw new Error('settlement not configured')
  const bps = await publicClient.readContract({
    address: getAddress(ESCROW),
    abi: [{ type: 'function', name: 'feeBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] }],
    functionName: 'feeBps',
  })
  return Number(bps)
}

/** The wager's on-chain status, as the contract's Status enum ordinal. */
export async function wagerStatus(wagerId: bigint): Promise<number> {
  if (!ESCROW) throw new Error('settlement not configured')
  const w = await publicClient.readContract({
    address: getAddress(ESCROW),
    abi: GET_WAGER_ABI,
    functionName: 'getWager',
    args: [wagerId],
  })
  return Number((w as { status: number }).status)
}

export async function wagerNonce(wagerId: bigint): Promise<bigint> {
  if (!ESCROW) throw new Error('settlement not configured')
  const w = await publicClient.readContract({
    address: getAddress(ESCROW),
    abi: GET_WAGER_ABI,
    functionName: 'getWager',
    args: [wagerId],
  })
  return w.nonce
}

export async function signResult(
  wagerId: bigint,
  winner: `0x${string}`,
  nonce: bigint,
): Promise<`0x${string}`> {
  if (!account || !ESCROW) throw new Error('settlement not configured')
  return account.signTypedData({
    domain: domain(),
    types,
    primaryType: 'BattleResult',
    message: { wagerId, winner: getAddress(winner), nonce },
  })
}

export async function signDraw(wagerId: bigint, nonce: bigint): Promise<`0x${string}`> {
  if (!account || !ESCROW) throw new Error('settlement not configured')
  return account.signTypedData({
    domain: domain(),
    types,
    primaryType: 'DrawResult',
    message: { wagerId, nonce },
  })
}
