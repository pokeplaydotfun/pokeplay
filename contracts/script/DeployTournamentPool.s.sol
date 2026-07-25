// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PokePlayTournamentPool} from "../src/PokePlayTournamentPool.sol";

/**
 * @notice Deploys PokePlayTournamentPool.
 *
 * Same rules as Deploy.s.sol: NO PRIVATE KEY IS READ HERE — supply the signer to
 * `forge script` yourself via `--ledger`, `--trezor`, `--account <keystore>` or
 * `--interactive`.
 *
 * Deploy it with the SAME owner/arbiter/treasury/fee as the escrow, so the two
 * contracts share a trust model and the server can sign for both with one key.
 *
 * Required:
 *   ARBITER   address — the key your game server signs tournament results with
 *   TREASURY  address — where house fees accrue
 *
 * Optional:
 *   FEE_BPS   uint (default 250 = 2.5%, hard max 500 = 5%)
 *   OWNER     address (default: the broadcasting sender)
 *
 * Example:
 *   ARBITER=0x... TREASURY=0x... FEE_BPS=250 \
 *   forge script script/DeployTournamentPool.s.sol:DeployTournamentPool \
 *     --rpc-url https://rpc.mainnet.chain.robinhood.com \
 *     --account deployer --sender 0x<deployer-address> --broadcast
 *
 * NOTE: pass BOTH `--account` AND `--sender <that account's address>`. With
 * `--account` alone, forge simulates as its default sender and then refuses to
 * broadcast ("You seem to be using Foundry's default sender"). Nothing is spent
 * or deployed in that case — just re-run with `--sender` added.
 */
contract DeployTournamentPool is Script {
    function run() external returns (PokePlayTournamentPool pool) {
        address arbiter = vm.envAddress("ARBITER");
        address treasury = vm.envAddress("TREASURY");
        uint256 feeBps = vm.envOr("FEE_BPS", uint256(250));
        address owner = vm.envOr("OWNER", msg.sender);

        require(arbiter != address(0), "ARBITER must not be the zero address");
        require(treasury != address(0), "TREASURY must not be the zero address");
        require(owner != address(0), "OWNER must not be the zero address");
        require(feeBps <= 500, "FEE_BPS exceeds the 500 (5%) hard cap");

        console.log("=== PokePlayTournamentPool deployment ===");
        console.log("chain id :", block.chainid);
        console.log("owner    :", owner);
        console.log("arbiter  :", arbiter);
        console.log("treasury :", treasury);
        console.log("feeBps   :", feeBps);

        if (owner == arbiter) {
            console.log("WARNING: owner == arbiter. A single key compromise loses both roles.");
        }

        vm.startBroadcast();
        pool = new PokePlayTournamentPool(owner, arbiter, treasury, uint16(feeBps));
        vm.stopBroadcast();

        console.log("deployed :", address(pool));
        console.log("settleTimeout (s):", pool.settleTimeout());
        console.log("domainSeparator  :");
        console.logBytes32(pool.domainSeparator());

        console.log("");
        console.log("Post-deploy checklist:");
        console.log(" 1. Transfer ownership to a multisig/timelock (two-step).");
        console.log(" 2. Point the server's tournament EIP-712 signer at the address above.");
        console.log(" 3. Verify on https://robinhoodchain.blockscout.com (see README).");

        return pool;
    }
}
