#!/usr/bin/env node
/**
 * Nightly backup of the PokePlay database.
 *
 * Uses SQLite's own online-backup API, NOT a file copy. The database runs in
 * WAL mode, so recent writes live in `app.db-wal` — copying `app.db` alone
 * would silently produce a backup missing the newest data, or a torn one if a
 * write landed mid-copy. The backup API takes a consistent snapshot of a live
 * database with no downtime.
 *
 * Each run is verified before it is kept: a backup nobody has restored is a
 * guess, not a backup.
 *
 *   node backup.mjs [--keep N]
 */
import { backup, DatabaseSync } from 'node:sqlite'
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync,
} from 'node:fs'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'

const DB = process.env.DB_PATH ?? '/var/lib/slabshowdown/app.db'
const DIR = process.env.BACKUP_DIR ?? '/var/backups/slabshowdown'
const keepArg = process.argv.indexOf('--keep')
const KEEP = keepArg > -1 ? Number(process.argv[keepArg + 1]) : 14

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const raw = join(DIR, `app-${stamp}.db`)
const gz = `${raw}.gz`

mkdirSync(DIR, { recursive: true })

/* ---------------- take the snapshot ---------------- */

const source = new DatabaseSync(DB, { readOnly: true })
await backup(source, raw)
source.close()

/* ---------------- verify it before trusting it ---------------- */

const check = new DatabaseSync(raw, { readOnly: true })

const integrity = check.prepare('PRAGMA integrity_check').get()
const ok = Object.values(integrity ?? {})[0]
if (ok !== 'ok') {
  check.close()
  unlinkSync(raw)
  console.error(`backup failed integrity_check: ${ok}`)
  process.exit(1)
}

// Confirm the schema is actually present — an empty file passes integrity_check.
const counts = {}
for (const t of ['users', 'teams', 'wagers', 'battles']) {
  counts[t] = check.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
}
check.close()

/* ---------------- compress and rotate ---------------- */

await pipeline(createReadStream(raw), createGzip({ level: 9 }), createWriteStream(gz))

// Opening the snapshot to verify it makes SQLite create -wal/-shm sidecars.
// Leave them behind and the backup directory slowly fills with junk.
for (const f of [raw, `${raw}-wal`, `${raw}-shm`]) {
  if (existsSync(f)) unlinkSync(f)
}

const size = statSync(gz).size
const rows = Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(' ')

// Sweep any sidecars an older version of this script left behind.
for (const f of readdirSync(DIR)) {
  if (f.endsWith('.db-wal') || f.endsWith('.db-shm')) unlinkSync(join(DIR, f))
}

const old = readdirSync(DIR)
  .filter((f) => f.startsWith('app-') && f.endsWith('.db.gz'))
  .sort()
  .reverse()
  .slice(KEEP)

for (const f of old) unlinkSync(join(DIR, f))

console.log(
  `${new Date().toISOString()} ok ${gz} (${(size / 1024).toFixed(1)} kB) ${rows}` +
    (old.length ? ` pruned=${old.length}` : ''),
)
