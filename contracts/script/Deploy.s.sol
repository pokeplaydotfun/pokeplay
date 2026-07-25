// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PokePlayEscrow} from "../src/PokePlayEscrow.sol";

/**
 * @notice Deploys PokePlayEscrow.
 *
 * Configuration comes from environment variables. NO PRIVATE KEY IS READ HERE —
 * supply the signer to `forge script` yourself via `--ledger`, `--trezor`,
 * `--account <keystore>` or `--interactive`. Do not put a key in an env var or in
 * this repo.
 *
 * Required:
 *   ARBITER   address — the key your game server signs match results with
 *   TREASURY  address — where house fees accrue
 *
 * Optional:
 *   FEE_BPS   uint (default 250 = 2.5%, hard max 500 = 5%)
 *   OWNER     address (default: the broadcasting sender)
 *
 * Example (see README for the full Robinhood Chain command):
 *   ARBITER=0x... TREASURY=0x... FEE_BPS=250 \
 *   forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url https://rpc.mainnet.chain.robinhood.com \
 *     --account deployer --broadcast
 */
contract Deploy is Script {
    function run() external returns (PokePlayEscrow escrow) {
        address arbiter = vm.envAddress("ARBITER");
        address treasury = vm.envAddress("TREASURY");
        uint256 feeBps = vm.envOr("FEE_BPS", uint256(250));
        address owner = vm.envOr("OWNER", msg.sender);

        require(arbiter != address(0), "ARBITER must not be the zero address");
        require(treasury != address(0), "TREASURY must not be the zero address");
        require(owner != address(0), "OWNER must not be the zero address");
        require(feeBps <= 500, "FEE_BPS exceeds the 500 (5%) hard cap");

        console.log("=== PokePlayEscrow deployment ===");
        console.log("chain id :", block.chainid);
        console.log("owner    :", owner);
        console.log("arbiter  :", arbiter);
        console.log("treasury :", treasury);
        console.log("feeBps   :", feeBps);

        if (owner == arbiter) {
            console.log("WARNING: owner == arbiter. A single key compromise loses both roles.");
        }

        vm.startBroadcast();
        escrow = new PokePlayEscrow(owner, arbiter, treasury, uint16(feeBps));
        vm.stopBroadcast();

        console.log("deployed :", address(escrow));
        console.log("settleTimeout (s):", escrow.settleTimeout());
        console.log("domainSeparator  :");
        console.logBytes32(escrow.domainSeparator());

        console.log("");
        console.log("Post-deploy checklist:");
        console.log(" 1. Transfer ownership to a multisig/timelock (transferOwnership +");
        console.log("    acceptOwnership -- it is two-step).");
        console.log(" 2. Point the server's EIP-712 signer at the address above.");
        console.log(" 3. Verify on https://robinhoodchain.blockscout.com (see README).");

        return escrow;
    }
}
