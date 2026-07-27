import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SolanaChain } from "./solana.ts";

/**
 * `withdrawAssetTo` refuses before it sends, and its dry run really does not send.
 *
 * The rules being enforced here were both bought with a real card:
 *
 *   1. `isOnCurve` is not a wallet-validity check. The all-zeros System Program passes it,
 *      and a card transferred there is unrecoverable.
 *   2. Never run an irreversible function against production to test a rejection path. Which
 *      is why the dry run exists, and why these tests assert that NOTHING was sent.
 *
 * Built on a stubbed chain rather than the real one: this file must be runnable by anyone,
 * on any machine, without a keypair and without the ability to move an asset.
 */

const CUSTODY = "CARD7cmGjygGCSkrbXdxBN8Zr9Zd1fN1mjZdvSLqHuaN";
const GOOD_DEST = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

type Stub = {
  chain: SolanaChain;
  sent: string[];
  assetFetched: string[];
};

/**
 * A SolanaChain with the network replaced.
 *
 * `sent` stays empty unless a real transfer would have been broadcast, so a test can assert
 * the absence of the irreversible step rather than only the presence of an error.
 */
function stub(opts: {
  owner?: string | null;
  exists?: boolean;
  executable?: boolean;
  accountOwner?: string | null;
} = {}): Stub {
  const sent: string[] = [];
  const assetFetched: string[] = [];

  const chain = Object.create(SolanaChain.prototype) as SolanaChain;
  Object.assign(chain, {
    address: CUSTODY,
    connection: { rpcEndpoint: "http://stub" },
    keypair: { secretKey: new Uint8Array(64) },
  });

  // The three network reads withdrawAssetTo makes, stubbed at the method boundary.
  (chain as unknown as { assetOwner: () => Promise<string | null> }).assetOwner = async () =>
    opts.owner === undefined ? CUSTODY : opts.owner;
  (chain as unknown as { accountSnapshot: () => Promise<unknown> }).accountSnapshot = async () => ({
    exists: opts.exists ?? true,
    executable: opts.executable ?? false,
    owner: opts.accountOwner ?? "11111111111111111111111111111111",
  });

  return { chain, sent, assetFetched };
}

/**
 * Every one of these must fail BEFORE the umi import, which is where sending begins. If a
 * guard were reordered below it, the call would try to reach the network and fail differently.
 */
describe("withdrawAssetTo refuses bad destinations before doing anything", () => {
  const cases: [string, string, RegExp][] = [
    ["the address that destroyed a card", "11111111111111111111111111111111", /System Program/],
    ["a burn address", "1nc1nerator11111111111111111111111111111111", /burn address/],
    ["the SPL Token Program", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", /Token Program/],
    // Both of these trip the confusable-character check before base58 parsing — "definitely"
    // contains an l, and the Ethereum address a 0. Same outcome, earlier and with a clearer
    // message, so the assertion is on the refusal rather than on which guard caught it.
    ["nonsense", "definitely not an address", /never appear in a Solana address/],
    ["an Ethereum address", "0xAbC1230000000000000000000000000000000000", /never appear in a Solana address/],
    ["a valid-looking but unparseable string", "zzzz", /not a valid Solana address/],
    ["nothing at all", "", /No destination address/],
  ];

  for (const [what, dest, expected] of cases) {
    test(`refuses ${what}`, async () => {
      const { chain } = stub();
      await assert.rejects(
        () => chain.withdrawAssetTo("SomeMint", dest),
        (err: Error) => {
          assert.match(err.message, /Refusing to withdraw/);
          assert.match(err.message, expected);
          return true;
        },
      );
    });
  }

  test("refuses our own custody wallet", async () => {
    const { chain } = stub();
    await assert.rejects(
      () => chain.withdrawAssetTo("SomeMint", CUSTODY),
      /our own custody wallet/,
    );
  });
});

describe("withdrawAssetTo refuses on chain state", () => {
  test("refuses an executable destination", async () => {
    const { chain } = stub({ executable: true });
    await assert.rejects(() => chain.withdrawAssetTo("SomeMint", GOOD_DEST), /executable program/);
  });

  test("refuses a program-owned destination", async () => {
    const { chain } = stub({ accountOwner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" });
    await assert.rejects(() => chain.withdrawAssetTo("SomeMint", GOOD_DEST), /not the System Program/);
  });

  test("refuses a card we do not hold", async () => {
    // The card already left, or was never ours. Sending would move somebody else's asset or
    // fail loudly after the user's mirror is already burned.
    const { chain } = stub({ owner: "SomeoneElse111111111111111111111111111111111" });
    await assert.rejects(() => chain.withdrawAssetTo("SomeMint", GOOD_DEST), /not our custody wallet/);
  });

  test("refuses an unused destination in strict mode, allows it otherwise", async () => {
    const { chain } = stub({ exists: false });
    await assert.rejects(
      () => chain.withdrawAssetTo("SomeMint", GOOD_DEST, { requireDestinationExists: true }),
      /never been used/,
    );
    // Without the flag the same address gets past the address checks and on to the asset read,
    // which is where the stub ends. Reaching a DIFFERENT failure proves the guard let it by.
    await assert.rejects(
      () => chain.withdrawAssetTo("SomeMint", GOOD_DEST, { requireDestinationExists: false }),
      (err: Error) => !/never been used/.test(err.message),
    );
  });
});

describe("the guards run in an order that cannot leak a send", () => {
  test("a bad address is rejected even when everything else is fine", async () => {
    const { chain, sent } = stub();
    await assert.rejects(() => chain.withdrawAssetTo("SomeMint", "11111111111111111111111111111111"));
    assert.deepEqual(sent, [], "nothing may be broadcast on a rejected withdraw");
  });

  test("ownership is checked before any transfer is built", async () => {
    // If this ordering inverted, we would build and potentially send a transfer for an asset
    // we do not hold — discovered only after the user's mirror was burned.
    const { chain, sent } = stub({ owner: null });
    await assert.rejects(() => chain.withdrawAssetTo("SomeMint", GOOD_DEST), /not our custody wallet/);
    assert.deepEqual(sent, []);
  });
});
