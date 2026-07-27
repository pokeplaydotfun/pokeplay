/**
 * DOC 01 — T3: buyback mechanics + the bypass test. DECISION GATE.
 *
 * Two questions:
 *   A. Is CC's standing buyback quote executable from a script?
 *   B. Does the buyback right travel with the NFT, or is it bound to the pulling wallet?
 *
 * (B) decides whether unwraps are free forever or carry a 5% in-window fee — i.e. whether
 * the EIP-712 quote path in MirrorNFT stays or gets deleted. Do not guess it.
 *
 * Usage:
 *   node src/verify/t3-buyback.ts plan                     # print the manual procedure
 *   node src/verify/t3-buyback.ts decode <sell-tx-sig>     # decode a completed sell
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import "dotenv/config";
import { connection, decodeInstructions, tokenDeltas, KNOWN_PROGRAMS } from "./lib/solana.ts";

const OUT = resolve(import.meta.dirname, "../../../docs/verification/t3-buyback.json");

function plan() {
  console.log(`
=== T3 PROCEDURE ===

Budget two cards. Wallet A and wallet B are both burners you control.

QUESTION A — is the sell scriptable?
  1. Pull card #1 with wallet A.
  2. Sell it back to CC through their UI.
  3. node src/verify/t3-buyback.ts decode <sell-tx-signature>
  4. Record: program ID, discriminator, accounts, who signs, quote amount received.
  5. Attempt the same sell from a script on card #2. If it works without touching their
     web app, the buyback engine (doc 04, Flow B) is buildable as designed.

QUESTION B — THE BYPASS TEST (this is the one that changes the product)
  1. Pull card #2 with wallet A. Do NOT sell it.
  2. Transfer the NFT from wallet A to wallet B.
  3. From wallet B, attempt the buyback INSIDE the 72h window.

  Outcome 1 — wallet B CANNOT sell:
    The buyback right is bound to the pulling wallet. Nobody can bypass our spread by
    unwrapping, so:
      -> set UNWRAP_FEE_DURING_WINDOW_BPS = 0 permanently
      -> unwraps are free, always (better product, simpler UI)
      -> DELETE the EIP-712 unwrap-quote path from MirrorNFT.sol rather than shipping
         dead code in an unaudited contract
    BUT ALSO CHECK: if the right is bound to the pulling wallet, then OUR custody wallet
    is the pulling wallet — confirm we can still sell from custody. If we cannot, the
    entire buyback business model does not work and the project needs rethinking BEFORE
    any contract goes to mainnet.

  Outcome 2 — wallet B CAN sell:
    The right travels with the NFT. A user could unwrap and sell to CC directly, keeping
    the 5pp we would have earned. Keep the in-window unwrap fee:
      -> mirror.setUnwrapFeeBps(500)
      -> the EIP-712 quote path stays and must be exercised in the mainnet dry-run

ALSO RECORD (both outcomes):
  [ ] exact quote percentage(s) observed, vs the card's insured value
  [ ] whether the quote is readable on-chain or only from CC's site
  [ ] whether a quote can move DOWN mid-window (drives QUOTE_DRIFT_REVALIDATE_BPS)
  [ ] precise window expiry semantics: 72h from what timestamp exactly?
      Our 66h user window is computed from the reveal — confirm CC measures from the same
      event, or our 6h safety margin is measured against the wrong clock.
`);
}

async function decode(signature: string) {
  const conn = connection();
  const tx = await conn.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx) throw new Error(`Transaction ${signature} not found (try an archival RPC).`);

  const instructions = decodeInstructions(tx);
  const movements = tokenDeltas(tx);
  const unknown = instructions.filter((ix) => !KNOWN_PROGRAMS[ix.programId]);

  console.log("\n=== T3 SELL DECODE ===\n");
  console.log(`signature: ${signature}`);
  console.log(`status   : ${tx.meta?.err == null ? "OK" : "FAILED — " + JSON.stringify(tx.meta?.err)}`);
  console.log(`signers  : ${tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey.toBase58()).join(", ")}`);

  console.log(`\nCC program instructions:`);
  for (const ix of unknown) {
    console.log(`  ${ix.programId}  discriminator=${ix.anchorDiscriminator ?? "n/a"}  data=${ix.dataLength}B`);
    for (const a of ix.accounts ?? []) {
      console.log(`      ${a.signer ? "S" : " "}${a.writable ? "W" : " "}  ${a.pubkey}`);
    }
  }

  console.log(`\nvalue movements:`);
  for (const d of movements) {
    const amount = Number(d.delta) / 10 ** d.decimals;
    console.log(`  ${amount > 0 ? "+" : ""}${amount}  mint ${d.mint}  owner ${d.owner}`);
  }

  const nftOut = movements.find((d) => d.decimals === 0 && d.delta === "-1");
  const usdcIn = movements.find((d) => d.decimals > 0 && BigInt(d.delta) > 0n);
  if (nftOut && usdcIn) {
    const proceeds = Number(usdcIn.delta) / 10 ** usdcIn.decimals;
    console.log(`\n=> sold NFT ${nftOut.mint} for ${proceeds} of mint ${usdcIn.mint}`);
    console.log(`   Compare against that card's insured value (T2) to get CC's actual quote %.`);
    console.log(`   Our user rate = that percentage MINUS 5pp. Never hardcode the result —`);
    console.log(`   doc 00 §2 requires it be fetched live at sell time.`);
  }

  const extraSigners = tx.transaction.message.accountKeys.filter((k) => k.signer).length;
  console.log(`\nsigner count: ${extraSigners}`);
  if (extraSigners > 1) {
    console.log(`  WARNING: more than one signer. If a CC-side key must co-sign, the sell is`);
    console.log(`  NOT scriptable from our wallet alone — that is a DECISION GATE (doc 01 T3).`);
  } else {
    console.log(`  Single signer — consistent with a scriptable, permissionless sell.`);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ signature, instructions, movements }, null, 2));
  console.log(`\nWritten to ${OUT}\n`);
}

const [command, arg] = process.argv.slice(2);
if (command === "plan" || !command) {
  plan();
} else if (command === "decode" && arg) {
  decode(arg).catch((err) => {
    console.error("\nT3 failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else {
  console.error("Usage: node src/verify/t3-buyback.ts plan | decode <sell-tx-sig>");
  process.exit(1);
}
