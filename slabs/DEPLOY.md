# Slabs — deploy runbook (operator)

The Slabs section (ported GRAILS gacha, rebranded) is three pieces:

- **contracts** (`slabs/contracts`) — `PackSale`, `MirrorNFT` (collection "Slabs"),
  `Fulfiller`, `Marketplace`. Foundry, 186 tests green.
- **backend** (`slabs/backend`) — fulfilment worker + API. Runs fully on
  `USE_MOCKS=true`; needs real keys for live pack opening. 322 tests green on mocks.
- **frontend** — merged into the pokeplay app at `/slabs`, reskinned to the
  cream/light design. Builds with the rest of pokeplay (`vite build`).

Nothing here is live yet. Everything below needs **your** keys, funded float, and a
real-money smoke test. I never handle those keys.

## 0. Wallets — 1 Solana + 2 EVM (same concept as the other project)

Three wallets total. Every env var maps to exactly one of them:

**EVM #1 — COLD owner.** Offline; never signs at runtime, never deploys.
- `OWNER_ADDRESS` — admin of all 4 contracts; holds the forceRefund escape hatch.
- I need: **its address only.**

**EVM #2 — HOT worker.** Everything else — same as the other project's worker/fee wallet.
- `WORKER_ADDRESS` (= the Fulfiller caller + quote signer) — on-chain runtime role.
- `GUARDIAN_ADDRESS` — automated pause-only role (same hot key so the monitor can halt).
- `TREASURY_ADDRESS` — the 2.5% marketplace fee recipient (on the worker, per the other
  project; sweep it to cold periodically).
- `DEPLOYER_PRIVATE_KEY` — runs the deploy, then hands ownership to the cold owner and
  keeps only the worker role. Keeps the cold key offline through the whole deploy.
- `WORKER_PRIVATE_KEY` (backend .env) — the SAME key; the worker signs quotes/fulfils.
- I need: **its address + private key** (goes in the deploy env and the box `.env`).

**Solana wallet — custody + signer.** Holds the Collector Crypt cards + SOL for fees.
- `SOLANA_OPERATOR_ADDRESS` + `SOLANA_OPERATOR_SECRET_KEY` (backend .env) — signs the
  Solana side (pack opens, unwraps, transfers).
- I need: **its address + secret key** (box `.env`), funded with the CC cards + some SOL.

## 1. Contracts (you deploy, once)
Same pattern as the escrow/pool deploys. From `slabs/contracts`, deploy the four
contracts to Robinhood mainnet (via your keystore, in a real terminal for the
password prompt). Rebranded collection = `Slabs / SLABS` (MirrorNFT constructor).
Record the four addresses; they go into both the backend `.env` and the frontend env.

## 2. Backend service (new systemd unit on the VPS)
- Runs non-root as user `slabs` from `/srv/slabs/backend`, DB at
  `/var/lib/slabs/slabs.sqlite` (OUTSIDE the deploy tree — a redeploy must not delete
  order history). Unit: `slabs/backend/slabs-api.service`.
- Node 22+ (`--experimental-strip-types`, `node:sqlite`). `npm ci --omit=dev`.
- Fill `slabs/backend/.env` from `.env.example`. **REQUIRED** keys include:
  `RH_RPC_URL`, the 4 contract addresses (`USDG_ADDRESS`, `PACK_SALE_ADDRESS`,
  `MIRROR_NFT_ADDRESS`, `FULFILLER_ADDRESS`), `WORKER_PRIVATE_KEY`,
  `SOLANA_RPC_URL` + `SOLANA_OPERATOR_ADDRESS` + `SOLANA_OPERATOR_SECRET_KEY`,
  Collector Crypt (`CC_API_KEY`, `CC_REFERRAL_CODE`), bridge config, and the policy
  limits. `SIGNING_NS=Slabs` and `SITE_URL=https://pokeplay.fun` are set. Keep
  `USE_MOCKS=false` only once CC + Solana are wired.
- Pick an `API_PORT` that does NOT collide with the other services on the box
  (pokeplay wager API 8090, gatching 8787, gacha-dashboard 8787 — check first).

## 3. API routing (your infra decision)
The frontend reads `VITE_API_URL`. Two clean options — **your call**:
- **Subpath**: Caddy route `pokeplay.fun/slabs-api/*` → `127.0.0.1:<API_PORT>`, and
  set `VITE_API_URL=https://pokeplay.fun/slabs-api`. One origin, no new cert.
- **Subdomain**: `slabs-api.pokeplay.fun` → the port; set `VITE_API_URL` to it.
Set `CORS_ORIGIN=https://pokeplay.fun` on the backend either way.
⚠ This touches the live pokeplay Caddyfile — do it the same careful way as the wager
deploy (backup + `caddy validate` + graceful reload; never restart).

## 4. Frontend env (baked at build)
Add to the pokeplay build env (or `config.ts` defaults): `VITE_API_URL` (above),
`VITE_MIRROR_ADDRESS`, `VITE_PACK_SALE_ADDRESS`, `VITE_MARKETPLACE_ADDRESS`,
`VITE_USDG_ADDRESS`, and `VITE_SIGNING_NS=Slabs` (must match the backend).

⚠ **The section is OFF by default.** The "Slabs" nav item and the `/slabs` route are
gated on **`VITE_SLABS_ENABLED=true`** (see `SLABS_ENABLED` in `config.ts`) so a
routine pokeplay deploy can never expose an unconfigured gacha on the live site. Set
`VITE_SLABS_ENABLED=true` in the build env only once steps 1–3 are done and the API
answers. Until then, a normal pokeplay deploy simply ships without a Slabs link.

## 5. Real-money smoke test (together)
Before promoting: buy one cheap pack end to end (USDG → PackSale escrow → worker
opens a real CC pack on Solana → mirror minted), then sell it back and confirm the
USDG returns minus spread. Same posture as the wager/pool smoke test — you drive the
wallets, I watch escrow/mint/settlement.

## Local dev (no keys, no money)
- Backend on mocks: `cd slabs/backend && cp .env.example .env && npm i && npm test`
  (322 pass), or run it (`USE_MOCKS=true`) and point the frontend at it.
- Frontend: `.env.local` sets `VITE_API_URL` (currently the live huntgrails API for
  real floor data) + `VITE_SIGNING_NS=Slabs`; `npx vite --port 5180`, open `/slabs`.
