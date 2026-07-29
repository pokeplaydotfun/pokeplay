#!/usr/bin/env node
/**
 * Snapshot the SQLite database to a timestamped file, then prune old snapshots.
 *
 * WHY NOT `cp`: the database runs in WAL mode. At any moment the committed state is split
 * between the .sqlite file and its -wal sidecar, so copying the .sqlite alone captures a
 * torn database that is missing every commit still in the log. `VACUUM INTO` asks SQLite
 * itself for a consistent snapshot, taking the WAL into account, while the worker keeps
 * writing. The output is a plain database file with no sidecars — restoring is a copy.
 *
 * WHAT IS AT STAKE: orders, cards, and every user's withdraw address. The cards themselves
 * live on chain and in the Collector Crypt vault, so they survive regardless, but the record
 * of WHO OWNS WHAT lives only here. Losing this file does not lose the assets; it loses the
 * ability to say whose they are.
 *
 *   node scripts/backup-db.mjs [--db PATH] [--out DIR] [--keep N] [--prefix NAME]
 *
 * Defaults match production: the path systemd passes as DB_PATH, /root/pwa-backups, 14 days.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const dbPath = arg("db", process.env.DB_PATH ?? "/root/pwa-data/pwa.sqlite");
const outDir = arg("out", "/root/pwa-backups");
const keep = Number(arg("keep", "14"));
/**
 * Filename prefix. Defaults to "pwa" so existing snapshots and their pruning are unaffected.
 *
 * It exists because ONE script now backs up two different products whose databases share an
 * identical schema but hold different custody records - pokeplay's gacha and rhcards'. A file
 * named `pwa-*.sqlite` sitting in pokeplay's backup directory invites restoring the wrong
 * product's history, and the schema match means nothing would complain: it would simply
 * attribute the wrong cards to the wrong people.
 */
const prefix = arg("prefix", "pwa");

// Colons are legal in filenames but make paths awkward to handle in a shell, which is where
// a restore happens and where nobody wants to be quoting things.
const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
const target = join(outDir, `${prefix}-${stamp}.sqlite`);

mkdirSync(outDir, { recursive: true });

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  // Single-quoted and escaped: the path is ours, but a VACUUM INTO that silently truncated at
  // an apostrophe would produce a backup file under a name nobody would ever think to look for.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

const size = statSync(target).size;
if (size === 0) {
  // Never leave a zero-byte file sitting in the backup directory looking like a backup.
  unlinkSync(target);
  console.error(`backup FAILED: ${target} came out empty`);
  process.exit(1);
}

// Prune by filename, which sorts chronologically because the stamp is ISO-8601. Reading mtimes
// would be wrong here: copying the directory forward would reset them all and delete everything.
const snapshots = readdirSync(outDir)
  // Must use the SAME prefix the write above used, or pruning silently stops matching and
  // snapshots accumulate forever.
  .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".sqlite"))
  .sort();

const stale = snapshots.slice(0, Math.max(0, snapshots.length - keep));
for (const f of stale) unlinkSync(join(outDir, f));

console.log(
  `backup ok  ${target}  ${(size / 1024 / 1024).toFixed(2)} MB  ` +
    `kept=${Math.min(snapshots.length, keep)}  pruned=${stale.length}`,
);
