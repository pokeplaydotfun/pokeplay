import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkDepositAsset, CC_COLLECTION, type DepositAsset } from "./deposit.ts";

const CUSTODY = "CARD7cmGjygGCSkrbXdxBN8Zr9Zd1fN1mjZdvSLqHuaN";
const STRANGER = "8xTheirOwnWalletAddress111111111111111111111";

const genuine = (over: Partial<DepositAsset> = {}): DepositAsset => ({
  interface: "MplCoreAsset",
  collection: CC_COLLECTION,
  owner: CUSTODY,
  name: "1999 Pokemon Base Set Squirtle",
  imageUrl: "https://arweave.net/x",
  ...over,
});

const clean = { backsALiveMirror: false, alreadyDeposited: false };

describe("verifying a deposited card", () => {
  test("accepts a genuine Collector Crypt card that has arrived", () => {
    assert.deepEqual(checkDepositAsset(genuine(), CUSTODY, clean), { ok: true });
  });

  /**
   * THE ATTACK THIS EXISTS FOR. Anyone can mint a Metaplex Core asset and call it a Pokemon
   * card. Only membership of Collector Crypt's collection makes it one, and only that grouping
   * ties it to a card really sitting in their vault.
   */
  test("refuses an asset outside Collector Crypt's collection", () => {
    const r = checkDepositAsset(genuine({ collection: "SomeCollectionIMintedMyself111111111111" }), CUSTODY, clean);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /Collector Crypt's collection/);
  });

  test("refuses an asset that is not a Metaplex Core asset at all", () => {
    const r = checkDepositAsset(genuine({ interface: "V1_NFT" }), CUSTODY, clean);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /Metaplex Core/);
  });

  /**
   * A claim is a statement; ownership is a fact. Minting on the claim alone would create a
   * mirror backed by a card still sitting in the claimer's own wallet.
   */
  test("refuses a card that has not actually arrived", () => {
    const r = checkDepositAsset(genuine({ owner: STRANGER }), CUSTODY, clean);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /has not arrived/);
  });

  test("an unreadable owner is refused, not waved through", () => {
    const r = checkDepositAsset(genuine({ owner: null }), CUSTODY, clean);
    assert.equal(r.ok, false);
  });

  /**
   * THE SECOND ATTACK. A card we pulled from a pack is ALREADY in custody, so the ownership
   * check passes for it trivially. Without this, anyone could point a claim at a card sitting
   * in our vault and be minted a second mirror for a card that already backs someone else's.
   */
  test("refuses a card currently in the vault backing a mirror", () => {
    const r = checkDepositAsset(genuine(), CUSTODY, { ...clean, backsALiveMirror: true });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /already in the vault/);
  });

  /**
   * THE ROUND TRIP, which real testing caught on the first attempt. A withdrawn card is
   * UNWRAPPED, not CUSTODY: it left the vault and belongs to the user, so depositing it back is
   * exactly what this feature is for. The original guard rejected any card we had ever seen and
   * made the round trip impossible.
   */
  test("ACCEPTS a card that was withdrawn and is being deposited back", () => {
    assert.deepEqual(
      checkDepositAsset(genuine(), CUSTODY, { backsALiveMirror: false, alreadyDeposited: false }),
      { ok: true },
    );
  });

  test("refuses a card that was already deposited", () => {
    const r = checkDepositAsset(genuine(), CUSTODY, { ...clean, alreadyDeposited: true });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /already been deposited/);
  });

  test("refuses an asset that does not exist", () => {
    assert.equal(checkDepositAsset(null, CUSTODY, clean).ok, false);
  });

  /** The collection is a constant, not a guess — this pins the exact value we verified. */
  test("the collection is Collector Crypt's real one", () => {
    assert.equal(CC_COLLECTION, "CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac");
  });
});
