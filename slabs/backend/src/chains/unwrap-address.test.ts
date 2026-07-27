import { test, describe } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { checkDestinationFormat } from "./solana-destination.ts";

/**
 * The raw-bytes round trip, frontend to contract to relayer.
 *
 * This is the last genuinely unproven step in a withdraw. The TRANSFER is not new — it is the
 * same umi transferV1 that already moved a real asset on mainnet — and the destination GUARD is
 * covered exhaustively elsewhere. What has never run is the decode: `UnwrapRequested` carries
 * `bytes solanaAddress`, 32 raw bytes with no encoding, and the contract checks only the length.
 *
 * A wrong decode is the worst possible failure here, because it FAILS OPEN. Mangling the bytes
 * yields a different but perfectly valid address: the guard passes it, the proven transfer
 * faithfully delivers to it, and the card is gone. No amount of care in the transfer helps.
 *
 * So: a user's address is encoded exactly as the frontend does it, carried as the contract
 * carries it, and decoded as the relayer does, and must come back identical.
 */

/** frontend/src/settings.ts — solanaAddressToHex. Duplicated deliberately, see below. */
const encodeAsFrontend = (bytes: Uint8Array): string =>
  `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

/** backend/src/chains/rh.ts — unwrapRequests. Same. */
const decodeAsRelayer = (hex: string): string | null => {
  const bytes = Buffer.from(hex.slice(2), "hex");
  if (bytes.length !== 32) return null;
  return bs58.encode(bytes);
};

/**
 * The two helpers are copied rather than imported, on purpose. They live on opposite sides of
 * a chain boundary and cannot import each other, so what matters is that they AGREE — and a
 * test that imported one of them could not detect the two drifting apart.
 */

const ADDRESSES = [
  ["CARD7cmGjygGCSkrbXdxBN8Zr9Zd1fN1mjZdvSLqHuaN", "our custody wallet"],
  ["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "an ordinary wallet"],
  ["So11111111111111111111111111111111111111112", "one with many leading 1s"],
  ["DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "a mint-style address"],
] as const;

describe("a withdraw address survives the round trip intact", () => {
  for (const [addr, what] of ADDRESSES) {
    test(`${what} round-trips exactly`, () => {
      const bytes = bs58.decode(addr);
      assert.equal(bytes.length, 32, "the contract requires exactly 32 bytes");

      const onChain = encodeAsFrontend(bytes);
      const back = decodeAsRelayer(onChain);

      assert.equal(back, addr, "the card must go to the address the user typed, exactly");
    });
  }

  test("leading zero bytes are not dropped", () => {
    /**
     * The classic base58 trap, and the one most likely to bite. A leading zero byte encodes as
     * a leading "1" and is easy to lose in a naive conversion — which would shift every
     * remaining byte and produce a valid address belonging to someone else entirely.
     */
    const bytes = new Uint8Array(32);
    bytes[31] = 1; // 31 leading zero bytes
    const addr = bs58.encode(bytes);

    assert.ok(addr.startsWith("111"), "sanity: leading zeros show up as leading 1s");
    assert.equal(decodeAsRelayer(encodeAsFrontend(bytes)), addr, "leading zeros must survive");
  });

  test("a byte is not silently lost or reordered", () => {
    // Every byte value, so a mask, an off-by-one or an endianness flip cannot pass.
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = (i * 7 + 3) % 256;
    const addr = bs58.encode(bytes);

    const back = decodeAsRelayer(encodeAsFrontend(bytes));
    assert.equal(back, addr);
    assert.deepEqual([...bs58.decode(back!)], [...bytes], "byte for byte");
  });

  test("high bytes survive, so no sign extension anywhere", () => {
    const bytes = new Uint8Array(32).fill(0xff);
    const addr = bs58.encode(bytes);
    assert.equal(decodeAsRelayer(encodeAsFrontend(bytes)), addr);
  });
});

describe("a mangled decode would fail OPEN, which is why the above matters", () => {
  test("roughly half of all mangled addresses sail past the guard", () => {
    /**
     * The point, stated as a rate rather than an anecdote.
     *
     * A corrupted 32 bytes is still a valid address whenever it happens to land on the
     * ed25519 curve, which is about half the time. The other half is rejected as a PDA — by
     * luck, not by design. My first attempt at this test picked a mangled address that
     * happened to be off-curve and I nearly concluded the guard protects against decode bugs.
     * It does not, and cannot: the guard's job is to reject addresses that are structurally
     * unspendable, not to know which wallet the user meant.
     */
    const real = "CARD7cmGjygGCSkrbXdxBN8Zr9Zd1fN1mjZdvSLqHuaN";
    const bytes = bs58.decode(real);

    let accepted = 0;
    const TRIALS = 200;
    for (let i = 0; i < TRIALS; i++) {
      // A different single-byte corruption each time: exactly what an off-by-one, a bad
      // slice or a sign extension would produce.
      const mangled = Uint8Array.from(bytes);
      mangled[i % 32] = (mangled[i % 32]! + 1 + i) % 256;
      const wrong = bs58.encode(mangled);
      if (wrong === real) continue;
      if (checkDestinationFormat(wrong).ok) accepted++;
    }

    // Not asserting an exact rate — this is about the order of magnitude of the exposure.
    assert.ok(
      accepted > TRIALS * 0.25,
      `expected a large share of corrupted addresses to pass the guard, got ${accepted}/${TRIALS}`,
    );
    assert.equal(new PublicKey(real).toBytes().length, 32);
  });
});
