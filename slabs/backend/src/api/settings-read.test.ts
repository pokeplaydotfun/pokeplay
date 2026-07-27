import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { Db } from "../db/index.ts";
import { createApi } from "./server.ts";
import type { ApiDeps } from "./server.ts";

/**
 * A wallet's withdraw address is readable ONLY by that wallet.
 *
 * This was an open read: no signature, no session. `/leaderboard` publishes every buyer's EVM
 * address, so one request per address produced a complete EVM-to-Solana linkage table for the
 * whole userbase. The write path was authenticated the entire time; only the read was open,
 * which is the worse half to leave open — deanonymising every user is not undone later.
 *
 * Nothing was actually exposed: the production table was empty when this was found.
 */

/**
 * A WELL-KNOWN TEST KEY, not a real one: Hardhat/Ganache default account #1, published in
 * their own documentation and in thousands of repositories. Holds nothing on any chain.
 * Stated explicitly because this repo is public and a 64-hex string in a file is otherwise
 * indistinguishable from a leaked operator key.
 */
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const account = privateKeyToAccount(KEY);
const SOLANA = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const readMessage = (address: string, nonce: number) =>
  `${process.env.SIGNING_NS ?? "Slabs"}: read my withdraw address for ${address}\nTimestamp: ${nonce}`;

async function withApi<T>(fn: (base: string, db: Db) => Promise<T>): Promise<T> {
  const db = new Db(":memory:");
  db.setUserSolanaAddress(account.address, SOLANA, 1);
  const server = createApi({
    db,
    cc: {} as ApiDeps["cc"],
    pipeline: {} as ApiDeps["pipeline"],
    cfg: { economics: { unwrapFeeDuringWindowBps: 0 } } as ApiDeps["cfg"],
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`, db);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const read = async (base: string, q = "") =>
  (await (await fetch(`${base}/settings/${account.address}${q}`)).json()) as { solanaAddress: string | null };

describe("reading a withdraw address", () => {
  test("an UNSIGNED read reveals nothing, even though the address is stored", async () => {
    await withApi(async (base, db) => {
      // The row genuinely exists — this is not passing because the table is empty.
      assert.equal(db.getUserSettings(account.address).solanaAddress, SOLANA);
      assert.equal((await read(base)).solanaAddress, null, "an open read would leak this");
    });
  });

  test("the wallet itself can read it, with a signature", async () => {
    await withApi(async (base) => {
      const nonce = Date.now();
      const signature = await account.signMessage({ message: readMessage(account.address, nonce) });
      const body = await read(base, `?nonce=${nonce}&signature=${signature}`);
      assert.equal(body.solanaAddress, SOLANA, "the owner must still be able to sync devices");
    });
  });

  test("someone else's signature does not open it", async () => {
    // The harvest attack: an attacker signs with their OWN key and asks for a victim's row.
    await withApi(async (base) => {
      // Hardhat default account #3, same as above: a published test key holding nothing.
      const attacker = privateKeyToAccount(
        "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
      );
      const nonce = Date.now();
      const signature = await attacker.signMessage({ message: readMessage(account.address, nonce) });
      assert.equal((await read(base, `?nonce=${nonce}&signature=${signature}`)).solanaAddress, null);
    });
  });

  test("a signature for a DIFFERENT address does not transfer", async () => {
    // Signed correctly, but over another wallet's name — must not authorise this row.
    await withApi(async (base) => {
      const nonce = Date.now();
      const signature = await account.signMessage({
        message: readMessage("0x000000000000000000000000000000000000dEaD", nonce),
      });
      assert.equal((await read(base, `?nonce=${nonce}&signature=${signature}`)).solanaAddress, null);
    });
  });

  test("a stale signature does not work forever", async () => {
    await withApi(async (base) => {
      const nonce = Date.now() - 60 * 60_000; // an hour old
      const signature = await account.signMessage({ message: readMessage(account.address, nonce) });
      assert.equal((await read(base, `?nonce=${nonce}&signature=${signature}`)).solanaAddress, null);
    });
  });

  test("garbage does not throw or leak", async () => {
    await withApi(async (base) => {
      assert.equal((await read(base, "?nonce=abc&signature=0xdead")).solanaAddress, null);
      assert.equal((await read(base, "?signature=0xdead")).solanaAddress, null);
      assert.equal((await read(base, `?nonce=${Date.now()}`)).solanaAddress, null);
    });
  });
});
