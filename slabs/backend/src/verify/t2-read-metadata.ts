/**
 * DOC 01 — T2: reading a revealed card's metadata.
 *
 * Everything our pricing depends on comes from here. Cert number, grade and card name are
 * cosmetic; INSURED VALUE is load-bearing — it is the base for both the buyback math and
 * the unwrap fee. This script finds it, or proves it is not on-chain.
 *
 * Usage:
 *   node src/verify/t2-read-metadata.ts <nft-mint-address> [more mints...]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import "dotenv/config";
import { connection, METAPLEX_METADATA_PROGRAM } from "./lib/solana.ts";

const OUT = resolve(import.meta.dirname, "../../../docs/verification/t2-metadata.json");

/** Words that plausibly denote the insured value in an attribute trait_type or JSON key. */
const INSURED_VALUE_HINTS = [
  "insured",
  "insurance",
  "value",
  "valuation",
  "appraisal",
  "appraised",
  "price",
  "worth",
  "usd",
];

function metadataPda(mint: PublicKey): PublicKey {
  const program = new PublicKey(METAPLEX_METADATA_PROGRAM);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), program.toBuffer(), mint.toBuffer()],
    program,
  );
  return pda;
}

/** Minimal Metaplex Metadata decoder — we only need the header and the URI. */
function decodeMetadata(data: Buffer) {
  let offset = 0;
  const key = data.readUInt8(offset);
  offset += 1;
  const updateAuthority = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const mint = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32;

  const readString = () => {
    const len = data.readUInt32LE(offset);
    offset += 4;
    const raw = data.subarray(offset, offset + len).toString("utf8");
    offset += len;
    // Metaplex pads fixed-width string fields with NULs.
    return raw.replace(/\0+$/, "").trim();
  };

  const name = readString();
  const symbol = readString();
  const uri = readString();
  const sellerFeeBasisPoints = data.readUInt16LE(offset);

  return { key, updateAuthority, mint, name, symbol, uri, sellerFeeBasisPoints };
}

type Finding = { path: string; value: unknown };

/** Walks arbitrary JSON looking for anything that smells like a dollar valuation. */
function findValueCandidates(json: unknown, path = "$"): Finding[] {
  const out: Finding[] = [];

  const looksLikeValue = (label: string) => {
    const l = label.toLowerCase();
    return INSURED_VALUE_HINTS.some((h) => l.includes(h));
  };

  const walk = (node: unknown, p: string) => {
    if (node == null) return;

    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        // Metaplex attributes: [{trait_type, value}]
        if (item && typeof item === "object" && "trait_type" in item) {
          const trait = String((item as Record<string, unknown>).trait_type ?? "");
          if (looksLikeValue(trait)) {
            out.push({ path: `${p}[${i}].${trait}`, value: (item as Record<string, unknown>).value });
          }
        }
        walk(item, `${p}[${i}]`);
      });
      return;
    }

    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (looksLikeValue(k) && (typeof v === "string" || typeof v === "number")) {
          out.push({ path: `${p}.${k}`, value: v });
        }
        walk(v, `${p}.${k}`);
      }
    }
  };

  walk(json, path);
  return out;
}

async function analyze(mintAddress: string) {
  const conn = connection();
  const mint = new PublicKey(mintAddress);
  const pda = metadataPda(mint);

  const account = await conn.getAccountInfo(pda);
  if (!account) {
    throw new Error(
      `No Metaplex metadata account for mint ${mintAddress}. It may be a compressed NFT ` +
        `(Bubblegum) — if so, read it via the DAS API (getAsset) instead, and note that in ` +
        `the results: compressed NFTs change how custody and transfer work.`,
    );
  }

  const onChain = decodeMetadata(Buffer.from(account.data));

  let offChain: unknown = null;
  let offChainError: string | null = null;
  if (onChain.uri) {
    try {
      const res = await fetch(onChain.uri, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      offChain = await res.json();
    } catch (err) {
      offChainError = err instanceof Error ? err.message : String(err);
    }
  }

  const candidates = offChain ? findValueCandidates(offChain) : [];

  return { mint: mintAddress, metadataPda: pda.toBase58(), onChain, offChain, offChainError, insuredValueCandidates: candidates };
}

async function main() {
  const mints = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (mints.length === 0) {
    console.error("Usage: node src/verify/t2-read-metadata.ts <nft-mint-address> [...]");
    console.error("");
    console.error("Get the mint from the T1 output ('NFT(s) received IN THIS TX').");
    process.exit(1);
  }

  const results = [];
  for (const m of mints) {
    console.log(`reading ${m} ...`);
    results.push(await analyze(m));
  }

  console.log("\n=== T2 SUMMARY ===\n");
  for (const r of results) {
    console.log(`${r.mint}`);
    console.log(`  name           : ${r.onChain.name}`);
    console.log(`  symbol         : ${r.onChain.symbol}`);
    console.log(`  updateAuthority: ${r.onChain.updateAuthority}`);
    console.log(`  uri            : ${r.onChain.uri || "(none)"}`);

    if (r.offChainError) {
      console.log(`  off-chain JSON : FAILED (${r.offChainError})`);
      console.log(`    => if the URI is unreachable or gated, our metadata cache cannot rely`);
      console.log(`       on it. Record this; it changes doc 04 §4.`);
    }

    if (r.insuredValueCandidates.length > 0) {
      console.log(`  insured-value candidates:`);
      for (const c of r.insuredValueCandidates) {
        console.log(`    ${c.path} = ${JSON.stringify(c.value)}`);
      }
    } else if (r.offChain) {
      console.log(`  insured-value candidates: NONE FOUND`);
      console.log(`    => DECISION POINT. Insured value is not in the NFT metadata, so it must`);
      console.log(`       come from a CC web endpoint. That puts a scraped value underneath`);
      console.log(`       our entire pricing model — capture the endpoint, and add the`);
      console.log(`       staleness guard (doc 04 §4: pause sells if the value is >10 min old).`);
    }
    console.log();
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`Full metadata written to ${OUT}`);

  console.log("\n=== STILL TO CHECK BY HAND ===\n");
  console.log("  [ ] Does insured value CHANGE over time? Re-run this script on the same mint");
  console.log("      in 24h and diff. Our quotes must refresh if it moves (doc 04 §4).");
  console.log("  [ ] Do cert number and grade appear? They go in the mirror tokenURI.");
  console.log("  [ ] Is the image a real photo of the physical card? Only those may be shown");
  console.log("      in our UI (doc 00 §7 — no Pokemon trade dress).");
  console.log();
}

main().catch((err) => {
  console.error("\nT2 failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
