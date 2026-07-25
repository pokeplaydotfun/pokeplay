import { defineChain } from 'viem'
import { CHAIN_ID, CHAIN_LABEL, EXPLORER } from '../config'

/**
 * Robinhood Chain — Arbitrum-Orbit L2.
 *
 * Defaults to mainnet (4663). Set `VITE_CHAIN_ID=46630` plus the matching RPC
 * and explorer to point the whole app at the testnet for a dry run; nothing
 * else in the app hardcodes a chain id.
 */
const RPC = (import.meta.env.VITE_RPC_URL ??
  (CHAIN_ID === 46630
    ? 'https://rpc.testnet.chain.robinhood.com'
    : 'https://rpc.mainnet.chain.robinhood.com')) as string

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_LABEL,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [RPC] },
  },
  blockExplorers: {
    default: {
      name: 'Blockscout',
      url: EXPLORER,
    },
  },
})
