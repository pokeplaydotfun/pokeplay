# Escrow deploy configuration

> ⚠ **These are the DEPLOY-TIME values, kept as a record of what the constructors were
> actually given. The live roles were ROTATED on 2026-07-29** — owner is now
> `0x699ff0E24a5de0386d332aE00947746A66032CCf` (cold) and treasury is
> `0xd631ED63B23204aC30D435048838583E13feAEA0` (hot worker) on BOTH the escrow and the
> tournament pool. Do not copy the addresses below as current state; see
> `contracts/ROTATE-DEV-WALLET.md`.

These are the roles baked into PokePlayEscrow at deploy time. All three are
PUBLIC ADDRESSES — no private key belongs in this file or on the server except
the arbiter's, which lives only in the server .env.

| Role     | Address                                      | Private key lives |
|----------|----------------------------------------------|-------------------|
| OWNER    | 0x2fD76b95e1CdaF43264a1459C41410f22F942aB6   | your wallet only — COLD |
| TREASURY | 0x2fD76b95e1CdaF43264a1459C41410f22F942aB6   | your wallet only |
| ARBITER  | 0xE18798dd9dabD03b0df4BdA61D3b5E7B805bEc85   | server .env (ARBITER_PRIVATE_KEY) |

Deploy (see contracts/DRY-RUN.md for the full command):

    OWNER=0x2fD76b95e1CdaF43264a1459C41410f22F942aB6 \
    ARBITER=0xE18798dd9dabD03b0df4BdA61D3b5E7B805bEc85 \
    TREASURY=0x2fD76b95e1CdaF43264a1459C41410f22F942aB6 \
    FEE_BPS=250 \
    forge script script/Deploy.s.sol:Deploy --rpc-url <chain> --account <keystore> --broadcast

Note: OWNER, TREASURY and the site admin are currently the SAME wallet
(0x2fD7…942aB6). That wallet's key must stay in your own hardware/wallet and
never on the server. If it is ever compromised, an attacker gets site-admin,
escrow-owner and the fee stream at once — consider a separate cold/multisig
owner before mainnet.

## DEPLOYED (mainnet, Robinhood Chain 4663)
- Escrow contract: 0xdE1405268a4194853573b5cF4270CaAEDaeCdAA0
- Deploy tx by:    0x2fD76b95e1CdaF43264a1459C41410f22F942aB6 (nonce 0)
- Verified on-chain: owner/treasury/arbiter/feeBps=250/domain all correct.
- Server armed: ESCROW_ADDRESS set in /srv/pokeplay/server/.env, guard passed.
