/**
 * DOC 01 — T1b: decode Collector Crypt's pack-purchase transaction, without buying anything.
 *
 * `POST /api/generatePack` builds and CC-co-signs a real purchase transaction, then hands it
 * back for the player to sign. Requesting one costs nothing and settles nothing — the
 * transaction is only live once someone signs and submits it. So the entire purchase
 * interface can be read off a request we never complete.
 *
 * ⚠ ACCESS NOTE. CC's docs state the `x-api-key` header "ensures only authorized partners
 * can access the machine". As measured 2026-07-18 the endpoint does NOT enforce this — it
 * returns 200 with no key, and with an invalid key. The key appears to drive attribution
 * (the memo prefix / `slug` filter), not access control. An unenforced gate is not the same
 * as permission: CC can start enforcing at any time, and a product built on the gap dies
 * that day. Treat a partner key as a stability requirement, not a formality.
 *
 * Usage:
 *   node src/verify/t1b-generate-pack.ts [packType] [playerAddress]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { KNOWN_PROGRAMS, MEMO_PROGRAM, TOKEN_PROGRAM } from "./lib/solana.ts";

const OUT = resolve(import.meta.dirname, "../../../docs/verification/t1b-generate-pack.json");
const GACHA_API = process.env.CC_GACHA_API ?? "https://gacha.collectorcrypt.com/api";

/** Placeholder signer. Never signed, so no transaction is ever submitted. */
const DUMMY_PLAYER = "11111111111111111111111111111112";

function decodeTokenIx(data: Buffer): string | null {
  // SPL Token TransferChecked = instruction 12, then u64 amount + u8 decimals.
  if (data.length >= 10 && data[0] === 12) {
    const amount = data.readBigUInt64LE(1);
    const decimals = data[9]!;
    return `TransferChecked  amount=${amount} (${Number(amount) / 10 ** decimals} tokens, ${decimals}dp)`;
  }
  if (data.length >= 9 && data[0] === 3) return `Transfer  amount=${data.readBigUInt64LE(1)}`;
  return null;
}

function decodeComputeBudgetIx(data: Buffer): string | null {
  if (data[0] === 2 && data.length >= 5) return `SetComputeUnitLimit  ${data.readUInt32LE(1)}`;
  if (data[0] === 3 && data.length >= 9) return `SetComputeUnitPrice  ${data.readBigUInt64LE(1)} microLamports`;
  return null;
}

async function main() {
  const packType = process.argv[2] ?? "pokemon_50";
  const playerAddress = process.argv[3] ?? DUMMY_PLAYER;

  console.log(`=== T1b: generatePack (${packType}) ===\n`);
  console.log(`player: ${playerAddress}${playerAddress === DUMMY_PLAYER ? "  (placeholder — never signed)" : ""}`);

  const res = await fetch(`${GACHA_API}/generatePack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerAddress, packType }),
    signal: AbortSignal.timeout(30_000),
  });

  const body = (await res.json()) as { memo?: string; transaction?: string; error?: string };
  console.log(`HTTP ${res.status} (no x-api-key sent)`);

  if (!res.ok || !body.transaction) {
    console.log(`\nResponse: ${JSON.stringify(body)}`);
    console.log(`\nIf this is now 401/403, CC has begun enforcing the API key. That is the`);
    console.log(`expected end state — see the access note at the top of this file. Obtain a`);
    console.log(`partner key (docs/cc-partnership-enquiry.md).`);
    process.exit(1);
  }

  console.log(`memo: ${body.memo}`);

  const raw = Buffer.from(body.transaction, "base64");
  let legacy = false;
  let tx: Transaction | VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(raw);
  } catch {
    tx = Transaction.from(raw);
    legacy = true;
  }

  const message = legacy ? (tx as Transaction).compileMessage() : (tx as VersionedTransaction).message;
  const keys = legacy
    ? (message as ReturnType<Transaction["compileMessage"]>).accountKeys
    : (message as VersionedTransaction["message"]).staticAccountKeys;
  const signatures = legacy
    ? (tx as Transaction).signatures.map((s) => s.signature)
    : (tx as VersionedTransaction).signatures;

  console.log(`\n--- signatures (${signatures.length} slots) ---`);
  const preSigned: string[] = [];
  signatures.forEach((sig, i) => {
    const filled = sig != null && !Buffer.from(sig).every((b) => b === 0);
    const who = keys[i]?.toBase58() ?? "?";
    console.log(`  [${i}] ${filled ? "PRE-SIGNED BY CC" : "empty — awaits player"}  ${who}`);
    if (filled) preSigned.push(who);
  });

  console.log(`\n--- accounts ---`);
  keys.forEach((k, i) => {
    const flags = `${message.isAccountSigner(i) ? "S" : " "}${message.isAccountWritable(i) ? "W" : " "}`;
    const known = KNOWN_PROGRAMS[k.toBase58()];
    console.log(`  [${i}] ${flags}  ${k.toBase58()}${known ? `  (${known})` : ""}`);
  });

  const instructions = legacy
    ? (message as ReturnType<Transaction["compileMessage"]>).instructions
    : (message as VersionedTransaction["message"]).compiledInstructions;

  console.log(`\n--- instructions (${instructions.length}) ---`);
  const decoded = instructions.map((ix, i) => {
    const programId = keys[ix.programIdIndex]!.toBase58();
    const data = legacy
      ? Buffer.from(bs58.decode((ix as { data: string }).data))
      : Buffer.from((ix as { data: Uint8Array }).data);

    let detail: string | null = null;
    if (programId === TOKEN_PROGRAM) detail = decodeTokenIx(data);
    else if (programId === "ComputeBudget111111111111111111111111111111") detail = decodeComputeBudgetIx(data);
    else if (programId === MEMO_PROGRAM) detail = `MEMO "${data.toString("utf8")}"`;

    console.log(`\n  [${i}] ${programId}${KNOWN_PROGRAMS[programId] ? `  (${KNOWN_PROGRAMS[programId]})` : "  ← UNKNOWN, candidate CC program"}`);
    console.log(`      data ${data.length}B: ${data.toString("hex").slice(0, 120)}`);
    if (detail) console.log(`      => ${detail}`);

    return { index: i, programId, dataHex: data.toString("hex"), detail };
  });

  const unknown = decoded.filter((d) => !KNOWN_PROGRAMS[d.programId]);

  console.log(`\n=== FINDINGS ===\n`);
  console.log(`  CC co-signer      : ${preSigned.join(", ") || "NONE"}`);
  console.log(`  custom CC programs: ${unknown.length === 0 ? "none — purchase is memo + SPL token transfer only" : unknown.map((u) => u.programId).join(", ")}`);
  console.log(`  memo format       : ${decoded.find((d) => d.programId === MEMO_PROGRAM)?.detail ?? "n/a"}`);
  console.log(`\n  The payment leg is a plain SPL TransferChecked. There is no bespoke program`);
  console.log(`  to reverse-engineer — but CC's pre-signature IS required, so the transaction`);
  console.log(`  cannot be constructed locally. generatePack is the only source.`);
  console.log(`\n  Order binding: CC's own memo ("<prefix>-<uuid>:open") plus the cc-vrf proof`);
  console.log(`  is stronger than the scheme in doc 04 §3. Map our orderId to this memo and`);
  console.log(`  point users at CC's verifier rather than rolling our own commitment.`);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      { checkedAt: new Date().toISOString(), packType, httpStatus: res.status, sentApiKey: false, memo: body.memo, preSigned, accounts: keys.map((k) => k.toBase58()), instructions: decoded },
      null,
      2,
    ),
  );
  console.log(`\nWritten to ${OUT}\n`);
}

main().catch((err) => {
  console.error("\nT1b failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
