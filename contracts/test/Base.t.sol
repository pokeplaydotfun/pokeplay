// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PokePlayEscrow} from "../src/PokePlayEscrow.sol";

/// @dev Shared fixture + EIP-712 signing helpers for the whole suite.
abstract contract BaseTest is Test {
    PokePlayEscrow internal escrow;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal arbiterPk;
    address internal arbiter;
    uint256 internal attackerPk;
    address internal attacker;

    uint16 internal constant DEFAULT_FEE_BPS = 250; // 2.5%
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function setUp() public virtual {
        (arbiter, arbiterPk) = makeAddrAndKey("arbiter");
        (attacker, attackerPk) = makeAddrAndKey("attacker");

        escrow = new PokePlayEscrow(owner, arbiter, treasury, DEFAULT_FEE_BPS);

        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(carol, 1_000 ether);
    }

    // ------------------------------------------------------------- helpers

    function _defaultExpiry() internal view returns (uint64) {
        return uint64(block.timestamp + 1 days);
    }

    function _createAndAccept(uint256 stake) internal returns (uint256 id) {
        vm.prank(alice);
        id = escrow.createWager{value: stake}(stake, _defaultExpiry());
        vm.prank(bob);
        escrow.acceptWager{value: stake}(id);
    }

    function _sign(bytes32 digest, uint256 pk) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signBattle(uint256 id, address winner, uint256 pk) internal view returns (bytes memory) {
        return _sign(escrow.battleResultDigest(id, winner), pk);
    }

    function _signBattle(uint256 id, address winner) internal view returns (bytes memory) {
        return _signBattle(id, winner, arbiterPk);
    }

    function _signDraw(uint256 id, uint256 pk) internal view returns (bytes memory) {
        return _sign(escrow.drawResultDigest(id), pk);
    }

    function _signDraw(uint256 id) internal view returns (bytes memory) {
        return _signDraw(id, arbiterPk);
    }

    /// @dev Produce the malleable twin of a signature: s' = n - s, v flipped.
    ///      Mathematically valid for secp256k1, and MUST be rejected.
    function _malleate(bytes memory sig) internal pure returns (bytes memory) {
        require(sig.length == 65, "bad sig len");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        bytes32 sFlipped = bytes32(SECP256K1_N - uint256(s));
        uint8 vFlipped = v == 27 ? 28 : 27;
        return abi.encodePacked(r, sFlipped, vFlipped);
    }

    /// @dev The solvency invariant, checkable at any point in any test.
    function _assertSolvent() internal view {
        assertGe(
            address(escrow).balance,
            escrow.totalEscrowed() + escrow.totalCredited(),
            "INSOLVENT: contract holds less than it owes"
        );
    }
}
