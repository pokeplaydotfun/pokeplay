// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PackSale} from "../src/PackSale.sol";
import {MirrorNFT} from "../src/MirrorNFT.sol";
import {Fulfiller} from "../src/Fulfiller.sol";
import {Marketplace} from "../src/Marketplace.sol";

/// @notice Deploys the system and wires roles so that mint and markFulfilled are only ever
///         reachable together, through the Fulfiller.
///
/// Deploy order is load-bearing: MirrorNFT first (PackSale takes it as an immutable, for
/// the forceRefund mintedForOrder check), then PackSale, then Fulfiller.
///
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url $RH_RPC_URL --broadcast --verify
///
/// Required env:
///   DEPLOYER_PRIVATE_KEY  deploys, then hands ownership to OWNER_ADDRESS
///   USDG_ADDRESS          from doc 01 T5 — the real Paxos USDG on RH Chain. Never guess.
///   OWNER_ADDRESS         admin key; holds the forceRefund escape hatch. NOT the worker.
///   WORKER_ADDRESS        worker hot key; becomes the Fulfiller's caller + quote signer
///   GUARDIAN_ADDRESS      automated health monitor; can pause and nothing else
///   TREASURY_ADDRESS      revenue recipient (cold, separate from day one)
///   MAX_PACK_PRICE_USDG   6dp, e.g. 55000000 for $55
///   MARKET_FEE_BPS        secondary-sale fee, capped at 500 (5%) by the contract
contract Deploy is Script {
    function run() external {
        /**
         * Accept the key with or without an `0x` prefix.
         *
         * `vm.envUint` demands the prefix and fails with a parse error that reads like a
         * corrupt key rather than a missing two characters. The alternative was editing the
         * file that holds the key to add them, which is not a thing to do casually to key
         * material when a tolerant parse costs three lines.
         */
        string memory rawPk = vm.envString("DEPLOYER_PRIVATE_KEY");
        bytes memory pkBytes = bytes(rawPk);
        bool prefixed = pkBytes.length > 1 && pkBytes[0] == "0" && (pkBytes[1] == "x" || pkBytes[1] == "X");
        uint256 deployerPk = vm.parseUint(prefixed ? rawPk : string(abi.encodePacked("0x", rawPk)));
        address usdg = vm.envAddress("USDG_ADDRESS");
        address owner = vm.envAddress("OWNER_ADDRESS");
        address worker = vm.envAddress("WORKER_ADDRESS");
        address guardian = vm.envAddress("GUARDIAN_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        uint96 maxPackPrice = uint96(vm.envUint("MAX_PACK_PRICE_USDG"));
        uint16 marketFeeBps = uint16(vm.envUint("MARKET_FEE_BPS"));

        // Deliberately not required to be distinct: the operator opted into a single key
        // for every role. deploy.sh warns on it. Ownership is transferable afterwards, so
        // splitting the roles later needs no redeploy.
        require(owner != address(0) && worker != address(0), "roles must be set");

        address deployer = vm.addr(deployerPk);
        vm.startBroadcast(deployerPk);

        // Deployer holds the operator role transiently so it can wire the Fulfiller in,
        // then hands everything to the real owner before finishing.
        MirrorNFT mirror = new MirrorNFT(usdg, deployer, deployer, treasury);
        PackSale sale = new PackSale(usdg, address(mirror), deployer, deployer, guardian, treasury, maxPackPrice);
        Fulfiller fulfiller = new Fulfiller(address(sale), address(mirror), owner, worker);

        // Independent of the mint path: it only ever moves cards that already exist, so it
        // needs no operator role on either contract and is owned directly by the admin key.
        Marketplace market = new Marketplace(usdg, address(mirror), owner, treasury, marketFeeBps);

        mirror.setOperator(address(fulfiller));
        mirror.setQuoteSigner(worker);
        sale.setOperator(address(fulfiller));

        /**
         * Two roles that are easy to forget and break a whole flow each if missed.
         *
         * `drawer` — the hot EOA allowed to take an order's payment out of escrow to fund its
         * pack. Deliberately NOT `operator`, which is the Fulfiller CONTRACT: a contract
         * cannot bridge to Solana, so draws sent there would be stranded. Without this set,
         * the worker refuses to boot rather than failing every order at the bridge.
         *
         * `custodian` — the wallet holding mirrors surrendered for sell-back. Only a mirror
         * sitting there can be burned, so a token in a user's own wallet is never
         * destroyable. Without this set, every sell-back burn reverts CustodianNotSet.
         *
         * Both are the worker EOA today. Set here rather than left to a checklist, because a
         * post-deploy step that is only documented is a step that eventually gets skipped.
         */
        sale.setDrawer(worker);
        mirror.setCustodian(worker);

        /**
         * ZERO, matching what is live — and this is load-bearing, not a default.
         *
         * The old value here was 500, from Doc 01 T3: CC buyback eligibility belongs to the
         * card rather than the wallet, so a user could unwrap, sell to CC at 85%, and keep the
         * 5pp we would have earned. That reasoning still holds economically.
         *
         * But the live contract runs 0, and the WITHDRAW UI DEPENDS ON IT. `burnForUnwrap`
         * only ignores its quote arguments when the fee is 0 or the CC window has closed, and
         * `useWithdraw` passes zeroes and an empty signature exactly as the contract prescribes
         * for that case. The EIP-712 quote path is not implemented on the frontend at all.
         *
         * So deploying 500 would not fail loudly — it would revert BadQuoteSigner on every
         * withdraw for the first 72 hours of a card's life, which is precisely when someone is
         * most likely to try one.
         *
         * Raising it is a product decision that has to ship WITH the quote-signing path, not
         * ahead of it.
         */
        mirror.setUnwrapFeeBps(0);

        mirror.transferOwnership(owner);
        sale.transferOwnership(owner);

        vm.stopBroadcast();

        console2.log("MirrorNFT :", address(mirror));
        console2.log("PackSale  :", address(sale));
        console2.log("Fulfiller :", address(fulfiller));
        console2.log("Marketplace:", address(market));
        console2.log("");
        console2.log("Post-deploy, from the OWNER key:");
        console2.log("  sale.setMachine(<ccMachineId>, <priceUsdg>, true)");
        console2.log("  sale.setCaps(500, <maxPrice>, 5)   // 500/day, 5 concurrent");
        console2.log("Frontend env:");
        console2.log("  VITE_MIRROR_ADDRESS / VITE_PACK_SALE_ADDRESS / VITE_MARKETPLACE_ADDRESS");
        console2.log("Verify before enabling any machine:");
        console2.log("  sale.owner() == OWNER_ADDRESS and mirror.owner() == OWNER_ADDRESS");
        console2.log("  sale.operator() == fulfiller and mirror.operator() == fulfiller");
        console2.log("  sale.drawer() == worker and mirror.custodian() == worker");
        console2.log("  backend PACK_SALE_ADDRESS / MIRROR_NFT_ADDRESS / FULFILLER_ADDRESS");
        console2.log("");
        console2.log("The backend detects drawer() at boot and adapts, so either deploy order");
        console2.log("is safe -- but ship both halves before enabling machines.");
    }
}
