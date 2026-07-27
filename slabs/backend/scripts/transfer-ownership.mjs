#!/usr/bin/env node
/**
 * Hand ownership of the four PWA contracts from the worker hot key to a cold admin wallet.
 *
 * WHY: every contract is currently owned by the worker key, which sits in the server .env and
 * auto-signs. That one key can set pack prices, sweepSurplus, redirect revenue and swap the
 * fulfiller. Moving ownership to a cold wallet means a leak of the server key can grief but
 * cannot drain or reconfigure. The worker keeps every role it needs to RUN — drawer,
 * Fulfiller caller, quote signer, guardian — none of which is owner-gated.
 *
 * RUN THIS ON THE SERVER, where WORKER_PRIVATE_KEY already lives. The key is read from the
 * environment and never passed on a command line or printed.
 *
 *   DB_PATH unused here. Needs: WORKER_PRIVATE_KEY, RH_RPC_URL (both already in the server env)
 *
 *   node script/transfer-ownership.mjs <newOwner> --only mirror       # one contract
 *   node script/transfer-ownership.mjs <newOwner> --all               # all four
 *
 * SAFETY:
 *   - transferOwnership is single-step and irreversible. Verify the address with
 *     verify-address-control.mjs FIRST.
 *   - Refuses unless the contract's current owner is exactly the worker key (so a re-run after
 *     a partial transfer is a no-op on the ones already moved, not an error that hides them).
 *   - Confirms owner() actually changed before reporting success.
 *   - Default is one contract at a time. Do `mirror` first, confirm the site still works and
 *     the worker still mints, then do the rest — blast radius of a surprise is one contract.
 */

import { createWalletClient, createPublicClient, http, getAddress, isAddress, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CONTRACTS = {
  mirror: { name: "MirrorNFT", address: "0xf059E7d7C4c57b982f266F5BF1063923E486DCda" },
  packsale: { name: "PackSale", address: "0xf061669BdF19497BD3BA666e81a098937497825D" },
  fulfiller: { name: "Fulfiller", address: "0x661C59feCD07D2fA6d6C9A84AE1CC352dFE05bbb" },
  marketplace: { name: "Marketplace", address: "0xB20B6327F07d5D9A29546797F78E0d2210039f37" },
};

const OWNABLE_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "transferOwnership",
    stateMutability: "nonpayable",
    inputs: [{ name: "newOwner", type: "address" }],
    outputs: [],
  },
];

const args = process.argv.slice(2);
const newOwnerArg = args.find((a) => a.startsWith("0x"));
const all = args.includes("--all");
const onlyKey = (() => {
  const i = args.indexOf("--only");
  return i !== -1 ? args[i + 1] : null;
})();

if (!newOwnerArg || (!all && !onlyKey)) {
  console.error("usage: node script/transfer-ownership.mjs <newOwner> (--only <mirror|packsale|fulfiller|marketplace> | --all)");
  process.exit(2);
}
if (!isAddress(newOwnerArg)) {
  console.error(`not a valid address: ${newOwnerArg}`);
  process.exit(1);
}
const newOwner = getAddress(newOwnerArg);

const pk = process.env.WORKER_PRIVATE_KEY;
if (!pk) {
  console.error("WORKER_PRIVATE_KEY not in the environment. Run this on the server.");
  process.exit(1);
}
const rpcUrl = process.env.RH_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const worker = account.address;

// Chain 4663; a minimal definition is enough for eth_call and sending.
const rhChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

const publicClient = createPublicClient({ chain: rhChain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain: rhChain, transport: http(rpcUrl) });

// A wallet cannot hand ownership to itself by mistake and think it did something.
if (getAddress(newOwner) === getAddress(worker)) {
  console.error("newOwner is the worker key itself — that is the thing we are moving AWAY from.");
  process.exit(1);
}

const targets = all ? Object.keys(CONTRACTS) : [onlyKey];
for (const key of targets) {
  const c = CONTRACTS[key];
  if (!c) {
    console.error(`unknown contract: ${key}`);
    process.exit(1);
  }
}

console.log(`worker (current owner, signer) : ${worker}`);
console.log(`new cold owner                 : ${newOwner}`);
console.log(`contracts                      : ${targets.join(", ")}\n`);

for (const key of targets) {
  const c = CONTRACTS[key];
  const address = getAddress(c.address);

  const current = getAddress(
    await publicClient.readContract({ address, abi: OWNABLE_ABI, functionName: "owner" }),
  );

  if (current === newOwner) {
    console.log(`${c.name}: already owned by the cold wallet. Skipping.`);
    continue;
  }
  if (current !== getAddress(worker)) {
    // Not the worker and not the target: something we did not expect owns it. Do not touch it.
    console.error(`${c.name}: current owner is ${current}, not the worker. Refusing to transfer — investigate first.`);
    process.exit(1);
  }

  process.stdout.write(`${c.name}: transferring ${current} -> ${newOwner} ... `);
  const hash = await walletClient.writeContract({
    address,
    abi: OWNABLE_ABI,
    functionName: "transferOwnership",
    args: [newOwner],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    console.error(`\n${c.name}: transaction reverted (${hash}). Owner unchanged.`);
    process.exit(1);
  }

  const after = getAddress(
    await publicClient.readContract({ address, abi: OWNABLE_ABI, functionName: "owner" }),
  );
  if (after !== newOwner) {
    console.error(`\n${c.name}: tx succeeded but owner is ${after}, not ${newOwner}. STOP and investigate.`);
    process.exit(1);
  }
  console.log(`ok  (tx ${hash})`);
}

console.log("\nDone. Verify independently with:  node script/verify-owners.mjs");
