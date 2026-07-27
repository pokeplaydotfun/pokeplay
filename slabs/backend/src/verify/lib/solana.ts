import { Connection, PublicKey } from "@solana/web3.js";
import type { ParsedTransactionWithMeta, PartiallyDecodedInstruction, ParsedInstruction } from "@solana/web3.js";
import bs58 from "bs58";

export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const METAPLEX_METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

/// Programs we already understand. Anything outside this set on a Collector Crypt
/// transaction is, by definition, part of what T1 is trying to identify.
export const KNOWN_PROGRAMS: Record<string, string> = {
  [MEMO_PROGRAM]: "SPL Memo",
  [TOKEN_PROGRAM]: "SPL Token",
  [TOKEN_2022_PROGRAM]: "SPL Token-2022",
  [ASSOCIATED_TOKEN_PROGRAM]: "Associated Token Account",
  [SYSTEM_PROGRAM]: "System",
  [METAPLEX_METADATA_PROGRAM]: "Metaplex Token Metadata",
  [COMPUTE_BUDGET_PROGRAM]: "Compute Budget",
};

export function connection(): Connection {
  const url = process.env.SOLANA_RPC_URL;
  if (!url) {
    throw new Error(
      "SOLANA_RPC_URL is not set. Use a Helius/QuickNode endpoint — the public " +
        "api.mainnet-beta.solana.com will rate-limit these scripts into uselessness.",
    );
  }
  return new Connection(url, "confirmed");
}

export type DecodedInstruction = {
  index: number;
  inner: boolean;
  programId: string;
  programName: string;
  /** Present for programs the RPC could parse (SPL Token, System, Memo, ...). */
  parsed?: unknown;
  /** Raw instruction data, for programs nobody can parse for us — i.e. CC's own. */
  dataBase58?: string;
  dataHex?: string;
  /** First 8 bytes, hex. Anchor programs use this as the instruction discriminator. */
  anchorDiscriminator?: string;
  dataLength?: number;
  accounts?: { pubkey: string; signer: boolean; writable: boolean }[];
};

function isParsed(ix: ParsedInstruction | PartiallyDecodedInstruction): ix is ParsedInstruction {
  return "parsed" in ix;
}

export function decodeInstructions(tx: ParsedTransactionWithMeta): DecodedInstruction[] {
  const accountKeys = tx.transaction.message.accountKeys;
  const flags = new Map(
    accountKeys.map((k) => [k.pubkey.toBase58(), { signer: k.signer, writable: k.writable }]),
  );

  const decode = (
    ix: ParsedInstruction | PartiallyDecodedInstruction,
    index: number,
    inner: boolean,
  ): DecodedInstruction => {
    const programId = ix.programId.toBase58();
    const base = {
      index,
      inner,
      programId,
      programName: KNOWN_PROGRAMS[programId] ?? "UNKNOWN — candidate Collector Crypt program",
    };

    if (isParsed(ix)) {
      return { ...base, parsed: ix.parsed };
    }

    const raw = bs58.decode(ix.data);
    const hex = Buffer.from(raw).toString("hex");
    return {
      ...base,
      dataBase58: ix.data,
      dataHex: hex,
      // Anchor's convention: sha256("global:<method>")[0..8]. Having this lets us match
      // instructions across transactions even before we know the method names.
      anchorDiscriminator: raw.length >= 8 ? hex.slice(0, 16) : undefined,
      dataLength: raw.length,
      accounts: ix.accounts.map((a) => {
        const key = a.toBase58();
        const f = flags.get(key);
        return { pubkey: key, signer: f?.signer ?? false, writable: f?.writable ?? false };
      }),
    };
  };

  const out: DecodedInstruction[] = [];
  tx.transaction.message.instructions.forEach((ix, i) => out.push(decode(ix, i, false)));
  (tx.meta?.innerInstructions ?? []).forEach((group) => {
    group.instructions.forEach((ix, i) => out.push(decode(ix, group.index * 100 + i, true)));
  });
  return out;
}

export type TokenDelta = {
  owner: string;
  mint: string;
  decimals: number;
  before: string;
  after: string;
  delta: string;
};

/** What actually moved. The USDC leg tells us the real pack price; a 0 -> 1 delta on a
 *  fresh mint is the revealed NFT landing. */
export function tokenDeltas(tx: ParsedTransactionWithMeta): TokenDelta[] {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const key = (b: { accountIndex: number; mint: string }) => `${b.accountIndex}:${b.mint}`;

  const preMap = new Map(pre.map((b) => [key(b), b]));
  const seen = new Set<string>();
  const deltas: TokenDelta[] = [];

  const push = (b: (typeof post)[number], before: string) => {
    const after = b.uiTokenAmount.amount;
    if (before === after) return;
    deltas.push({
      owner: b.owner ?? "unknown",
      mint: b.mint,
      decimals: b.uiTokenAmount.decimals,
      before,
      after,
      delta: (BigInt(after) - BigInt(before)).toString(),
    });
  };

  for (const b of post) {
    seen.add(key(b));
    push(b, preMap.get(key(b))?.uiTokenAmount.amount ?? "0");
  }
  for (const b of pre) {
    if (seen.has(key(b))) continue;
    deltas.push({
      owner: b.owner ?? "unknown",
      mint: b.mint,
      decimals: b.uiTokenAmount.decimals,
      before: b.uiTokenAmount.amount,
      after: "0",
      delta: (-BigInt(b.uiTokenAmount.amount)).toString(),
    });
  }
  return deltas;
}

/** Mints that went from nonexistent/zero to exactly 1 — i.e. an NFT delivered here. */
export function nftsReceived(tx: ParsedTransactionWithMeta): TokenDelta[] {
  return tokenDeltas(tx).filter((d) => d.decimals === 0 && d.delta === "1");
}

export function isValidPubkey(value: string): boolean {
  try {
    // Rejects both malformed base58 and off-curve-length inputs.
    return new PublicKey(value).toBytes().length === 32;
  } catch {
    return false;
  }
}
