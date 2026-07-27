/**
 * DOC 01 — T1: Collector Crypt gacha purchase interface.
 *
 * You buy one pack by hand on collectorcrypt.com with a burner wallet. This decodes what
 * actually happened on-chain: which programs were called, with what instruction data, over
 * which accounts, and where the revealed NFT landed.
 *
 * Usage:
 *   node src/verify/t1-decode-purchase.ts <tx-signature> [more signatures...]
 *
 * Pass several signatures from separate pack buys — the fields that stay constant across
 * them are the program's shape; the fields that change are the per-order arguments. That
 * difference is most of what we need to build cc/client.ts.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import "dotenv/config";
import { connection, decodeInstructions, tokenDeltas, nftsReceived, KNOWN_PROGRAMS } from "./lib/solana.ts";
import type { DecodedInstruction } from "./lib/solana.ts";

const OUT = resolve(import.meta.dirname, "../../../docs/verification/t1-purchase.json");

type TxReport = {
  signature: string;
  slot: number;
  blockTime: string | null;
  succeeded: boolean;
  fee: number;
  computeUnits: number | null;
  signers: string[];
  unknownPrograms: { programId: string; instructionCount: number }[];
  instructions: DecodedInstruction[];
  tokenMovements: ReturnType<typeof tokenDeltas>;
  nftsReceived: ReturnType<typeof nftsReceived>;
  logs: string[];
};

async function analyze(signature: string): Promise<TxReport> {
  const conn = connection();
  const tx = await conn.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx) {
    throw new Error(
      `Transaction ${signature} not found. If it is older than a few days your RPC may have ` +
        `pruned it — use an archival endpoint.`,
    );
  }

  const instructions = decodeInstructions(tx);

  const unknownCounts = new Map<string, number>();
  for (const ix of instructions) {
    if (KNOWN_PROGRAMS[ix.programId]) continue;
    unknownCounts.set(ix.programId, (unknownCounts.get(ix.programId) ?? 0) + 1);
  }

  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
    succeeded: tx.meta?.err == null,
    fee: tx.meta?.fee ?? 0,
    computeUnits: tx.meta?.computeUnitsConsumed ?? null,
    signers: tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey.toBase58()),
    unknownPrograms: [...unknownCounts.entries()]
      .map(([programId, instructionCount]) => ({ programId, instructionCount }))
      .sort((a, b) => b.instructionCount - a.instructionCount),
    instructions,
    tokenMovements: tokenDeltas(tx),
    nftsReceived: nftsReceived(tx),
    logs: tx.meta?.logMessages ?? [],
  };
}

function summarize(reports: TxReport[]) {
  console.log("\n=== T1 SUMMARY ===\n");

  for (const r of reports) {
    console.log(`${r.signature}`);
    console.log(`  slot ${r.slot}  ${r.blockTime ?? "?"}  ${r.succeeded ? "OK" : "FAILED"}`);
    console.log(`  signers: ${r.signers.join(", ")}`);

    console.log(`  candidate CC programs:`);
    if (r.unknownPrograms.length === 0) {
      console.log(`    (none — this tx only touched standard programs, so it is probably`);
      console.log(`     not the pack-open itself. Check for a separate reveal tx.)`);
    }
    for (const p of r.unknownPrograms) {
      console.log(`    ${p.programId}  (${p.instructionCount} instruction(s))`);
    }

    const paid = r.tokenMovements.filter((d) => BigInt(d.delta) < 0n && d.decimals > 0);
    for (const d of paid) {
      const amount = Number(d.delta) / 10 ** d.decimals;
      console.log(`  paid: ${amount} of mint ${d.mint} from ${d.owner}`);
    }

    if (r.nftsReceived.length > 0) {
      console.log(`  NFT(s) received IN THIS TX:`);
      for (const n of r.nftsReceived) console.log(`    ${n.mint} -> ${n.owner}`);
      console.log(`  => reveal appears SYNCHRONOUS (same tx as purchase).`);
    } else {
      console.log(`  no NFT delivered in this tx`);
      console.log(`  => reveal is ASYNCHRONOUS. Find the follow-up tx that delivers the NFT`);
      console.log(`     and re-run this script on it. This materially affects order binding`);
      console.log(`     (doc 04 §3): if the reveal is a second tx we do not control, our memo`);
      console.log(`     commitment must go in the FIRST tx and reference the order.`);
    }
    console.log();
  }

  // Cross-transaction comparison is where the interface actually falls out.
  if (reports.length > 1) {
    console.log("=== CROSS-TX COMPARISON ===\n");
    const discriminators = new Map<string, Set<string>>();
    for (const r of reports) {
      for (const ix of r.instructions) {
        if (KNOWN_PROGRAMS[ix.programId] || !ix.anchorDiscriminator) continue;
        const key = `${ix.programId}:${ix.anchorDiscriminator}`;
        if (!discriminators.has(key)) discriminators.set(key, new Set());
        discriminators.get(key)!.add(`${ix.dataLength}B`);
      }
    }
    console.log("Anchor discriminators seen (program:discriminator -> data sizes):");
    for (const [key, sizes] of discriminators) {
      console.log(`  ${key} -> ${[...sizes].join(", ")}`);
    }
    console.log(
      "\nA discriminator appearing in every purchase with a constant data size is the\n" +
        "pack-open instruction. Fixed-size data means fixed arguments — decode by diffing\n" +
        "the hex across transactions; the bytes that change are the parameters.\n",
    );
  }

  console.log("=== WHAT TO RECORD IN docs/verification-results.md ===\n");
  console.log("  [ ] CC program ID(s) and the pack-open discriminator");
  console.log("  [ ] Account list for the open instruction, and which must sign");
  console.log("  [ ] Whether ONLY the buyer signs (=> scriptable, proceed as designed)");
  console.log("      or a CC-side signature/session token appears (=> DECISION GATE, doc 01 T1)");
  console.log("  [ ] Reveal: same tx or follow-up? VRF delay? how long?");
  console.log("  [ ] Where the NFT lands (buyer ATA? escrow first?)");
  console.log("  [ ] How a sold-out machine presents on-chain (run one against an empty machine)");
  console.log();
}

async function main() {
  const signatures = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (signatures.length === 0) {
    console.error("Usage: node src/verify/t1-decode-purchase.ts <tx-signature> [...]");
    console.error("");
    console.error("Get the signature from Solscan after buying one pack by hand.");
    console.error("Pass 2-3 from separate buys — the comparison is what reveals the interface.");
    process.exit(1);
  }

  const reports: TxReport[] = [];
  for (const sig of signatures) {
    console.log(`fetching ${sig} ...`);
    reports.push(await analyze(sig));
  }

  summarize(reports);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(reports, null, 2));
  console.log(`Full decode written to ${OUT}`);
  console.log("Commit it — doc 01 requires the evidence, not just the conclusion.\n");
}

main().catch((err) => {
  console.error("\nT1 failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
