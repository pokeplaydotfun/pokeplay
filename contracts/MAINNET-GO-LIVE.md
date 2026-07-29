# Mainnet go-live — PokePlayEscrow

> ⚠ **These are the DEPLOY-TIME values, kept as a record of what the constructors were
> actually given. The live roles were ROTATED on 2026-07-29** — owner is now
> `0x699ff0E24a5de0386d332aE00947746A66032CCf` (cold) and treasury is
> `0xd631ED63B23204aC30D435048838583E13feAEA0` (hot worker) on BOTH the escrow and the
> tournament pool. Do not copy the addresses below as current state; see
> `contracts/ROTATE-DEV-WALLET.md`.

Real money. Every step is run BY YOU from your own machine; the deployer key
never touches the assistant or the server. Do them in order.

## Roles (from DEPLOY-CONFIG.md)
- OWNER    = 0x2fD76b95e1CdaF43264a1459C41410f22F942aB6  (also deployer + treasury)
- TREASURY = 0x2fD76b95e1CdaF43264a1459C41410f22F942aB6
- ARBITER  = 0xE18798dd9dabD03b0df4BdA61D3b5E7B805bEc85  (private key already in server .env)
- FEE_BPS  = 250  (2.5% of each pot; owner can change later, max 500)

## 0. Prerequisites
- [ ] 0x2fD7… funded with ~0.01 ETH on Robinhood Chain (deploy costs ~0.0002).
- [ ] Arbiter private key is in /root/slab-showdown/server/.env and verified.
- [ ] Server hardened off root (assistant does this).

## 1. Put the deployer key in an encrypted keystore (your machine)
0x2fD7 is a regular (software) wallet, so import it into an encrypted Foundry
keystore. The key is encrypted with your password and never stored in plaintext,
and never leaves your machine.

    cast wallet import pokeplay-deployer --interactive
    # paste 0x2fD7's private key, set a STRONG password.

Export the key from your wallet (e.g. MetaMask: Account details -> Show private
key) only for this paste, and clear your clipboard afterward.

## 2. Deploy (your machine, in the contracts/ dir)
    OWNER=0x2fD76b95e1CdaF43264a1459C41410f22F942aB6 \
    ARBITER=0xE18798dd9dabD03b0df4BdA61D3b5E7B805bEc85 \
    TREASURY=0x2fD76b95e1CdaF43264a1459C41410f22F942aB6 \
    FEE_BPS=250 \
    forge script script/Deploy.s.sol:Deploy \
      --rpc-url robinhood \
      --account pokeplay-deployer \
      --broadcast

Write down the "deployed :" address it prints, and the domainSeparator.

## 3. Verify on the explorer
    forge verify-contract <address> src/PokePlayEscrow.sol:PokePlayEscrow \
      --rpc-url robinhood --verifier blockscout \
      --verifier-url https://robinhoodchain.blockscout.com/api \
      --constructor-args $(cast abi-encode "c(address,address,address,uint16)" \
        0x2fD76b95e1CdaF43264a1459C41410f22F942aB6 \
        0xE18798dd9dabD03b0df4BdA61D3b5E7B805bEc85 \
        0x2fD76b95e1CdaF43264a1459C41410f22F942aB6 250)

## 4. Arm the server (assistant does this once you paste the address)
Set ESCROW_ADDRESS=<deployed> in the server .env and restart. On boot the
startup guard reads eip712Domain() and arbiter() off the deployed contract and
REFUSES to start unless they match — so a wrong address or a wrong arbiter key
is caught here, before any wager, not after.
Expect the log line: "settlement: escrow domain + arbiter verified on chain".

## 5. Smoke test with a tiny real wager
Post a 0.001 ETH wager, accept it from a second wallet, play it, settle, and
withdraw. Confirm the pot moved correctly and the fee landed in treasury. Only
after this passes should you announce paid play.

## Rollback
Paid play is OFF until ESCROW_ADDRESS is set. If anything looks wrong at step 4
or 5, blank ESCROW_ADDRESS and restart — free play is unaffected, and no funds
are ever held by the server.
