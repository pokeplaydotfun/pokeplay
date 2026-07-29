import { defineChain } from "viem";
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";

/**
 * Robinhood Chain. Values verified live against the official RPC on 2026-07-18
 * (docs/verification/verification-results.md T5): chain id 4663, ~100ms blocks,
 * gas ~0.065 gwei.
 */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: [import.meta.env.VITE_RH_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com"],
    },
  },
  // Confirmed working 2026-07-19: resolves, serves our deployed token page, and its API
  // reports 101ms blocks matching this chain. An earlier check concluded no explorer
  // existed, having guessed at hostnames rather than reading the chain registry, which is
  // where this one is actually listed. Wallets surface this URL in transaction prompts, so
  // it had to be verified rather than assumed.
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  /**
   * Multicall3, at the canonical cross-chain address.
   *
   * Verified deployed on 4663 by reading its bytecode, not assumed from the address being
   * standard. viem refuses to batch without this entry — `multicall` throws
   * ChainDoesNotSupportContract — so the marketplace's per-listing fillability reads would
   * fall back to one round trip each, or to their catch, which silently marks every stale
   * listing buyable.
   */
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

/**
 * $PWA, launched on Pons.
 *
 * Pons runs on Robinhood Chain, so once this address is set both the accrued fees and the
 * market cap are readable from the same RPC the rest of the app uses. No third-party API is
 * involved: Pons exposes none, and none is needed.
 *
 * Undefined until launch. The token page checks this rather than rendering zeroes, because a
 * zero beside "Fees earned" reads as a live token nobody is trading.
 */
export const TOKEN = {
  name: "PWA",
  ticker: "$PWA",
  address: import.meta.env.VITE_TOKEN_ADDRESS as `0x${string}` | undefined,
  /**
   * The treasury wallet's address is deliberately absent.
   *
   * It used to be published here so the burns could be checked rather than taken on trust —
   * a reasonable trade while the site named few wallets. It is gone at the operator's request:
   * a constant in this file ships in the bundle whether or not anything renders it, and the
   * burns stay verifiable from the token's own page on the explorer, which lists every
   * transfer including those to the burn address.
   */
};

/**
 * Explorer link for an address or token. Central so no page hardcodes the host.
 *
 * ⚠ `token/<contract>` 404s until the contract has minted at least once. Blockscout only
 * creates a token record when it observes a Transfer, so a freshly deployed collection with no
 * mints has no token page — verified against its API on 20 Jul: /api/v2/tokens/<new mirror>
 * returned "Not found" while the previous deployment's, which had one holder, resolved fine.
 *
 * Use `collectionUrl` for anything shown BEFORE a mint can be guaranteed. `token/` is correct
 * only where a token is known to exist, such as a card the user already holds.
 */
export const explorerUrl = (path: `address/${string}` | `token/${string}` | `tx/${string}`) =>
  `https://robinhoodchain.blockscout.com/${path}`;

/**
 * The collection on the explorer, safe to link at any time.
 *
 * Points at the ADDRESS page rather than the token page. It resolves whether or not anything
 * has been minted, shows the verified source, and grows a Tokens tab once cards exist — so it
 * is never a dead link, which the token page was for every visitor before the first mint.
 */
export const collectionUrl = (contract: string, hasMints = false) =>
  hasMints
    ? // The TOKEN page: shows the collection ("Slabs") — the ERC-721 name() and symbol() —
      // along with holders and inventory. This is the page a collector wants.
      `https://robinhoodchain.blockscout.com/token/${contract}`
    : // Before any mint there is no token record, so that page 404s. The ADDRESS page always
      // resolves, but titles itself with the SOLIDITY CONTRACT name ("MirrorNFT") rather than
      // the collection name, because that is what an address page shows. Correct but
      // developer-facing, which is the right trade only while there is nothing to collect.
      `https://robinhoodchain.blockscout.com/address/${contract}`;

/** OKX's mark as an inline data URI. See the connector below for why it is not a link. */
const OKX_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzNiAzNiI+PHJlY3Qgd2lkdGg9IjM2IiBoZWlnaHQ9IjM2IiByeD0iOCIgZmlsbD0iIzAwMCIvPjxnIGZpbGw9IiNmZmYiPjxyZWN0IHg9IjYiIHk9IjYiIHdpZHRoPSI4IiBoZWlnaHQ9IjgiLz48cmVjdCB4PSIyMiIgeT0iNiIgd2lkdGg9IjgiIGhlaWdodD0iOCIvPjxyZWN0IHg9IjE0IiB5PSIxNCIgd2lkdGg9IjgiIGhlaWdodD0iOCIvPjxyZWN0IHg9IjYiIHk9IjIyIiB3aWR0aD0iOCIgaGVpZ2h0PSI4Ii8+PHJlY3QgeD0iMjIiIHk9IjIyIiB3aWR0aD0iOCIgaGVpZ2h0PSI4Ii8+PC9nPjwvc3ZnPg==";

export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  /**
   * EIP-6963 discovery, on purpose.
   *
   * A bare `injected()` connector talks to whatever won the `window.ethereum` race — so a
   * browser with several wallet extensions installed silently opens whichever one grabbed
   * the global first, with no way to pick. EIP-6963 has each extension announce itself, so
   * wagmi can enumerate them all and the user chooses.
   *
   * The generic injected() below stays as a fallback for wallets too old to announce
   * themselves; it is filtered out of the picker whenever real providers are discovered.
   */
  multiInjectedProviderDiscovery: true,
  connectors: [
    /**
     * OKX, TARGETED EXPLICITLY.
     *
     * Discovery alone was not enough for it. EIP-6963 only lists wallets that announce
     * themselves, and OKX does not in every build — so for a user with OKX installed it could
     * be absent from the picker entirely, while the generic connector below talked to whatever
     * won the `window.ethereum` race, typically MetaMask or Trust. From the user's side that is
     * "OKX doesn't work", and nothing on screen would say otherwise.
     *
     * `window.okxwallet` is OKX's own injected provider, so this reaches it whether or not it
     * announces. Returning undefined when it is absent keeps the entry out of the picker for
     * everyone else — a wallet you do not have should not be offered.
     */
    injected({
      shimDisconnect: true,
      target: () => ({
        id: "okxWallet",
        name: "OKX Wallet",
        /**
         * OKX's mark, inlined.
         *
         * A wallet discovered through EIP-6963 supplies its own icon in the announcement, but
         * this entry is targeted explicitly and has no announcement to take one from — so it
         * rendered as a bare letter beside wallets that had logos, which reads as less
         * trustworthy precisely where trust matters.
         *
         * Drawn as an SVG data URI rather than linked: no network request, nothing to break
         * under a CSP, and no dependency on a host we do not control.
         */
        icon: OKX_ICON,
        provider: (window as { okxwallet?: unknown }).okxwallet as never,
      }),
    }),
    injected({ shimDisconnect: true }),
  ],
  transports: { [robinhoodChain.id]: http() },
});

/**
 * Contract addresses. Unset until deployment, which is the honest default — the app falls
 * back to preview mode rather than pointing a Buy button at address zero.
 *
 * USDG is verified: 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 ("Global Dollar", 6dp).
 */
export const USDG_MAINNET = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;

export const CONTRACTS = {
  /**
   * Verified on-chain 2026-07-18: "Global Dollar", symbol USDG, 6 decimals, chain 4663
   * (verification-results T5). A public token address, so it is a sane default rather than
   * something that must be supplied at build time — without it the balance read is disabled
   * and the wallet shows no balance at all.
   */
  usdg: (import.meta.env.VITE_USDG_ADDRESS ?? USDG_MAINNET) as `0x${string}`,
  // POKEPLAY collection — redeployed to Robinhood Chain mainnet 2026-07-28 (renamed
  // MirrorNFT to POKEPLAY/PLAY; all four contracts redeployed since the address is
  // baked immutably into PackSale/Fulfiller/Marketplace). Public addresses, safe as
  // build-time defaults; an env var still overrides for a different deployment.
  packSale: (import.meta.env.VITE_PACK_SALE_ADDRESS ??
    "0x93BDe960A2211F923429BD4ea6303BC24C1D29Da") as `0x${string}`,
  mirror: (import.meta.env.VITE_MIRROR_ADDRESS ??
    "0xED4037BC60ff1FBA0c74461B3Cc9aa6DE7eE59e5") as `0x${string}`,
  marketplace: (import.meta.env.VITE_MARKETPLACE_ADDRESS ??
    "0x6cb067aCC19831f4775A7F54152E6b0A2C5B397C") as `0x${string}`,
};

/** True only when we can actually transact. Everything else degrades to preview. */
export const CAN_TRANSACT = Boolean(CONTRACTS.usdg && CONTRACTS.packSale);

/** Secondary trading has its own switch: the marketplace can go live after the sale does. */
export const CAN_TRADE = Boolean(CONTRACTS.usdg && CONTRACTS.marketplace && CONTRACTS.mirror);

declare global {
  interface Window {
    ethereum?: unknown;
  }
}

export const hasInjectedWallet = () => typeof window !== "undefined" && Boolean(window.ethereum);
