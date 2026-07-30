/**
 * What "Fees generated" would open at for a given token + fee wallet.
 *
 *   node scripts/pons-opening-fees.mjs <tokenAddress> <feeWallet>
 *
 * Prints the WETH total, in wei, that the token page would show the moment it goes live.
 * Zero is the only honest opening figure for a token that has not traded yet.
 *
 * This exists because the number is NOT obvious: the Pons locker is shared by every token it
 * has ever launched, and `slabs/backend/src/pons.ts` credits the fee wallet with every WETH
 * transfer out of the locker or out of our own pool. So a fee wallet that already collects
 * fees for some OTHER token opens this token's page at that token's lifetime earnings.
 *
 * Deliberately mirrors `PonsReader.feesWei()` — same sources, same start block, same filter —
 * so what this prints is what the dashboard will report, not an approximation of it.
 *
 * ⚠ Written against viem rather than `cast logs`, because cast silently dropped the second
 * topic on this RPC: filtering from=locker AND to=wallet came back "logs matched by query
 * exceeds limit of 10000" (i.e. it had matched every locker transfer to anybody), and a guard
 * that swallows that error reports a dirty wallet as clean. Verified: this script finds the
 * 0.1076 WETH on a wallet that cast reported as having none.
 */
import { createPublicClient, http, parseAbi } from "viem";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const LOCKER = "0x736D76699C26D0d966744cAe304C000d471f7F35";
const V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
/** Pons factory deployment. Nothing earlier can be a Pons fee payment. */
const FACTORY_START = 8991118n;

const token = process.argv[2];
const feeWallet = process.argv[3];
if (!/^0x[0-9a-fA-F]{40}$/.test(token ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(feeWallet ?? "")) {
  console.error("usage: node scripts/pons-opening-fees.mjs <tokenAddress> <feeWallet>");
  process.exit(2);
}

const client = createPublicClient({ transport: http(RPC) });

const factoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
]);

let pool = null;
for (const fee of [500, 3000, 10000]) {
  try {
    const found = await client.readContract({
      address: V3_FACTORY,
      abi: factoryAbi,
      functionName: "getPool",
      args: [token, WETH, fee],
    });
    if (found && found !== "0x0000000000000000000000000000000000000000") {
      pool = found;
      break;
    }
  } catch {
    // Only one tier exists; try the next rather than failing on the empty ones.
  }
}

// The `to` filter is indexed and narrow, so this one wide scan is cheap. The source filter is
// applied afterwards in code, exactly as the reader does it.
const logs = await client.getLogs({
  address: WETH,
  event: {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
  args: { to: feeWallet },
  fromBlock: FACTORY_START,
  toBlock: await client.getBlockNumber(),
});

const sources = [LOCKER.toLowerCase(), pool?.toLowerCase()].filter(Boolean);
let wei = 0n;
let count = 0;
for (const log of logs) {
  if (!sources.includes(String(log.args.from).toLowerCase())) continue;
  wei += log.args.value ?? 0n;
  count += 1;
}

// Machine-readable first line, so the shell guard can branch on it without parsing prose.
console.log(`WEI=${wei}`);
console.log(`PAYMENTS=${count}`);
console.log(`POOL=${pool ?? "none"}`);
console.log(`ETH=${Number(wei) / 1e18}`);
