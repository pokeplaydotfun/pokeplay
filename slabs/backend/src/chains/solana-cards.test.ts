import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SolanaChain } from "./solana.ts";

/**
 * Listing a wallet's Collector Crypt cards for the deposit picker.
 *
 * The bug this pins: `collectorCryptCardsOf` ended in `catch { return [] }`, and checked neither
 * the HTTP status nor the JSON-RPC error field. Every failure — rate limit, timeout, bad key,
 * malformed body — became "this wallet holds no cards". The deposit page then rendered "No
 * Collector Crypt cards in that wallet" over a wallet full of them, with no error and nothing to
 * retry, which is exactly how a working deposit flow gets reported as broken.
 *
 * An empty array must mean the wallet is empty, and nothing else.
 */

const COLLECTION = "CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac";
/** Stands in for the real endpoint, which carries the provider API key in its query string. */
const RPC_URL = "https://mainnet.example-rpc.com/?api-key=super-secret-key-do-not-leak";

/**
 * A SolanaChain that skips the constructor. Building a real one needs an operator keypair whose
 * address matches config, and none of that is involved in reading a wallet's assets.
 */
function chain(): SolanaChain {
  const c = Object.create(SolanaChain.prototype) as SolanaChain;
  Object.defineProperty(c, "connection", { value: { rpcEndpoint: RPC_URL }, writable: true });
  return c;
}

const ccCard = (id: string) => ({
  id,
  interface: "MplCoreAsset",
  grouping: [{ group_key: "collection", group_value: COLLECTION }],
  content: { metadata: { name: `Card ${id}` }, links: { image: `https://img/${id}.png` } },
});

const rpcOk = (items: unknown[]) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { items } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const realFetch = globalThis.fetch;
const realError = console.error;

beforeEach(() => {
  // The implementation logs failure detail; keep it out of the test output.
  console.error = () => {};
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realError;
});

describe("listing a wallet's Collector Crypt cards", () => {
  test("an empty wallet returns an empty list", async () => {
    globalThis.fetch = async () => rpcOk([]);

    assert.deepEqual(await chain().collectorCryptCardsOf("owner", COLLECTION), []);
  });

  test("keeps only MplCoreAsset entries in the right collection", async () => {
    globalThis.fetch = async () =>
      rpcOk([
        ccCard("keep-me"),
        // Right collection, wrong interface.
        { ...ccCard("wrong-interface"), interface: "V1_NFT" },
        // Right interface, some other collection.
        {
          ...ccCard("wrong-collection"),
          grouping: [{ group_key: "collection", group_value: "SomeOtherCollection111" }],
        },
        // No grouping at all.
        { id: "ungrouped", interface: "MplCoreAsset" },
      ]);

    const cards = await chain().collectorCryptCardsOf("owner", COLLECTION);

    assert.deepEqual(
      cards.map((c) => c.mint),
      ["keep-me"],
      "only a card from the CC collection may be offered for deposit",
    );
    assert.equal(cards[0]!.name, "Card keep-me");
    assert.equal(cards[0]!.imageUrl, "https://img/keep-me.png");
  });

  test("a transport failure throws instead of reporting an empty wallet", async () => {
    globalThis.fetch = async () => {
      throw new Error("connect ETIMEDOUT");
    };

    await assert.rejects(
      () => chain().collectorCryptCardsOf("owner", COLLECTION),
      /did not respond/,
      "a dead RPC must not look like a wallet holding nothing",
    );
  });

  test("an HTTP 429 throws, and says it is a rate limit", async () => {
    globalThis.fetch = async () => new Response("rate limited", { status: 429 });

    await assert.rejects(() => chain().collectorCryptCardsOf("owner", COLLECTION), /rate limiting/);
  });

  test("a non-429 HTTP error throws and names the status", async () => {
    globalThis.fetch = async () => new Response("boom", { status: 503 });

    await assert.rejects(() => chain().collectorCryptCardsOf("owner", COLLECTION), /HTTP 503/);
  });

  test("a JSON-RPC error body throws even though the HTTP status is 200", async () => {
    // The failure mode that `body.result?.items ?? []` swallowed most quietly.
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "boom" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    await assert.rejects(() => chain().collectorCryptCardsOf("owner", COLLECTION), /rejected the request/);
  });

  test("an unparseable body throws", async () => {
    globalThis.fetch = async () => new Response("<html>gateway</html>", { status: 200 });

    await assert.rejects(() => chain().collectorCryptCardsOf("owner", COLLECTION), /malformed/);
  });

  test("no error message leaks the RPC URL or its API key", async () => {
    /**
     * These messages are returned to an unauthenticated caller by GET /deposit/cards. The RPC
     * endpoint has the provider API key in its query string, so interpolating a raw error here
     * would publish it to anyone who could make the lookup fail.
     */
    const failures: (() => Promise<unknown>)[] = [
      async () => {
        globalThis.fetch = async () => {
          throw new Error(`request to ${RPC_URL} failed`);
        };
      },
      async () => {
        globalThis.fetch = async () => new Response("rate limited", { status: 429 });
      },
      async () => {
        globalThis.fetch = async () => new Response(`upstream ${RPC_URL} died`, { status: 502 });
      },
      async () => {
        globalThis.fetch = async () =>
          new Response(JSON.stringify({ error: { message: `bad key for ${RPC_URL}` } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
      },
    ];

    for (const arrange of failures) {
      await arrange();
      const err = await chain()
        .collectorCryptCardsOf("owner", COLLECTION)
        .then(() => null)
        .catch((e: unknown) => e as Error);

      assert.ok(err, "the call must fail");
      assert.ok(!err.message.includes("super-secret-key-do-not-leak"), `leaked the API key: ${err.message}`);
      assert.ok(!err.message.includes("example-rpc.com"), `leaked the RPC host: ${err.message}`);
    }
  });
});

describe("wallets larger than one page", () => {
  test("pages to exhaustion instead of stopping at the first 1000", async () => {
    /**
     * The old call asked for page 1, limit 1000, and returned whatever came back. A wallet
     * holding more than that silently lost the remainder — a partial list presented as complete,
     * so a depositable card simply would not appear and nothing would say why.
     */
    const first = Array.from({ length: 1000 }, (_, i) => ccCard(`p1-${i}`));
    const second = [ccCard("p2-0"), ccCard("p2-1")];
    const pagesSeen: number[] = [];

    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { params: { page: number } };
      pagesSeen.push(body.params.page);
      return rpcOk(body.params.page === 1 ? first : second);
    };

    const cards = await chain().collectorCryptCardsOf("owner", COLLECTION);

    assert.equal(cards.length, 1002, "both pages must be included");
    assert.deepEqual(pagesSeen, [1, 2], "and it stops as soon as a page comes back short");
  });

  test("a single short page makes exactly one request", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return rpcOk([ccCard("only")]);
    };

    await chain().collectorCryptCardsOf("owner", COLLECTION);

    assert.equal(calls, 1, "a short page is the last page");
  });

  test("beyond the page cap it throws rather than returning a truncated list", async () => {
    // Every page comes back exactly full, so there is never a signal to stop.
    const full = Array.from({ length: 1000 }, (_, i) => ccCard(`x-${i}`));
    globalThis.fetch = async () => rpcOk(full);

    await assert.rejects(
      () => chain().collectorCryptCardsOf("owner", COLLECTION),
      /too many assets/,
      "a list we know is incomplete must not be presented as the wallet's contents",
    );
  });
});
