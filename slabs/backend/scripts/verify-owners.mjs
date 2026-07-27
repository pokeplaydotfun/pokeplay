#!/usr/bin/env node
/**
 * Print the current on-chain owner of each PWA contract. Read-only, no key needed.
 * Run before and after a transfer to confirm what actually changed.
 *
 *   node scripts/verify-owners.mjs
 */

import { createPublicClient, http, getAddress, defineChain } from "viem";

const CONTRACTS = {
  MirrorNFT: "0xf059E7d7C4c57b982f266F5BF1063923E486DCda",
  PackSale: "0xf061669BdF19497BD3BA666e81a098937497825D",
  Fulfiller: "0x661C59feCD07D2fA6d6C9A84AE1CC352dFE05bbb",
  Marketplace: "0xB20B6327F07d5D9A29546797F78E0d2210039f37",
};

const WORKER = "0x71a540E18651EC271B52Bd53d27f3b7EfA860EE4";
const OWNABLE_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

const rpcUrl = process.env.RH_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const rhChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const client = createPublicClient({ chain: rhChain, transport: http(rpcUrl) });

console.log(`worker hot wallet: ${getAddress(WORKER)}\n`);
for (const [name, address] of Object.entries(CONTRACTS)) {
  const owner = getAddress(
    await client.readContract({ address: getAddress(address), abi: OWNABLE_ABI, functionName: "owner" }),
  );
  const flag = owner === getAddress(WORKER) ? "  <-- still the hot worker key" : "  cold";
  console.log(`${name.padEnd(12)} ${owner}${flag}`);
}
