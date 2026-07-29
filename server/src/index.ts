import express from 'express'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import { createServer } from 'node:http'
import { isAddress } from 'viem'

import { db, now, ensureUser } from './db.js'
import {
  issueNonce, loginMessage, verifyLogin, sessionAddress, logout, pruneAuth, normalise,
  usernameMessage, verifyUsernameClaim,
  devLogin, devLoginEnabled, DEV_ACCOUNTS,
} from './auth.js'
import { NATURES } from './battle/natures.js'
import {
  allSpecies, MOVES, ABILITIES, validateTeam, dexReady, type TeamSlot,
} from './battle/active.js'
import {
  createRoom, roomForPlayer, getRoom, attachSocket, detachSocket, submitAction,
  sweepDisconnects, setEndHook, activeRoomCount, ensureBotUser, BOT_ADDRESS,
  TURN_SECONDS, addSpectator, removeSpectator, liveBattles, type Room,
} from './rooms.js'
import { OPPONENTS, getOpponent, buildOpponents } from './battle/opponents.js'
import { checkUsername } from './username.js'
import * as tour from './tournaments.js'
import * as queue from './queue.js'
import {
  settlementEnabled, signResult, signDraw, arbiterAddress, wagerNonce, wagerStatus, currentFeeBps, verifySettlementConfig,
} from './settle.js'
import {
  tournamentSettlementEnabled, tournamentArbiterAddress, tournamentPoolAddress,
  verifyTournamentConfig, isOnchainEntrant, signTournamentResult, tournamentNonce,
  tournamentStatus, tournamentFeeBps,
} from './settle-tournament.js'
import { buildReplay } from './replay.js'
import { startPriceFeed, ethUsd } from './price.js'

const PORT = Number(process.env.PORT ?? 8090)
/**
 * Bind address. In production Caddy proxies to us, so we listen on loopback
 * only — the API is never directly reachable from the internet.
 */
const BIND = process.env.HOST ?? '0.0.0.0'

/**
 * The smallest real-money stake a wager may carry: 0.001 ETH.
 *
 * A floor exists because a paid wager costs both players gas to escrow, accept, settle and
 * withdraw. Below roughly this figure the gas outweighs the pot, so a "win" loses money and
 * the board fills with wagers nobody benefits from taking.
 *
 * ⚠ Mirrored in the client as MIN_STAKE_WEI (src/config.ts). Keep the two identical: the
 * client copy decides what the form OFFERS, this one decides what is ACCEPTED, and a
 * disagreement shows up as a wager the site invited and then refused.
 */
const MIN_STAKE_WEI = 1_000_000_000_000_000n
const MIN_STAKE_LABEL = '0.001'

const app = express()

/**
 * Caddy is the only thing in front of us, on loopback.
 *
 * Without this, `req.ip` is the proxy's address for every request, so all
 * rate limiting collapses into a single shared bucket and real traffic
 *429s itself. Trusting exactly one hop — and only loopback — means a
 * client cannot forge X-Forwarded-For to escape its own limit.
 */
app.set('trust proxy', 'loopback')

app.use(cors({ origin: process.env.CORS_ORIGIN ?? true, credentials: true }))
app.use(express.json({ limit: '64kb' }))

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const bearer = (req: express.Request) => req.headers.authorization?.replace(/^Bearer /, '')

function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const addr = sessionAddress(bearer(req))
  if (!addr) return res.status(401).json({ error: 'not signed in' })
  ;(req as express.Request & { address: string }).address = addr
  next()
}

const addrOf = (req: express.Request) => (req as express.Request & { address: string }).address

/** Very small fixed-window rate limiter, per IP per route group. */
const hits = new Map<string, { n: number; reset: number }>()

// Drop expired buckets so a busy day does not grow this map without bound.
setInterval(() => {
  const t = now()
  for (const [k, v] of hits) if (v.reset < t) hits.delete(k)
}, 60_000).unref()

/**
 * What to count against.
 *
 * IP alone is wrong for anything a real user does repeatedly: mobile carriers
 * put hundreds of people behind one address, so a per-IP budget that looks
 * generous for one person blocks a whole carrier at launch. Where we know who
 * is calling, count that instead.
 */
type LimitBy = 'ip' | 'address' | 'claimed-address'

/**
 * Per-IP ceiling on sign-in attempts.
 *
 * Sized for a carrier, not a person: mobile CGNAT puts hundreds of real users
 * behind one address, and a launch spike is mostly mobile. This is only a flood
 * backstop — nonces are pruned every 15s and signature recovery is microseconds,
 * so the endpoint is cheap. The meaningful control is the per-wallet limit
 * alongside it.
 */
const AUTH_IP_BURST = Number(process.env.AUTH_IP_BURST ?? 2000)

function rateLimit(max: number, windowSec: number, by: LimitBy = 'ip') {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // `req.ip` is the real client only because `trust proxy` is set above.
    // Without it every request behind Caddy reads as 127.0.0.1 and the whole
    // site shares one bucket.
    //
    // The route must be the FULL path. `path.split('/')[1]` yields "api" for
    // every endpoint here, which collapsed all of them into a single bucket
    // per IP governed by whichever limit was tightest.
    // `claimed-address` is unauthenticated — anyone can put any address in the
    // body — so it is a courtesy limit only. The IP limit alongside it is what
    // actually bounds abuse.
    const who =
      by === 'address' ? addrOf(req)
      : by === 'claimed-address' ? String((req.body as { address?: string })?.address ?? req.ip)
      : req.ip
    const key = `${by}:${who}:${req.baseUrl}${req.path}`
    const t = now()
    const cur = hits.get(key)
    if (!cur || cur.reset < t) hits.set(key, { n: 1, reset: t + windowSec })
    else if (++cur.n > max) return res.status(429).json({ error: 'slow down' })
    next()
  }
}

/* ------------------------------------------------------------------ */
/* reference data                                                      */
/* ------------------------------------------------------------------ */

app.get('/api/pokedex', (_req, res) => {
  res.json({
    species: allSpecies().map((s) => ({
      id: s.id,
      name: s.name,
      types: s.types,
      stats: s.stats,
      sprites: s.sprites,
      moves: s.moves,
      abilities: s.abilities,
    })),
    natures: NATURES,
    abilities: Object.fromEntries(
      // `inert` is kept for the client's shape but is always null now: the sim
      // implements every ability, so none of them are dead weight.
      [...ABILITIES.entries()].map(([k, a]) => [k, { name: a.name, text: a.text, inert: null }]),
    ),
    moves: Object.fromEntries(
      [...MOVES.entries()].map(([k, m]) => [
        k,
        {
          name: m.name, type: m.type, category: m.category, power: m.power,
          accuracy: m.accuracy, pp: m.pp, priority: m.priority,
          ailment: m.ailment, ailmentChance: m.ailmentChance,
          statChanges: m.statChanges, healing: m.healing, drain: m.drain,
          // New in v2: a plain-English description for the builder's hover help.
          text: m.text,
        },
      ]),
    ),
  })
})

/* ------------------------------------------------------------------ */
/* auth                                                                */
/* ------------------------------------------------------------------ */

app.post('/api/auth/nonce', rateLimit(AUTH_IP_BURST, 60), rateLimit(20, 60, 'claimed-address'), (req, res) => {
  const { address } = req.body ?? {}
  if (typeof address !== 'string' || !isAddress(address)) {
    return res.status(400).json({ error: 'invalid address' })
  }
  const nonce = issueNonce(address)
  res.json({ nonce, message: loginMessage(nonce, address) })
})

app.post('/api/auth/verify', rateLimit(AUTH_IP_BURST, 60), rateLimit(20, 60, 'claimed-address'), async (req, res) => {
  const { address, nonce, signature } = req.body ?? {}
  if (typeof address !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string') {
    return res.status(400).json({ error: 'missing fields' })
  }
  try {
    const token = await verifyLogin(address, nonce, signature as `0x${string}`)
    res.json({ token, address: normalise(address) })
  } catch (e) {
    res.status(401).json({ error: (e as Error).message })
  }
})

/**
 * Local development only — see `devLogin`. Returns 404 (not 403) when
 * disabled so a production deployment does not advertise that it exists.
 */
app.post('/api/auth/dev-login', (req, res) => {
  if (!devLoginEnabled) return res.status(404).json({ error: 'not found' })
  try {
    const { who } = req.body ?? {}
    res.json({ ...devLogin(String(who ?? '')), dev: true })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

app.get('/api/auth/dev-accounts', (_req, res) => {
  if (!devLoginEnabled) return res.status(404).json({ error: 'not found' })
  res.json({ accounts: Object.keys(DEV_ACCOUNTS) })
})

app.post('/api/auth/logout', requireAuth, (req, res) => {
  logout(bearer(req)!)
  res.json({ ok: true })
})

app.get('/api/me', requireAuth, (req, res) => {
  const u = db.prepare(
    'SELECT address, name, wins, losses, draws, hide_wallet FROM users WHERE address = ?',
  ).get(addrOf(req)) as
    | { name: string | null; hide_wallet: number }
    | undefined
  const { hide_wallet, ...rest } = u ?? { hide_wallet: 0 }
  // `needsUsername` drives the one-time claim prompt on first sign-in.
  res.json({ ...rest, hideWallet: Boolean(hide_wallet), needsUsername: !u?.name })
})

/** Toggle wallet privacy. When on, the address is masked everywhere public. */
app.post('/api/me/privacy', requireAuth, (req, res) => {
  const hide = req.body?.hideWallet ? 1 : 0
  db.prepare('UPDATE users SET hide_wallet = ? WHERE address = ?').run(hide, addrOf(req))
  res.json({ hideWallet: Boolean(hide) })
})

/**
 * The signed-in player's full stat block for the profile page: record, realised
 * profit/loss and total value staked, all from settled on-chain wagers.
 */
app.get('/api/me/stats', requireAuth, (req, res) => {
  const me = addrOf(req)
  const u = db.prepare('SELECT wins, losses, draws, tournament_wins FROM users WHERE address = ?')
    .get(me) as { wins: number; losses: number; draws: number; tournament_wins: number } | undefined
  const wins = u?.wins ?? 0
  const losses = u?.losses ?? 0
  const draws = u?.draws ?? 0
  const played = wins + losses + draws

  // Total value this player has staked across settled paid wagers — both the
  // ones they created and the ones they accepted. Summed in BigInt: wei stored
  // as text would overflow a SQL SUM.
  const staked = db.prepare(`
    SELECT stake_wei FROM wagers
    WHERE status = 'settled' AND onchain_id IS NOT NULL AND stake_wei != '0'
      AND (creator = ? OR opponent = ?)
  `).all(me, me) as { stake_wei: string }[]
  let stakedWei = 0n
  for (const s of staked) {
    try {
      stakedWei += BigInt(s.stake_wei)
    } catch {
      /* skip a malformed row rather than fail the whole page */
    }
  }

  res.json({
    played,
    wins,
    losses,
    draws,
    tournamentWins: u?.tournament_wins ?? 0,
    winrate: wins + losses > 0 ? wins / (wins + losses) : 0,
    netWei: (realisedPnl().get(me) ?? 0n).toString(),
    stakedWei: stakedWei.toString(),
    paidGames: staked.length,
  })
})

/* ------------------------------------------------------------------ */
/* usernames                                                           */
/* ------------------------------------------------------------------ */

const takenBySomeoneElse = (name: string, me: string) =>
  Boolean(db.prepare('SELECT 1 FROM users WHERE lower(name) = lower(?) AND address != ?')
    .get(name, me))

/** Live availability, for the claim form. Never reserves anything. */
app.get('/api/username/check', requireAuth, (req, res) => {
  const name = String(req.query.name ?? '')
  const shape = checkUsername(name)
  if (!shape.ok) return res.json({ available: false, error: shape.error })
  if (takenBySomeoneElse(name, addrOf(req))) {
    return res.json({ available: false, error: 'Already taken.' })
  }
  res.json({ available: true })
})

/**
 * The message to sign for a claim. Issued per attempt so the signature is
 * bound to this exact name, address and nonce.
 */
app.post('/api/username/nonce', requireAuth, rateLimit(30, 60, 'address'), (req, res) => {
  const me = addrOf(req)
  const { name } = req.body ?? {}

  const existing = db.prepare('SELECT name FROM users WHERE address = ?').get(me) as
    | { name: string | null } | undefined
  if (existing?.name) return res.status(409).json({ error: 'You already have a username.' })

  const shape = checkUsername(name)
  if (!shape.ok) return res.status(400).json({ error: shape.error })
  if (takenBySomeoneElse(name as string, me)) {
    return res.status(409).json({ error: 'Already taken.' })
  }

  const nonce = issueNonce(me)
  res.json({ nonce, message: usernameMessage(nonce, me, name as string) })
})

/**
 * Claims the username. Permanent: there is deliberately no endpoint to change
 * it afterwards, and the handler refuses if one is already set.
 */
app.post('/api/username', requireAuth, rateLimit(30, 60, 'address'), async (req, res) => {
  const me = addrOf(req)
  const { name, nonce, signature } = req.body ?? {}

  const existing = db.prepare('SELECT name FROM users WHERE address = ?').get(me) as
    | { name: string | null } | undefined
  if (existing?.name) return res.status(409).json({ error: 'You already have a username.' })

  const shape = checkUsername(name)
  if (!shape.ok) return res.status(400).json({ error: shape.error })
  if (typeof nonce !== 'string' || typeof signature !== 'string') {
    return res.status(400).json({ error: 'missing signature' })
  }

  try {
    await verifyUsernameClaim(me, name as string, nonce, signature as `0x${string}`)
  } catch (e) {
    return res.status(401).json({ error: (e as Error).message })
  }

  try {
    // The unique index is the real arbiter. Two people claiming the same name
    // at the same instant both pass the check above; only one survives this.
    db.prepare(
      'UPDATE users SET name = ?, name_signature = ?, name_claimed_at = ? WHERE address = ?',
    ).run(name, signature, now(), me)
  } catch (e) {
    if (/unique/i.test((e as Error).message)) {
      return res.status(409).json({ error: 'Already taken.' })
    }
    throw e
  }

  res.json({ ok: true, name })
})

/* ------------------------------------------------------------------ */
/* teams                                                               */
/* ------------------------------------------------------------------ */

app.get('/api/teams', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, name, slots, updated_at FROM teams WHERE address = ? ORDER BY updated_at DESC')
    .all(addrOf(req)) as { id: number; name: string; slots: string; updated_at: number }[]
  res.json(rows.map((r) => ({ ...r, slots: JSON.parse(r.slots) })))
})

app.post('/api/teams', requireAuth, (req, res) => {
  const { name, slots } = req.body ?? {}
  if (typeof name !== 'string' || name.length < 1 || name.length > 30) {
    return res.status(400).json({ error: 'team name must be 1–30 characters' })
  }
  // The authoritative legality check. Never trust the client's team.
  const errs = validateTeam(slots)
  if (errs.length) return res.status(400).json({ error: 'illegal team', details: errs })

  const count = (db.prepare('SELECT COUNT(*) AS n FROM teams WHERE address = ?')
    .get(addrOf(req)) as { n: number }).n
  if (count >= 20) return res.status(400).json({ error: 'team limit reached (20)' })

  const info = db.prepare(
    'INSERT INTO teams (address, name, slots, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(addrOf(req), name, JSON.stringify(slots), now(), now())

  res.json({ id: Number(info.lastInsertRowid), name, slots })
})

app.put('/api/teams/:id', requireAuth, (req, res) => {
  const { name, slots } = req.body ?? {}
  const errs = validateTeam(slots)
  if (errs.length) return res.status(400).json({ error: 'illegal team', details: errs })

  const own = db.prepare('SELECT id FROM teams WHERE id = ? AND address = ?')
    .get(String(req.params.id), addrOf(req))
  if (!own) return res.status(404).json({ error: 'no such team' })

  db.prepare('UPDATE teams SET name = ?, slots = ?, updated_at = ? WHERE id = ?')
    .run(String(name).slice(0, 30), JSON.stringify(slots), now(), String(req.params.id))
  res.json({ ok: true })
})

app.delete('/api/teams/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM teams WHERE id = ? AND address = ?').run(String(req.params.id), addrOf(req))
  res.json({ ok: true })
})

/* ------------------------------------------------------------------ */
/* wagers                                                              */
/* ------------------------------------------------------------------ */

function loadTeam(teamId: unknown, address: string): TeamSlot[] | null {
  const row = db.prepare('SELECT slots FROM teams WHERE id = ? AND address = ?')
    .get(teamId as number, address) as { slots: string } | undefined
  if (!row) return null
  const slots = JSON.parse(row.slots) as TeamSlot[]
  // Re-validate on the way out: the ruleset may have changed since it was saved.
  return validateTeam(slots).length === 0 ? slots : null
}

app.get('/api/wagers', (_req, res) => {
  const rows = db.prepare(`
    SELECT w.id, w.creator, w.stake_wei, w.status, w.created_at, w.expires_at, w.onchain_id,
           u.name AS creator_name, u.wins, u.losses, COALESCE(u.hide_wallet, 0) AS hide_wallet
    FROM wagers w JOIN users u ON u.address = w.creator
    WHERE w.status = 'open' AND w.expires_at > ?
    ORDER BY w.created_at DESC LIMIT 100
  `).all(now()) as Record<string, unknown>[]
  // A private creator is shown by name only; the address stays server-side.
  res.json(rows.map((r) => {
    const hidden = Boolean(r.hide_wallet)
    const { hide_wallet, ...rest } = r
    void hide_wallet
    return { ...rest, creator: hidden ? '' : r.creator, creator_hidden: hidden }
  }))
})

app.post('/api/wagers', requireAuth, rateLimit(20, 60, 'address'), (req, res) => {
  const { teamId, stakeWei, onchainId } = req.body ?? {}
  const me = addrOf(req)

  const team = loadTeam(teamId, me)
  if (!team) return res.status(400).json({ error: 'team not found or no longer legal' })

  const stake = String(stakeWei ?? '0')
  if (!/^\d+$/.test(stake)) return res.status(400).json({ error: 'stake must be a wei integer' })

  /**
   * Floor on a real-money stake. Mirrored in the client as MIN_STAKE_WEI (src/config.ts);
   * THIS is the copy that holds, because the form is not the only way in — the API takes a
   * direct POST, and a stake can be escrowed on chain and the id posted afterwards.
   *
   * Zero stays legal: that is a free wager, not a cheap one.
   */
  if (stake !== '0' && BigInt(stake) < MIN_STAKE_WEI) {
    return res.status(400).json({
      error: `The smallest paid stake is ${MIN_STAKE_LABEL} ${'ETH'}.`,
    })
  }

  // A paid wager must reference an on-chain escrow entry. Without this the
  // board could be filled with wagers backed by no money at all.
  if (stake !== '0' && (typeof onchainId !== 'string' || !/^\d+$/.test(onchainId))) {
    return res.status(400).json({ error: 'paid wagers require the on-chain wager id' })
  }
  if (roomForPlayer(me)) return res.status(400).json({ error: 'you are already in a battle' })

  const info = db.prepare(`
    INSERT INTO wagers (onchain_id, creator, creator_team, stake_wei, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, 'open', ?, ?)
  `).run(stake === '0' ? null : onchainId, me, teamId as number, stake, now(), now() + 3600)

  res.json({ id: Number(info.lastInsertRowid) })
})

app.delete('/api/wagers/:id', requireAuth, (req, res) => {
  const w = db.prepare("SELECT * FROM wagers WHERE id = ? AND creator = ? AND status = 'open'")
    .get(String(req.params.id), addrOf(req))
  if (!w) return res.status(404).json({ error: 'no such open wager' })
  db.prepare("UPDATE wagers SET status = 'cancelled' WHERE id = ?").run(String(req.params.id))
  res.json({ ok: true })
})

app.post('/api/wagers/:id/accept', requireAuth, rateLimit(20, 60, 'address'), (req, res) => {
  const me = addrOf(req)
  const { teamId } = req.body ?? {}

  const w = db.prepare('SELECT * FROM wagers WHERE id = ?').get(String(req.params.id)) as
    | { id: number; creator: string; creator_team: number; stake_wei: string; status: string; expires_at: number }
    | undefined

  if (!w || w.status !== 'open') return res.status(404).json({ error: 'wager not available' })
  if (w.expires_at < now()) return res.status(400).json({ error: 'wager expired' })
  if (w.creator === me) return res.status(400).json({ error: 'cannot accept your own wager' })
  if (roomForPlayer(me)) return res.status(400).json({ error: 'you are already in a battle' })
  if (roomForPlayer(w.creator)) return res.status(400).json({ error: 'creator is already battling' })

  const myTeam = loadTeam(teamId, me)
  if (!myTeam) return res.status(400).json({ error: 'team not found or no longer legal' })

  const theirTeam = loadTeam(w.creator_team, w.creator)
  if (!theirTeam) return res.status(400).json({ error: "creator's team is no longer legal" })

  // Claim the wager atomically so two acceptors cannot both win the race.
  const claim = db.prepare(
    "UPDATE wagers SET status = 'matched', opponent = ?, opponent_team = ? WHERE id = ? AND status = 'open'",
  ).run(me, teamId as number, w.id)
  if (claim.changes === 0) return res.status(409).json({ error: 'already accepted' })

  const room = createRoom(
    { address: w.creator, team: theirTeam },
    { address: me, team: myTeam },
    w.id,
    w.stake_wei,
  )

  db.prepare("UPDATE wagers SET status = 'playing', battle_id = ? WHERE id = ?").run(room.id, w.id)
  res.json({ roomId: room.id })
})

/* ------------------------------------------------------------------ */
/* battles / leaderboard                                               */
/* ------------------------------------------------------------------ */

/** The signed-in player's recent finished matches, for the profile page. */
app.get('/api/me/battles', requireAuth, (req, res) => {
  const me = addrOf(req)
  const rows = db.prepare(`
    SELECT b.id, b.p0, b.p1, b.winner, b.ended_at,
           w.stake_wei, w.fee_bps, w.status AS wager_status, w.onchain_id
    FROM battles b
    LEFT JOIN wagers w ON w.id = b.wager_id
    WHERE b.ended_at IS NOT NULL AND (b.p0 = ? OR b.p1 = ?)
    ORDER BY b.ended_at DESC
    LIMIT 25
  `).all(me, me) as {
    id: string; p0: string; p1: string; winner: number | null; ended_at: number
    stake_wei: string | null; fee_bps: number | null
    wager_status: string | null; onchain_id: string | null
  }[]

  // Opponent name/privacy, looked up once per distinct opponent.
  const lookup = db.prepare('SELECT name, hide_wallet FROM users WHERE address = ?')
  const seen = new Map<string, { name: string | null; hidden: boolean }>()
  const identify = (addr: string) => {
    if (!seen.has(addr)) {
      const u = lookup.get(addr) as { name: string | null; hide_wallet: number } | undefined
      seen.set(addr, { name: u?.name ?? null, hidden: Boolean(u?.hide_wallet) })
    }
    return seen.get(addr)!
  }

  res.json(
    rows.map((r) => {
      const youAre = r.p0 === me ? 0 : 1
      const opponent = youAre === 0 ? r.p1 : r.p0
      const result = r.winner === null ? 'draw' : r.winner === youAre ? 'win' : 'loss'
      const practice = opponent === BOT_ADDRESS

      // Per-match realised P/L, only for a settled paid wager.
      const settled =
        r.wager_status === 'settled' && r.onchain_id && r.stake_wei && r.stake_wei !== '0'
      let stakeWei = '0'
      let net = '0'
      if (settled) {
        try {
          const stake = BigInt(r.stake_wei!)
          const fee = (stake * 2n * BigInt(r.fee_bps ?? 0)) / 10000n
          stakeWei = stake.toString()
          net = (result === 'win' ? stake - fee : result === 'loss' ? -stake : 0n).toString()
        } catch {
          /* leave as zero on a malformed stake */
        }
      }

      const info = practice ? { name: 'Practice', hidden: false } : identify(opponent)
      return {
        id: r.id,
        endedAt: r.ended_at,
        // A private opponent's address never leaves the server.
        opponent: !practice && info.hidden ? null : opponent,
        opponentName: info.name,
        opponentHidden: !practice && info.hidden,
        practice,
        result,
        stakeWei,
        net,
      }
    }),
  )
})

app.get('/api/practice/opponents', (_req, res) => {
  res.json(
    OPPONENTS.map((o) => ({
      id: o.id, name: o.name, blurb: o.blurb, difficulty: o.difficulty,
      team: o.team.map((t) => t.speciesId),
    })),
  )
})

/** Starts a match against the AI. No wager, no effect on anyone's record. */
app.post('/api/practice', requireAuth, rateLimit(30, 60, 'address'), (req, res) => {
  const me = addrOf(req)
  const { teamId, opponentId } = req.body ?? {}

  const team = loadTeam(teamId, me)
  if (!team) return res.status(400).json({ error: 'team not found or no longer legal' })

  const opponent = getOpponent(String(opponentId ?? 'rival'))
  if (!opponent) return res.status(400).json({ error: 'no such opponent' })

  if (roomForPlayer(me)) return res.status(400).json({ error: 'you are already in a battle' })

  ensureBotUser()
  const room = createRoom(
    { address: me, team },
    { address: BOT_ADDRESS, team: opponent.team, bot: opponent.difficulty, label: opponent.name },
    null,
    '0',
  )
  res.json({ roomId: room.id, opponent: opponent.name })
})

app.get('/api/battle/current', requireAuth, (req, res) => {
  const room = roomForPlayer(addrOf(req))
  res.json({ roomId: room?.id ?? null })
})

/**
 * Resolves an address to how it should appear to the public: its username and,
 * for a player who turned on "Hide my wallet", nothing else — the address is
 * withheld server-side so a shared replay or a public battle view can never
 * leak it. The bot is never hidden and keeps its address so callers can still
 * detect a practice match.
 */
function publicIdentity(addr: string): { address: string | null; name: string | null; hidden: boolean } {
  if (addr === BOT_ADDRESS) return { address: addr, name: null, hidden: false }
  const u = db.prepare('SELECT name, hide_wallet FROM users WHERE address = ?').get(addr) as
    | { name: string | null; hide_wallet: number }
    | undefined
  const hidden = Boolean(u?.hide_wallet)
  return { address: hidden ? null : addr, name: u?.name ?? null, hidden }
}

/**
 * Batch address -> username, so surfaces outside the wager app can show a player by name.
 *
 * The cards leaderboard is served by a SEPARATE backend that has no concept of a username —
 * names and the privacy flag live only here. Without this it can only ever print wallets,
 * which is why the two leaderboards looked like different products.
 *
 * ⚠⚠ A HIDDEN WALLET RESOLVES TO NOTHING, and that is the whole safety property of this
 * endpoint. `publicIdentity` above withholds the ADDRESS and keeps the name, so a name can
 * never be tied back to a wallet. This runs the other way round — address in, name out — so
 * returning a name for a hidden wallet would hand out precisely the association that
 * "Hide my wallet" exists to prevent. Absent from the response means "no name to show".
 *
 * Public and unauthenticated because it reveals strictly less than the leaderboard already
 * does: every pair it returns is a name and wallet this server publishes side by side anyway.
 */
app.get('/api/names', rateLimit(60, 60), (req, res) => {
  const raw = typeof req.query.addresses === 'string' ? req.query.addresses : ''
  const wanted = [
    ...new Set(
      raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((a) => /^0x[0-9a-f]{40}$/.test(a)),
    ),
    // Capped so one request cannot walk the whole user table.
  ].slice(0, 100)

  const names: { address: string; name: string }[] = []
  for (const address of wanted) {
    const u = db.prepare('SELECT name, hide_wallet FROM users WHERE address = ?').get(address) as
      | { name: string | null; hide_wallet: number }
      | undefined
    if (!u || u.hide_wallet || !u.name) continue
    names.push({ address, name: u.name })
  }
  res.json({ names })
})

/**
 * How an address should appear inside a tournament view. Same rule as
 * publicIdentity — a wallet the owner chose to hide is withheld — with one
 * exception: a viewer always sees their OWN address, so a hidden champion still
 * matches themselves and gets the prize-claim panel on their own page.
 */
function maskInTournament(
  addr: string,
  viewer: string | null,
): { address: string | null; name: string | null; hidden: boolean } {
  const id = publicIdentity(addr)
  if (id.hidden && viewer && addr.toLowerCase() === viewer.toLowerCase()) {
    return { address: addr, name: id.name, hidden: true }
  }
  return id
}

app.get('/api/battle/:id', (req, res) => {
  const row = db.prepare(`
    SELECT id, p0, p1, winner, seed, seed_hash, started_at, ended_at
    FROM battles WHERE id = ?
  `).get(String(req.params.id)) as
    | { id: string; p0: string; p1: string; ended_at: number | null; seed: string }
    | undefined
  if (!row) return res.status(404).json({ error: 'no such battle' })

  // A hidden player's address never leaves the server, even on this raw view.
  const [i0, i1] = [publicIdentity(row.p0), publicIdentity(row.p1)]
  const masked = {
    ...row,
    p0: i0.address, p0Name: i0.name, p0Hidden: i0.hidden,
    p1: i1.address, p1Name: i1.name, p1Hidden: i1.hidden,
  }
  // The seed stays secret until the match is over, or it would predict rolls.
  if (!row.ended_at) return res.json({ ...masked, seed: null })
  res.json(masked)
})

/**
 * Public replay of a finished battle. No auth: a replay link is meant to be
 * shareable, and it exposes nothing the two players did not already see.
 */
app.get('/api/replay/:id', (req, res) => {
  const replay = buildReplay(String(req.params.id))
  if (!replay) {
    return res.status(404).json({
      error: 'no replay for that battle — it may still be in progress, or predate replay support',
    })
  }
  const bot = replay.p0 === BOT_ADDRESS || replay.p1 === BOT_ADDRESS
  // Mask AFTER the bot check, which needs the real addresses. A shared replay
  // link is public, so a player who hid their wallet must stay hidden here too.
  const [i0, i1] = [publicIdentity(replay.p0), publicIdentity(replay.p1)]
  res.json({
    ...replay,
    practice: bot,
    p0: i0.address, p0Name: i0.name, p0Hidden: i0.hidden,
    p1: i1.address, p1Name: i1.name, p1Hidden: i1.hidden,
  })
})

/**
 * Every match currently in progress that a spectator can watch (practice
 * matches excluded). Public: it exposes only the identities the leaderboard and
 * wager board already show — a hidden wallet is masked to its username — plus
 * the stake and turn number, never any private battle state.
 */
app.get('/api/live', (_req, res) => {
  const matchRow = db.prepare('SELECT tournament_id FROM tournament_matches WHERE id = ?')
  const tourName = db.prepare('SELECT name FROM tournaments WHERE id = ?')

  const battles = liveBattles().map((b) => {
    const [i0, i1] = [publicIdentity(b.p0), publicIdentity(b.p1)]
    let tournament: { id: number; name: string } | null = null
    if (b.tournamentMatchId !== null) {
      const m = matchRow.get(b.tournamentMatchId) as { tournament_id: number } | undefined
      if (m) {
        const t = tourName.get(m.tournament_id) as { name: string } | undefined
        tournament = { id: m.tournament_id, name: t?.name ?? 'Tournament' }
      }
    }
    return {
      roomId: b.roomId,
      p0: i0.address, p0Name: i0.name, p0Hidden: i0.hidden,
      p1: i1.address, p1Name: i1.name, p1Hidden: i1.hidden,
      turn: b.turn,
      stakeWei: b.stakeWei,
      wagerId: b.wagerId,
      tournament,
      spectators: b.spectators,
      startedAt: b.startedAt,
    }
  })

  // Highest-stake matches first (the ones worth watching), then the newest.
  battles.sort((a, z) => {
    const sa = BigInt(a.stakeWei || '0')
    const sz = BigInt(z.stakeWei || '0')
    if (sa !== sz) return sa > sz ? -1 : 1
    return z.startedAt - a.startedAt
  })

  res.json({ battles })
})

/**
 * How many wins over the SAME opponent count, IN FREE PLAY ONLY.
 *
 * Free matches cost nothing, so two accounts in two tabs can trade wins as fast
 * as they can click and top the board by the end of launch day. Repeat matches
 * with a regular rival are normal, so the cap is generous rather than one.
 *
 * Paid wagers are deliberately exempt: every match costs both players a real
 * stake and the winner pays a fee out of the pot, so farming them loses money.
 * A staked win is a real win and counts in full, however many times you do it.
 */
const RIVAL_CAP = Number(process.env.RIVAL_CAP ?? 3)

/** Distinct opponents needed to rank on free play alone. Any paid wager also qualifies. */
const MIN_OPPONENTS = Number(process.env.MIN_OPPONENTS ?? 3)

/**
 * The leaderboard, computed from actual battles rather than the running totals
 * on `users`.
 *
 * Those totals are the player's honest personal record and stay untouched — the
 * profile still shows every win. This is the ranked view, which deliberately
 * counts differently: at most RIVAL_CAP results against any one opponent, and
 * you need MIN_OPPONENTS distinct people played before you appear.
 */
app.get('/api/leaderboard', (_req, res) => {
  const rows = db.prepare(`
    WITH decided AS (
      SELECT CASE WHEN b.winner = 0 THEN b.p0 ELSE b.p1 END AS victor,
             CASE WHEN b.winner = 0 THEN b.p1 ELSE b.p0 END AS beaten,
             -- "Ranked" = a competitive game that counts in full and is exempt
             -- from the rival cap: a staked wager, OR a tournament bracket match.
             CASE WHEN EXISTS (
               SELECT 1 FROM wagers w
               WHERE w.id = b.wager_id AND w.stake_wei != '0'
             ) OR EXISTS (
               SELECT 1 FROM tournament_matches tm WHERE tm.battle_id = b.id
             ) THEN 1 ELSE 0 END AS ranked
      FROM battles b
      WHERE b.ended_at IS NOT NULL AND b.winner IS NOT NULL
        AND b.p0 != :bot AND b.p1 != :bot
    ),
    pairs AS (
      SELECT victor AS player, beaten AS foe, ranked, COUNT(*) AS n, 1 AS won FROM decided
      GROUP BY victor, beaten, ranked
      UNION ALL
      SELECT beaten AS player, victor AS foe, ranked, COUNT(*) AS n, 0 AS won FROM decided
      GROUP BY beaten, victor, ranked
    ),
    capped AS (
      -- Ranked results count in full; casual free ones are capped per opponent.
      SELECT player, foe, won, ranked,
             CASE WHEN ranked = 1 THEN n ELSE MIN(n, :cap) END AS n
      FROM pairs
    ),
    totals AS (
      SELECT player AS address,
             SUM(CASE WHEN won = 1 THEN n ELSE 0 END) AS wins,
             SUM(CASE WHEN won = 0 THEN n ELSE 0 END) AS losses,
             COUNT(DISTINCT foe) AS opponents,
             COUNT(DISTINCT CASE WHEN ranked = 0 THEN foe END) AS free_opponents,
             SUM(CASE WHEN ranked = 1 THEN n ELSE 0 END) AS ranked_played
      FROM capped GROUP BY player
    )
    SELECT t.address,
           u.name,
           COALESCE(u.hide_wallet, 0) AS hide_wallet,
           t.wins, t.losses, t.opponents,
           COALESCE(u.draws, 0) AS draws,
           COALESCE(u.tournament_wins, 0) AS tournamentWins,
           (t.wins + t.losses) AS played,
           CASE WHEN (t.wins + t.losses) = 0 THEN 0.0
                ELSE CAST(t.wins AS REAL) / (t.wins + t.losses) END AS winrate
    FROM totals t
    LEFT JOIN users u ON u.address = t.address
    -- A ranked game (wager or tournament match) puts you on the board; the
    -- distinct-opponent bar exists only to stop casual free play being farmed.
    WHERE t.ranked_played > 0 OR t.free_opponents >= :minOpponents
    ORDER BY t.wins DESC, winrate DESC, t.losses ASC
    LIMIT 100
  `).all({ bot: BOT_ADDRESS, cap: RIVAL_CAP, minOpponents: MIN_OPPONENTS }) as
    Record<string, unknown>[]

  // Wei does not survive JSON as a number, so send it as a string.
  const pnl = realisedPnl()
  const players = rows.map((r) => {
    const real = String(r.address)
    const hidden = Boolean(r.hide_wallet)
    const netWei = (pnl.get(real) ?? 0n).toString()
    const { hide_wallet, ...rest } = r
    void hide_wallet
    // A private player still ranks and shows their record — only the address
    // is withheld, and it never leaves the server.
    return { ...rest, address: hidden ? '' : real, hidden, netWei }
  })

  // The Champions board: most tournament titles won. Same privacy rule.
  const champions = tour.champions(20).map((c) => {
    const hidden = Boolean(c.hide_wallet)
    return { name: c.name, address: hidden ? '' : c.address, hidden, wins: c.tournament_wins }
  })

  res.json({ players, champions })
})

/**
 * Realised profit and loss, in wei, per address.
 *
 * Only wagers that actually settled on chain count — an open or in-flight
 * wager has moved no money, and a refund (draw or timeout) nets to zero by
 * definition. Nothing here is estimated: every figure comes from a stake that
 * was escrowed and a result that was settled.
 *
 *   winner:  +stake − fee     (they get the pot back minus the house cut)
 *   loser:   −stake
 *
 * Computed in BigInt rather than SQL because stakes are wei stored as text,
 * and summing 18-decimal numbers in SQLite would overflow or lose precision.
 */
function realisedPnl(): Map<string, bigint> {
  const rows = db.prepare(`
    SELECT w.stake_wei, w.fee_bps, b.winner, b.p0, b.p1
    FROM wagers w
    JOIN battles b ON b.id = w.battle_id
    WHERE w.status = 'settled'
      AND w.onchain_id IS NOT NULL
      AND w.stake_wei != '0'
      AND b.winner IS NOT NULL
  `).all() as {
    stake_wei: string; fee_bps: number | null; winner: number; p0: string; p1: string
  }[]

  const net = new Map<string, bigint>()
  const add = (addr: string, delta: bigint) =>
    net.set(addr, (net.get(addr) ?? 0n) + delta)

  for (const r of rows) {
    let stake: bigint
    try {
      stake = BigInt(r.stake_wei)
    } catch {
      continue
    }
    if (stake <= 0n) continue

    const winner = r.winner === 0 ? r.p0 : r.p1
    const loser = r.winner === 0 ? r.p1 : r.p0

    // The fee comes off the whole pot, which is both stakes.
    const bps = BigInt(r.fee_bps ?? 0)
    const fee = (stake * 2n * bps) / 10000n

    add(winner, stake - fee)
    add(loser, -stake)
  }
  return net
}

/** So the page can explain the ranking rather than looking arbitrary. */
app.get('/api/leaderboard/rules', (_req, res) => {
  res.json({ rivalCap: RIVAL_CAP, minOpponents: MIN_OPPONENTS })
})

/**
 * Machine-readable health, for the watchdog.
 *
 * Public by default but deliberately terse — the detailed body names wager ids
 * and error strings, so it is only returned with the right token. Set
 * HEALTH_TOKEN and pass `?token=` or an `x-health-token` header.
 *
 * Status codes matter more than the body: 200 healthy, 503 not. A watchdog that
 * only reads the code still does the right thing.
 */
app.get('/api/health', (req, res) => {
  const checks: { name: string; ok: boolean; detail?: string }[] = []

  try {
    db.prepare('SELECT 1').get()
    checks.push({ name: 'database', ok: true })
  } catch (e) {
    checks.push({ name: 'database', ok: false, detail: (e as Error).message })
  }

  // Paid wagers whose battle finished but whose pot is still escrowed. This is
  // the one that costs a player real money if it is ignored.
  let stuck: { id: number; onchain_id: string; ended_at: number }[] = []
  try {
    stuck = db.prepare(`
      SELECT w.id, w.onchain_id, b.ended_at
      FROM wagers w JOIN battles b ON b.id = w.battle_id
      WHERE w.status = 'awaiting_settlement'
        AND w.onchain_id IS NOT NULL
        AND b.ended_at IS NOT NULL
        AND b.ended_at <= ?
    `).all(now() - STUCK_SETTLEMENT_SECONDS) as typeof stuck
  } catch { /* the database check above already reported the failure */ }

  checks.push({
    name: 'settlements',
    ok: stuck.length === 0,
    detail: stuck.length
      ? `${stuck.length} unclaimed past ${STUCK_SETTLEMENT_SECONDS}s: ${stuck.map((s) => `#${s.onchain_id}`).join(', ')}`
      : undefined,
  })

  if (settlementEnabled) {
    // Silence from the reconciler means we would not notice a stuck pot at all.
    // A freshly booted process has legitimately not run one yet, so give it a
    // grace period — otherwise every restart pages someone.
    const age = health.lastReconcileAt ? now() - health.lastReconcileAt : Infinity
    const booting = !health.lastReconcileAt && now() - STARTED_AT < 90
    checks.push({
      name: 'reconciler',
      ok: age < 180 || booting,
      detail: health.lastReconcileError
        ? `last error: ${health.lastReconcileError}`
        : Number.isFinite(age)
          ? `last ran ${age}s ago`
          : booting ? 'starting up' : 'has never completed a pass',
    })
  }

  // The tournament twins of the two checks above: a finished paid tournament
  // whose pot is still unsettled, and the tournament reconciler's own liveness.
  if (tournamentSettlementEnabled) {
    let stuckT: { id: number; onchain_id: string; ended_at: number }[] = []
    try {
      stuckT = db.prepare(`
        SELECT id, onchain_id, ended_at FROM tournaments
        WHERE status = 'finished' AND winner IS NOT NULL
          AND onchain_id IS NOT NULL AND settled_onchain IS NULL
          AND ended_at IS NOT NULL AND ended_at <= ?
      `).all(now() - STUCK_SETTLEMENT_SECONDS) as typeof stuckT
    } catch { /* the database check already reported the failure */ }

    checks.push({
      name: 'tournament-settlements',
      ok: stuckT.length === 0,
      detail: stuckT.length
        ? `${stuckT.length} finished but unsettled past ${STUCK_SETTLEMENT_SECONDS}s: ${stuckT.map((s) => `#${s.onchain_id}`).join(', ')}`
        : undefined,
    })

    // A pot that closed sign-ups without enough players to run is holding money
    // that nobody can claim until it is cancelled on chain. Entrants can do that
    // themselves, but nothing makes them look — so page someone.
    let underfilled: { id: number; players: number }[] = []
    try {
      underfilled = underfilledPaidTournaments()
    } catch { /* the database check already reported the failure */ }

    checks.push({
      name: 'tournament-underfilled',
      ok: underfilled.length === 0,
      detail: underfilled.length
        ? `${underfilled.length} paid pot(s) closed without enough players, refunds not unlocked: ${underfilled.map((u) => `#${u.id} (${u.players})`).join(', ')}`
        : undefined,
    })

    const ageT = health.lastTournamentReconcileAt ? now() - health.lastTournamentReconcileAt : Infinity
    const bootingT = !health.lastTournamentReconcileAt && now() - STARTED_AT < 90
    checks.push({
      name: 'tournament-reconciler',
      ok: ageT < 180 || bootingT,
      detail: health.lastTournamentReconcileError
        ? `last error: ${health.lastTournamentReconcileError}`
        : Number.isFinite(ageT)
          ? `last ran ${ageT}s ago`
          : bootingT ? 'starting up' : 'has never completed a pass',
    })
  }

  checks.push({
    name: 'errors',
    ok: health.unhandledErrors === 0,
    detail: health.lastUnhandledError ?? undefined,
  })

  const ok = checks.every((c) => c.ok)
  const token = process.env.HEALTH_TOKEN
  const supplied = (req.query.token as string | undefined) ?? req.get('x-health-token')
  const detailed = !token || supplied === token

  res.status(ok ? 200 : 503).json(
    detailed
      ? {
          ok,
          uptime: now() - STARTED_AT,
          liveBattles: activeRoomCount(),
          checks,
        }
      : { ok, failing: checks.filter((c) => !c.ok).map((c) => c.name) },
  )
})

app.get('/api/stats', (_req, res) => {
  // Practice matches are excluded: they are not contests between trainers, and
  // counting them would inflate the public number with solo play.
  const battles = (db.prepare(
    'SELECT COUNT(*) AS n FROM battles WHERE ended_at IS NOT NULL AND p0 != ? AND p1 != ?',
  ).get(BOT_ADDRESS, BOT_ADDRESS) as { n: number }).n
  // "Players ranked" must mean what the leaderboard actually ranks, or the
  // headline number disagrees with the table right underneath it.
  const players = (db.prepare(`
    WITH decided AS (
      SELECT CASE WHEN b.winner = 0 THEN b.p0 ELSE b.p1 END AS victor,
             CASE WHEN b.winner = 0 THEN b.p1 ELSE b.p0 END AS beaten,
             -- Same "ranked" rule as /api/leaderboard: a wager or a tournament match.
             CASE WHEN EXISTS (
               SELECT 1 FROM wagers w WHERE w.id = b.wager_id AND w.stake_wei != '0'
             ) OR EXISTS (
               SELECT 1 FROM tournament_matches tm WHERE tm.battle_id = b.id
             ) THEN 1 ELSE 0 END AS ranked
      FROM battles b
      WHERE b.ended_at IS NOT NULL AND b.winner IS NOT NULL
        AND b.p0 != :bot AND b.p1 != :bot
    ),
    faced AS (
      SELECT victor AS player, beaten AS foe, ranked FROM decided
      UNION ALL
      SELECT beaten AS player, victor AS foe, ranked FROM decided
    )
    SELECT COUNT(*) AS n FROM (
      SELECT player FROM faced GROUP BY player
      HAVING SUM(ranked) > 0
          OR COUNT(DISTINCT CASE WHEN ranked = 0 THEN foe END) >= :minOpponents
    )
  `).get({ bot: BOT_ADDRESS, minOpponents: MIN_OPPONENTS }) as { n: number }).n
  const openWagers = (db.prepare("SELECT COUNT(*) AS n FROM wagers WHERE status = 'open' AND expires_at > ?")
    .get(now()) as { n: number }).n

  // Total ETH staked on the site. Two sources, summed with BigInt because wei
  // totals overflow SQLite's 64-bit integer:
  //   • head-to-head wagers — both trainers escrow the stake, so a contested
  //     wager locks 2× stake_wei. Only wagers that actually reached a contest
  //     count (matched/playing/settled); open and cancelled ones aren't staked.
  //   • tournament prize pools — every entry pays the entry fee into the pool,
  //     so the pool of a running/finished tournament is its total staked ETH.
  let stakedWei = 0n
  for (const r of db.prepare(
    "SELECT stake_wei FROM wagers WHERE stake_wei != '0' AND status IN ('matched','playing','settled')",
  ).all() as { stake_wei: string }[]) {
    try { stakedWei += BigInt(r.stake_wei) * 2n } catch { /* skip malformed */ }
  }
  for (const r of db.prepare(`
    SELECT t.entry_fee_wei AS fee
    FROM tournament_entries e
    JOIN tournaments t ON t.id = e.tournament_id
    WHERE t.entry_fee_wei != '0' AND t.status IN ('running', 'finished')
  `).all() as { fee: string }[]) {
    try { stakedWei += BigInt(r.fee) } catch { /* skip malformed */ }
  }

  res.json({
    battles, players, openWagers,
    liveBattles: activeRoomCount(),
    queued: queue.queueSize(),
    turnSeconds: TURN_SECONDS,
    stakedWei: stakedWei.toString(),
  })
})

/* ------------------------------------------------------------------ */
/* tournaments                                                         */
/* ------------------------------------------------------------------ */

/** Public view of a tournament, with the bracket if it has started. */
function tournamentView(id: number, viewer: string | null) {
  const t = tour.get(id)
  if (!t) return null
  const entries = tour.entriesOf(id)
  const matches = tour.matchesOf(id)

  const isAdmin = viewer ? tour.isAdmin(viewer) : false
  // A hidden champion's wallet is withheld from the public view; the admin still
  // gets it (separately, below) because the manual prize payout needs it.
  const winnerId = t.winner ? maskInTournament(t.winner, viewer) : null
  return {
    id: t.id,
    name: t.name,
    createdBy: t.created_by,
    entryFeeWei: t.entry_fee_wei,
    // The backing pool tournament id + address, so a paid entrant knows where to
    // pay. Null for a free tournament.
    onchainId: t.onchain_id,
    pool: t.onchain_id ? tournamentPoolAddress : null,
    maxPlayers: t.max_players,
    status: t.status,
    startAt: t.start_at,
    winner: winnerId?.address ?? null,
    winnerName: winnerId?.name ?? null,
    winnerHidden: winnerId?.hidden ?? false,
    // Whether a champion exists at all, independent of masking — the UI must not
    // infer it from the (maskable) winner address, or a hidden champion would let
    // beaten entrants reach the "no winner" timeout-refund escape hatch.
    hasWinner: Boolean(t.winner),
    // The real champion wallet, for the admin's manual prize payout only.
    winnerPayout: isAdmin ? t.winner : null,
    // An optional hand-paid prize (US cents) + the live rate to show it in ETH.
    prizeUsdCents: t.prize_usd_cents,
    ethUsd: ethUsd(),
    createdAt: t.created_at,
    startedAt: t.started_at,
    endedAt: t.ended_at,
    players: entries.map((e) => {
      const pid = maskInTournament(e.address, viewer)
      return { address: pid.address, name: pid.name, hidden: pid.hidden, seed: e.seed }
    }),
    rounds: tour.roundCount(id),
    matches: matches.map((m) => {
      const s0 = m.p0 ? maskInTournament(m.p0, viewer) : null
      const s1 = m.p1 ? maskInTournament(m.p1, viewer) : null
      const w = m.winner ? maskInTournament(m.winner, viewer) : null
      return {
        id: m.id,
        round: m.round,
        slot: m.slot,
        p0: s0?.address ?? null,
        p1: s1?.address ?? null,
        p0Name: s0?.name ?? null,
        p1Name: s1?.name ?? null,
        p0Hidden: s0?.hidden ?? false,
        p1Hidden: s1?.hidden ?? false,
        p0Filled: m.p0 != null,
        p1Filled: m.p1 != null,
        // Win/loss decided from the RAW addresses here, so the client can
        // highlight the bracket without ever comparing (masked) wallets.
        p0Won: m.winner != null && m.winner === m.p0,
        p1Won: m.winner != null && m.winner === m.p1,
        decided: m.winner != null,
        winner: w?.address ?? null,
        status: m.status,
        battleId: m.battle_id,
      }
    }),
    you: viewer
      ? {
          entered: entries.some((e) => e.address === viewer),
          isAdmin,
          playableMatchId: tour.playableFor(id, viewer)?.id ?? null,
        }
      : null,
  }
}

app.get('/api/tournaments', (req, res) => {
  const viewer = sessionAddress(bearer(req))
  const rows = db.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM tournament_entries e WHERE e.tournament_id = t.id) AS players
     FROM tournaments t
     WHERE t.status != 'cancelled'
     ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'running' THEN 1 ELSE 2 END, t.created_at DESC
     LIMIT 50`,
  ).all() as (tour.TournamentRow & { players: number })[]

  res.json({
    canCreate: viewer ? tour.isAdmin(viewer) : false,
    paidEntryAvailable: tour.paidEntryAvailable(),
    // The live ETH/USD rate, so a dollar prize can be shown in ETH. Null if the
    // ticker has not fetched yet — the UI then just omits the ETH figure.
    ethUsd: ethUsd(),
    tournaments: rows.map((t) => ({
      id: t.id,
      name: t.name,
      entryFeeWei: t.entry_fee_wei,
      maxPlayers: t.max_players,
      players: t.players,
      status: t.status,
      startAt: t.start_at,
      // A hidden champion's wallet is withheld here too, though the list does not
      // render it — the raw JSON must not carry it either.
      winner: t.winner ? publicIdentity(t.winner).address : null,
      createdAt: t.created_at,
      prizeUsdCents: t.prize_usd_cents,
    })),
  })
})

app.get('/api/tournaments/:id', (req, res) => {
  const view = tournamentView(Number(req.params.id), sessionAddress(bearer(req)))
  if (!view) return res.status(404).json({ error: 'No such tournament.' })
  res.json(view)
})

app.post('/api/tournaments', requireAuth, rateLimit(20, 60, 'address'), (req, res) => {
  const me = addrOf(req)
  if (!tour.isAdmin(me)) return res.status(403).json({ error: 'Not allowed.' })

  const { name, maxPlayers, entryFeeWei, onchainId, startAt, prizeUsdCents } = req.body ?? {}
  const made = tour.create({
    name: String(name ?? ''),
    createdBy: me,
    maxPlayers: Number(maxPlayers),
    entryFeeWei: String(entryFeeWei ?? '0'),
    onchainId: onchainId != null ? String(onchainId) : null,
    startAt: startAt != null ? Number(startAt) : null,
    prizeUsdCents: prizeUsdCents != null ? Number(prizeUsdCents) : null,
  })
  if ('error' in made) return res.status(400).json({ error: made.error })
  res.json(made)
})

app.post('/api/tournaments/:id/cancel', requireAuth, (req, res) => {
  const me = addrOf(req)
  const t = tour.get(Number(req.params.id))
  if (!t) return res.status(404).json({ error: 'No such tournament.' })
  if (!tour.isAdmin(me)) return res.status(403).json({ error: 'Not allowed.' })
  const r = tour.cancel(t.id)
  if ('error' in r) return res.status(400).json({ error: r.error })
  // For a paid tournament, the organizer must also cancel the pool on chain (a
  // wallet action) so entrants can claimRefund; the frontend does that first.
  res.json({ ok: true, paid: BigInt(t.entry_fee_wei) > 0n })
})

app.post('/api/tournaments/:id/extend', requireAuth, (req, res) => {
  const me = addrOf(req)
  const t = tour.get(Number(req.params.id))
  if (!t) return res.status(404).json({ error: 'No such tournament.' })
  if (!tour.isAdmin(me)) return res.status(403).json({ error: 'Not allowed.' })
  const startAt = Number(req.body?.startAt)
  const r = tour.extendStart(t.id, startAt)
  if ('error' in r) return res.status(400).json({ error: r.error })
  res.json({ ok: true })
})

app.post('/api/tournaments/:id/join', requireAuth, rateLimit(30, 60, 'address'), async (req, res) => {
  const { teamId } = req.body ?? {}
  if (typeof teamId !== 'number') return res.status(400).json({ error: 'teamId is required' })

  const id = Number(req.params.id)
  const me = addrOf(req)
  const t = tour.get(id)
  if (!t) return res.status(404).json({ error: 'No such tournament.' })

  // For a paid tournament, the on-chain pool is the source of truth for who paid
  // in. Confirm the player is an entrant of the backing pool tournament BEFORE
  // seating them — otherwise someone could enter the bracket, and the pot, for
  // free. A free tournament skips this entirely.
  let onchainVerified = false
  if (BigInt(t.entry_fee_wei) > 0n) {
    if (!t.onchain_id) return res.status(409).json({ error: 'This paid tournament has no on-chain pool.' })
    if (!tournamentSettlementEnabled) {
      return res.status(503).json({ error: 'Tournament settlement is not configured.' })
    }
    try {
      onchainVerified = await isOnchainEntrant(BigInt(t.onchain_id), me as `0x${string}`)
    } catch (e) {
      return res.status(502).json({ error: `Could not verify on-chain entry: ${(e as Error).message.split('\n')[0]}` })
    }
    if (!onchainVerified) {
      return res.status(402).json({ error: 'Pay the entry fee to the tournament pool on chain first.' })
    }
  }

  const r = tour.join(id, me, teamId, loadTeam, onchainVerified)
  if ('error' in r) return res.status(r.status ?? 400).json({ error: r.error })
  res.json({ ok: true })
})

app.post('/api/tournaments/:id/leave', requireAuth, async (req, res) => {
  const id = Number(req.params.id)
  const me = addrOf(req)
  const t = tour.get(id)
  if (!t) return res.status(404).json({ error: 'No such tournament.' })

  // For a paid tournament the player takes their fee back by calling
  // leaveTournament on the pool (a wallet action); the frontend does that first.
  // Only drop their bracket seat once the chain confirms they are no longer an
  // entrant — otherwise a seat and an on-chain stake could disagree.
  if (BigInt(t.entry_fee_wei) > 0n && t.onchain_id) {
    if (!tournamentSettlementEnabled) {
      return res.status(503).json({ error: 'Tournament settlement is not configured.' })
    }
    try {
      if (await isOnchainEntrant(BigInt(t.onchain_id), me as `0x${string}`)) {
        return res.status(409).json({ error: 'Leave the pool on chain first, then this will drop your seat.' })
      }
    } catch (e) {
      return res.status(502).json({ error: `Could not verify on-chain state: ${(e as Error).message.split('\n')[0]}` })
    }
  }

  const r = tour.leave(id, me)
  if ('error' in r) return res.status(400).json({ error: r.error })
  res.json({ ok: true })
})

app.post('/api/tournaments/:id/start', requireAuth, async (req, res) => {
  const me = addrOf(req)
  const t = tour.get(Number(req.params.id))
  if (!t) return res.status(404).json({ error: 'No such tournament.' })
  if (!tour.isAdmin(me)) return res.status(403).json({ error: 'Not allowed.' })

  // A paid tournament must not be started before its on-chain registration
  // deadline: joins are still open on chain until then, and drawing the bracket
  // early could strand someone who pays after the seats are set.
  if (BigInt(t.entry_fee_wei) > 0n && t.start_at != null && now() < t.start_at) {
    return res.status(409).json({ error: 'A paid tournament starts automatically when sign-ups close.' })
  }

  const r = await startTournament(t.id)
  if ('error' in r) return res.status(400).json({ error: r.error })
  res.json({ ok: true })
})

/**
 * Starts (or rejoins) the battle for a tournament fixture.
 *
 * Either player may call it. The first creates the room; the second finds
 * themselves already in it, which is how the normal lobby handles a match that
 * is already running.
 */
app.post('/api/tournaments/:id/play', requireAuth, (req, res) => {
  const me = addrOf(req)
  const id = Number(req.params.id)
  const t = tour.get(id)
  if (!t) return res.status(404).json({ error: 'No such tournament.' })
  if (t.status !== 'running') return res.status(409).json({ error: 'Not running.' })

  const existing = roomForPlayer(me)
  if (existing) return res.json({ roomId: existing.id })

  const m = tour.playableFor(id, me)
  if (!m) return res.status(409).json({ error: 'No match ready for you.' })
  if (!m.p0 || !m.p1) return res.status(409).json({ error: 'Waiting for an opponent.' })

  const foe = m.p0 === me ? m.p1 : m.p0
  if (roomForPlayer(foe)) return res.status(409).json({ error: 'Your opponent is mid-battle.' })

  const myTeamId = tour.teamOf(id, me)
  const foeTeamId = tour.teamOf(id, foe)
  if (myTeamId === null || foeTeamId === null) {
    return res.status(500).json({ error: 'A player has no registered team.' })
  }
  const myTeam = loadTeam(myTeamId, me)
  const foeTeam = loadTeam(foeTeamId, foe)
  if (!myTeam || !foeTeam) return res.status(400).json({ error: 'A registered team is no longer legal.' })

  const room = createRoom(
    { address: m.p0, team: m.p0 === me ? myTeam : foeTeam },
    { address: m.p1, team: m.p1 === me ? myTeam : foeTeam },
    null,
    '0',
    m.id,
  )
  db.prepare("UPDATE tournament_matches SET status = 'playing', battle_id = ? WHERE id = ?")
    .run(room.id, m.id)

  res.json({ roomId: room.id })
})

/* ------------------------------------------------------------------ */
/* matchmaking                                                         */
/* ------------------------------------------------------------------ */

/**
 * Join the free-play queue, or pair immediately if someone is already waiting.
 *
 * Pairing happens synchronously inside join(), so two people cannot both sit
 * in the queue believing the other is not there.
 */
app.post('/api/queue/join', requireAuth, rateLimit(60, 60, 'address'), (req, res) => {
  const me = addrOf(req)
  const { teamId } = req.body ?? {}
  if (typeof teamId !== 'number') return res.status(400).json({ error: 'teamId is required' })

  const team = loadTeam(teamId, me)
  if (!team) return res.status(400).json({ error: 'team not found or no longer legal' })

  const result = queue.join(me, teamId, team)
  if (result.kind === 'error') return res.status(400).json({ error: result.error })
  res.json(result)
})

/**
 * Polled while waiting. Doubles as the heartbeat that holds the slot: a player
 * who closes the tab stops polling and is dropped rather than blocking others.
 */
app.get('/api/queue/status', requireAuth, (req, res) => {
  res.json(queue.status(addrOf(req)))
})

app.post('/api/queue/leave', requireAuth, (req, res) => {
  queue.leave(addrOf(req))
  res.json({ ok: true })
})

/* ------------------------------------------------------------------ */
/* settlement                                                          */
/* ------------------------------------------------------------------ */

app.get('/api/settlement/status', (_req, res) => {
  res.json({ enabled: settlementEnabled, arbiter: arbiterAddress })
})

/**
 * Paid wagers this player took part in whose battle has finished.
 *
 * The on-chain state is deliberately not consulted here — the client reads
 * `statusOf(id)` itself to decide whether a wager still needs settling, so a
 * slow or unreachable RPC cannot stop this list from rendering.
 */
app.get('/api/wagers/mine/finished', requireAuth, (req, res) => {
  const me = addrOf(req)
  const rows = db.prepare(`
    SELECT w.id, w.onchain_id, w.stake_wei, w.creator, w.opponent, w.battle_id,
           b.winner, b.p0, b.p1, b.ended_at
    FROM wagers w
    JOIN battles b ON b.id = w.battle_id
    WHERE w.onchain_id IS NOT NULL
      AND b.ended_at IS NOT NULL
      AND (w.creator = ? OR w.opponent = ?)
    ORDER BY b.ended_at DESC
    LIMIT 50
  `).all(me, me) as {
    id: number; onchain_id: string; stake_wei: string; creator: string; opponent: string
    battle_id: string; winner: number | null; p0: string; p1: string; ended_at: number
  }[]

  res.json(
    rows.map((r) => ({
      id: r.id,
      onchainId: r.onchain_id,
      stakeWei: r.stake_wei,
      battleId: r.battle_id,
      endedAt: r.ended_at,
      isDraw: r.winner === null,
      winner: r.winner === null ? null : r.winner === 0 ? r.p0 : r.p1,
      youWon: r.winner !== null && (r.winner === 0 ? r.p0 : r.p1) === me,
      opponent: r.creator === me ? r.opponent : r.creator,
    })),
  )
})

/**
 * Returns the arbiter signature for a finished wagered battle. The winner
 * submits it to the escrow contract themselves — the server never needs gas,
 * and cannot be griefed into paying fees.
 */
app.get('/api/wagers/:id/settlement', async (req, res) => {
  const w = db.prepare('SELECT * FROM wagers WHERE id = ?').get(String(req.params.id)) as
    | { id: number; onchain_id: string | null; battle_id: string | null; stake_wei: string; creator: string; opponent: string | null }
    | undefined
  if (!w || !w.battle_id) return res.status(404).json({ error: 'no such wager' })
  if (!w.onchain_id) return res.status(400).json({ error: 'free wager, nothing to settle' })
  if (!settlementEnabled) return res.status(503).json({ error: 'settlement not configured' })

  const b = db.prepare('SELECT winner, ended_at, p0, p1 FROM battles WHERE id = ?')
    .get(w.battle_id) as { winner: number | null; ended_at: number | null; p0: string; p1: string } | undefined
  if (!b || !b.ended_at) return res.status(400).json({ error: 'battle not finished' })

  const wagerId = BigInt(w.onchain_id)
  // Read the nonce from the contract rather than deriving it from the id.
  let nonce: bigint
  try {
    nonce = await wagerNonce(wagerId)
  } catch (e) {
    return res.status(502).json({
      error: `could not read the wager from the escrow contract: ${(e as Error).message}`,
    })
  }

  if (b.winner === null) {
    return res.json({ kind: 'draw', wagerId: w.onchain_id, signature: await signDraw(wagerId, nonce) })
  }
  const winner = (b.winner === 0 ? b.p0 : b.p1) as `0x${string}`
  res.json({
    kind: 'win',
    wagerId: w.onchain_id,
    winner,
    signature: await signResult(wagerId, winner, nonce),
  })
})

app.get('/api/tournaments/settlement/status', (_req, res) => {
  res.json({
    enabled: tournamentSettlementEnabled,
    arbiter: tournamentArbiterAddress,
    pool: tournamentPoolAddress,
  })
})

/**
 * Returns the arbiter signature that settles a finished PAID tournament. Like
 * the wager path, the WINNER submits it to the pool themselves — the server
 * needs no gas and cannot be griefed into paying.
 *
 * The signature is only ever produced for the tournament's real champion once
 * the whole bracket is done, and only while the pool still says OPEN (so a
 * settled or refunding tournament yields nothing).
 */
app.get('/api/tournaments/:id/settlement', async (req, res) => {
  const t = tour.get(Number(req.params.id))
  if (!t) return res.status(404).json({ error: 'No such tournament.' })
  if (!t.onchain_id) return res.status(400).json({ error: 'Free tournament, nothing to settle.' })
  if (!tournamentSettlementEnabled) return res.status(503).json({ error: 'Tournament settlement not configured.' })
  if (t.status !== 'finished' || !t.winner) {
    return res.status(400).json({ error: 'Tournament is not finished.' })
  }

  const poolId = BigInt(t.onchain_id)
  // Read the on-chain status + nonce rather than trusting our own record: the
  // signature must match the live contract, and a tournament already settled or
  // in refund must not be handed a fresh winner signature.
  let status: number
  let nonce: bigint
  try {
    ;[status, nonce] = await Promise.all([tournamentStatus(poolId), tournamentNonce(poolId)])
  } catch (e) {
    return res.status(502).json({
      error: `could not read the tournament from the pool contract: ${(e as Error).message.split('\n')[0]}`,
    })
  }
  // Status enum: 0 NONE, 1 OPEN, 2 SETTLED, 3 REFUNDING.
  if (status !== 1) {
    return res.status(409).json({ error: 'The pool is no longer open for settlement.', onchainStatus: status })
  }

  const winner = t.winner as `0x${string}`
  res.json({
    kind: 'win',
    tournamentId: t.onchain_id,
    winner,
    signature: await signTournamentResult(poolId, winner, nonce),
  })
})

/* ------------------------------------------------------------------ */
/* websocket                                                           */
/* ------------------------------------------------------------------ */

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (sock, req) => {
  const url = new URL(req.url ?? '/', 'http://x')

  // Spectators watch a match read-only. Anyone may watch — a battle exposes
  // nothing here the two players do not already show each other — so no sign-in
  // is required. A watcher is never seated, so it can neither act nor forfeit.
  if (url.searchParams.get('spectate')) {
    const room = getRoom(url.searchParams.get('room') ?? '')
    if (!room || room.practice) {
      sock.send(JSON.stringify({ type: 'error', error: 'no live battle to watch' }))
      return sock.close()
    }
    addSpectator(room, sock)
    // A watcher's messages are ignored — it has no seat and cannot submit.
    sock.on('close', () => removeSpectator(room, sock))
    return
  }

  const address = sessionAddress(url.searchParams.get('token') ?? undefined)

  if (!address) {
    sock.send(JSON.stringify({ type: 'error', error: 'not signed in' }))
    return sock.close()
  }

  const room = roomForPlayer(address) ?? getRoom(url.searchParams.get('room') ?? '')
  if (!room || !attachSocket(room, address, sock)) {
    sock.send(JSON.stringify({ type: 'error', error: 'no active battle' }))
    return sock.close()
  }

  sock.on('message', (raw) => {
    let msg: { type?: string; action?: unknown }
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return sock.send(JSON.stringify({ type: 'error', error: 'bad json' }))
    }
    if (msg.type !== 'action') return

    const a = msg.action as { kind?: string; index?: unknown }
    if (
      !a || (a.kind !== 'move' && a.kind !== 'switch') ||
      typeof a.index !== 'number' || !Number.isInteger(a.index) || a.index < 0 || a.index > 5
    ) {
      return sock.send(JSON.stringify({ type: 'error', error: 'bad action' }))
    }

    const err = submitAction(room, address, a as never)
    if (err) sock.send(JSON.stringify({ type: 'error', error: err }))
  })

  sock.on('close', () => detachSocket(room, address))
})

/* ------------------------------------------------------------------ */
/* settlement hook + housekeeping                                      */
/* ------------------------------------------------------------------ */

setEndHook((room: Room, winner) => {
  if (room.tournamentMatchId !== null) {
    const address = winner === null ? null : room.seats[winner].address
    tour.onBattleEnd(room.tournamentMatchId, address, room.id)
  }
  if (room.wagerId === null) return
  const label = winner === null ? 'draw' : room.seats[winner].address

  // A free wager is finished the moment the battle is. A paid one is NOT:
  // the pot is still escrowed until the winner calls settle themselves, and
  // marking it 'settled' here would be the server claiming money had moved
  // when nothing on chain had happened yet.
  const paid = db.prepare('SELECT onchain_id FROM wagers WHERE id = ?')
    .get(room.wagerId) as { onchain_id: string | null } | undefined

  const next = paid?.onchain_id ? 'awaiting_settlement' : 'settled'
  db.prepare('UPDATE wagers SET status = ? WHERE id = ?').run(next, room.wagerId)
  console.log(`[battle] wager ${room.wagerId} battle ${room.id} -> ${label} (${next})`)
})

/**
 * Reconciles escrowed wagers against the chain.
 *
 * The winner settles from their own wallet, so the server never learns the
 * outcome by writing it — it has to go and look. Until this runs, a finished
 * paid wager sits in `awaiting_settlement`, which is the honest description:
 * the battle is over, the pot is not.
 *
 * This matters beyond bookkeeping. If nobody calls `settle` before the
 * contract's timeout, either player can `claimTimeout` and BOTH stakes are
 * refunded — so a winner who never claims quietly loses their winnings.
 */
/* ------------------------------------------------------------------ */
/* health tracking                                                     */
/* ------------------------------------------------------------------ */

const STARTED_AT = now()

/**
 * How long a finished paid wager may sit unclaimed before we shout.
 *
 * The contract's default settleTimeout is one hour, after which either player
 * can refund BOTH stakes and the winner loses their winnings. Alerting at 15
 * minutes leaves time to actually do something about it.
 */
const STUCK_SETTLEMENT_SECONDS = Number(process.env.STUCK_SETTLEMENT_SECONDS ?? 15 * 60)

const health = {
  lastReconcileAt: 0,
  lastReconcileError: null as string | null,
  reconcileFailures: 0,
  lastTournamentReconcileAt: 0,
  lastTournamentReconcileError: null as string | null,
  unhandledErrors: 0,
  lastUnhandledError: null as string | null,
}

process.on('unhandledRejection', (e) => {
  health.unhandledErrors++
  health.lastUnhandledError = String(e).slice(0, 300)
  console.error('[unhandled]', e)
})

async function reconcileSettlements() {
  if (!settlementEnabled) return
  const rows = db.prepare(
    "SELECT id, onchain_id FROM wagers WHERE status = 'awaiting_settlement' AND onchain_id IS NOT NULL",
  ).all() as { id: number; onchain_id: string }[]

  let failed = false
  for (const row of rows) {
    try {
      const status = await wagerStatus(BigInt(row.onchain_id))
      // 3 = SETTLED, 4 = REFUNDED in the contract's enum.
      if (status === 3 || status === 4) {
        const next = status === 3 ? 'settled' : 'refunded'
        // Record the fee that actually applied, so profit and loss stay
        // correct even if the contract's fee is changed later.
        const fee = status === 3 ? await currentFeeBps().catch(() => null) : null
        db.prepare('UPDATE wagers SET status = ?, fee_bps = ? WHERE id = ?')
          .run(next, fee, row.id)
        console.log(`[reconcile] wager ${row.id} -> ${next}`)
      }
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0]
      health.lastReconcileError = `wager ${row.id}: ${msg}`
      health.reconcileFailures++
      console.warn(`[reconcile] wager ${row.id}: ${msg}`)
      failed = true
    }
  }

  health.lastReconcileAt = now()
  if (!failed) health.lastReconcileError = null
}

setInterval(() => { void reconcileSettlements() }, 30_000)
// Run one pass immediately so a restart does not leave the reconciler looking
// silent, and so anything that settled while we were down is picked up at once.
void reconcileSettlements()

/**
 * The tournament twin of reconcileSettlements(). A paid tournament finishes with
 * a champion server-side, but the pot only moves once someone submits the
 * arbiter signature to the pool. This watches for that to happen (or for a
 * timeout/cancel refund), and records the fee that applied.
 */
async function reconcileTournaments() {
  if (!tournamentSettlementEnabled) return
  const rows = db.prepare(
    `SELECT id, onchain_id FROM tournaments
     WHERE status = 'finished' AND winner IS NOT NULL
       AND onchain_id IS NOT NULL AND settled_onchain IS NULL`,
  ).all() as { id: number; onchain_id: string }[]

  let failed = false
  for (const row of rows) {
    try {
      const status = await tournamentStatus(BigInt(row.onchain_id))
      // Pool Status enum: 1 OPEN, 2 SETTLED, 3 REFUNDING.
      if (status === 2) {
        const fee = await tournamentFeeBps().catch(() => null)
        db.prepare('UPDATE tournaments SET settled_onchain = 1, fee_bps = ? WHERE id = ?')
          .run(fee, row.id)
        console.log(`[reconcile] tournament ${row.id} -> settled on chain`)
      } else if (status === 3) {
        // The pool refunded instead of paying the champion — nobody settled in
        // time, or it was cancelled. Mark it resolved so it stops being flagged,
        // but loudly: the champion's prize was NOT paid.
        db.prepare('UPDATE tournaments SET settled_onchain = 2 WHERE id = ?').run(row.id)
        console.warn(`[reconcile] tournament ${row.id} REFUNDED on chain — champion prize was not claimed`)
      }
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0]
      health.lastTournamentReconcileError = `tournament ${row.id}: ${msg}`
      console.warn(`[reconcile] tournament ${row.id}: ${msg}`)
      failed = true
    }
  }

  // An OPEN tournament can also end up refunding: one that never filled is
  // `unrunnable` on chain past its deadline, so ANY entrant may cancel the pool
  // and unlock refunds without waiting for the organizer. Whoever did it, the
  // chain is the source of truth — pick it up so the server stops advertising
  // sign-ups for a pot that is now paying everyone back.
  const openPaid = db.prepare(
    `SELECT id, onchain_id FROM tournaments
     WHERE status = 'open' AND onchain_id IS NOT NULL AND entry_fee_wei != '0'`,
  ).all() as { id: number; onchain_id: string }[]

  for (const row of openPaid) {
    try {
      if ((await tournamentStatus(BigInt(row.onchain_id))) === 3) {
        tour.cancel(row.id)
        console.warn(`[reconcile] tournament ${row.id} REFUNDING on chain — marked cancelled`)
      }
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0]
      health.lastTournamentReconcileError = `tournament ${row.id}: ${msg}`
      failed = true
    }
  }

  health.lastTournamentReconcileAt = now()
  if (!failed) health.lastTournamentReconcileError = null
}

if (tournamentSettlementEnabled) {
  setInterval(() => { void reconcileTournaments() }, 30_000)
  void reconcileTournaments()
}

/**
 * Draw the bracket and open round one. Shared by the admin "start" button and the
 * scheduler. For a paid tournament it first drops any seat whose on-chain entry
 * is gone (someone who left the pool without telling us), so the bracket only
 * ever contains players who actually have money in — the winner-take-all
 * invariant. If the chain can't be read, it does NOT start, so a bracket is never
 * drawn against a roster we couldn't verify.
 */
async function startTournament(id: number): Promise<{ ok: true } | { error: string }> {
  const t = tour.get(id)
  if (!t) return { error: 'No such tournament.' }

  if (BigInt(t.entry_fee_wei) > 0n && t.onchain_id && tournamentSettlementEnabled) {
    for (const e of tour.entriesOf(id)) {
      try {
        if (!(await isOnchainEntrant(BigInt(t.onchain_id), e.address as `0x${string}`))) {
          tour.dropEntry(id, e.address)
        }
      } catch {
        return { error: 'could not verify on-chain entrants — will retry' }
      }
    }
  }

  return tour.start(id)
}

/**
 * Auto-starts tournaments whose scheduled sign-up window has closed, with
 * whoever joined (so a half-full 13/16 or 4/8 still runs). Too few to run: a
 * free one is cancelled outright; a paid one is left for the organizer to cancel
 * on chain (which is what lets its entrants reclaim their fees), so the server
 * never marks a paid pot resolved while the money is still locked in the pool.
 */
/**
 * Underfilled paid pots stay `open` until someone cancels them on chain, and
 * `dueToStart()` keeps handing them back — so the warning below would repeat
 * every 15 seconds forever. Say it once per tournament and let the health check
 * be the thing that keeps nagging.
 */
const warnedUnderfilled = new Set<number>()

async function runTournamentScheduler() {
  for (const t of tour.dueToStart()) {
    const players = tour.entryCount(t.id)
    if (players >= tour.MIN_PLAYERS) {
      const r = await startTournament(t.id)
      if ('ok' in r) console.log(`[scheduler] tournament ${t.id} auto-started with ${players} player(s)`)
      else console.warn(`[scheduler] tournament ${t.id}: ${r.error}`)
    } else if (BigInt(t.entry_fee_wei) === 0n) {
      tour.cancel(t.id)
      console.log(`[scheduler] free tournament ${t.id} cancelled — only ${players} joined`)
    } else if (!warnedUnderfilled.has(t.id)) {
      warnedUnderfilled.add(t.id)
      console.warn(`[scheduler] paid tournament ${t.id} underfilled (${players}) — entrants can cancel the pool on chain to unlock refunds`)
    }
  }
}

/**
 * Paid pots that closed sign-ups without enough players to run. The money is
 * sitting in the pool and someone has to cancel it on chain before anyone can
 * claim; until that happens this stays unhealthy, which is the point.
 */
function underfilledPaidTournaments(): { id: number; players: number }[] {
  const rows = db.prepare(
    `SELECT id FROM tournaments
     WHERE status = 'open' AND entry_fee_wei != '0'
       AND start_at IS NOT NULL AND start_at <= ?`,
  ).all(now() - STUCK_SETTLEMENT_SECONDS) as { id: number }[]
  return rows
    .map((r) => ({ id: r.id, players: tour.entryCount(r.id) }))
    .filter((r) => r.players < tour.MIN_PLAYERS)
}

setInterval(() => { void runTournamentScheduler() }, 15_000)
void runTournamentScheduler()

/**
 * Pots this player has won but not yet collected, so the UI can nag them
 * before the contract's timeout hands the loser their stake back.
 */
app.get('/api/me/unclaimed', requireAuth, (req, res) => {
  const address = addrOf(req)
  const rows = db.prepare(`
    SELECT w.id, w.onchain_id, w.stake_wei, b.winner, b.p0, b.p1, b.ended_at
    FROM wagers w JOIN battles b ON b.id = w.battle_id
    WHERE w.status = 'awaiting_settlement' AND w.onchain_id IS NOT NULL
  `).all() as {
    id: number; onchain_id: string; stake_wei: string
    winner: number | null; p0: string; p1: string; ended_at: number | null
  }[]

  const mine = rows.filter((r) => {
    if (r.winner === null) return r.p0 === address || r.p1 === address
    return (r.winner === 0 ? r.p0 : r.p1) === address
  })

  res.json(mine.map((r) => ({
    wagerId: r.id,
    onchainId: r.onchain_id,
    stakeWei: r.stake_wei,
    kind: r.winner === null ? 'draw' : 'win',
    endedAt: r.ended_at,
  })))
})

// Every 3s: a 30-second reconnect window swept at 15s intervals could run to
// 45s, which is a long time to stare at a stalled match.
/**
 * Battles that were live when this process last stopped.
 *
 * Rooms live in memory, so a restart — a deploy, a crash, an OOM — leaves
 * their database rows open forever: the match never ends, and a paid wager
 * sits escrowed until the on-chain timeout refunds both sides an hour later.
 *
 * Closing them as a draw is the honest outcome. Nobody won, and the existing
 * claim flow already knows how to settle a draw, so both players get their
 * stake straight back instead of waiting out the timeout.
 */
function closeAbandonedBattles() {
  const orphans = db.prepare(
    'SELECT id, wager_id FROM battles WHERE ended_at IS NULL',
  ).all() as { id: string; wager_id: number | null }[]
  if (orphans.length === 0) return

  for (const o of orphans) {
    db.prepare('UPDATE battles SET winner = NULL, forced = 1, ended_at = ? WHERE id = ?')
      .run(now(), o.id)
    if (o.wager_id !== null) {
      const w = db.prepare('SELECT onchain_id FROM wagers WHERE id = ?')
        .get(o.wager_id) as { onchain_id: string | null } | undefined
      db.prepare('UPDATE wagers SET status = ? WHERE id = ?')
        .run(w?.onchain_id ? 'awaiting_settlement' : 'settled', o.wager_id)
    }
  }
  console.warn(
    `[recovery] closed ${orphans.length} battle(s) interrupted by a restart, as draws`,
  )
}

setInterval(() => {
  sweepDisconnects()
}, 3_000)

setInterval(() => {
  pruneAuth()
  db.prepare("UPDATE wagers SET status = 'expired' WHERE status = 'open' AND expires_at < ?")
    .run(now())
}, 15_000)

// The dex loads learnsets asynchronously. Binding before it is ready would
// serve an empty /api/pokedex and, worse, reject every legal team, so the
// socket is not opened until it has finished.
await dexReady
console.log(`  dex: ${MOVES.size} moves, ${allSpecies().length} species ready`)

// Presets are checked against the dex, so they can only be built once it is
// loaded. This throws on an illegal roster — better at boot than mid-match.
buildOpponents()
console.log(`  practice: ${OPPONENTS.length} opponents ready`)

// The ETH/USD ticker only feeds prize DISPLAY; boot it in the background so a
// slow price API never delays the server coming up.
startPriceFeed()

server.listen(PORT, BIND, () => {
  // Only after binding: a second instance that loses the race for the port
  // must not close the battles of the one that is actually serving them.
  closeAbandonedBattles()

  console.log(`PokePlay server on ${BIND}:${PORT}`)
  console.log(`  settlement: ${settlementEnabled ? `enabled (arbiter ${arbiterAddress})` : 'DISABLED — set ARBITER_PRIVATE_KEY + ESCROW_ADDRESS'}`)
  console.log(`  tournaments: ${tournamentSettlementEnabled ? `paid enabled (pool ${tournamentPoolAddress})` : 'free only — set ARBITER_PRIVATE_KEY + TOURNAMENT_POOL_ADDRESS for paid'}`)
  if (devLoginEnabled) {
    console.warn('  ⚠  DEV LOGIN IS ON — anyone can sign in as a test account without a wallet.')
    console.warn('     Never run with DEV_LOGIN=1 on a public host.')
  }

  // Confirm we are signing for the contract we think we are. A mismatch would
  // let the server keep reporting successful settlements while the escrow
  // rejected every one of them.
  if (settlementEnabled) {
    verifySettlementConfig().then(
      () => console.log('  settlement: escrow domain + arbiter verified on chain'),
      (e: Error) => {
        console.error(`  ✖ ${e.message}`)
        process.exit(1)
      },
    )
  }

  // The same guard for the tournament pool: a wrong domain or arbiter would make
  // every tournament payout revert while the server reported success.
  if (tournamentSettlementEnabled) {
    verifyTournamentConfig().then(
      () => console.log('  tournaments: pool domain + arbiter verified on chain'),
      (e: Error) => {
        console.error(`  ✖ ${e.message}`)
        process.exit(1)
      },
    )
  }
})
