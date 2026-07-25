// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PokePlayTournamentPool} from "../src/PokePlayTournamentPool.sol";

/// @dev Shared fixture + EIP-712 signing helpers for the tournament-pool suite.
///      Mirrors Base.t.sol so the two contracts read the same way.
abstract contract TournamentBaseTest is Test {
    PokePlayTournamentPool internal pool;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal organizer = makeAddr("organizer");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal erin = makeAddr("erin");

    uint256 internal arbiterPk;
    address internal arbiter;
    uint256 internal attackerPk;
    address internal attacker;

    uint16 internal constant DEFAULT_FEE_BPS = 250; // 2.5%
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function setUp() public virtual {
        (arbiter, arbiterPk) = makeAddrAndKey("arbiter");
        (attacker, attackerPk) = makeAddrAndKey("attacker");

        pool = new PokePlayTournamentPool(owner, arbiter, treasury, DEFAULT_FEE_BPS);

        vm.deal(organizer, 1_000 ether);
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(carol, 1_000 ether);
        vm.deal(dave, 1_000 ether);
        vm.deal(erin, 1_000 ether);
    }

    // ------------------------------------------------------------- helpers

    function _defaultDeadline() internal view returns (uint64) {
        return uint64(block.timestamp + 1 days);
    }

    /// @dev Open a tournament as the shared organizer with a default deadline.
    function _create(uint256 entryFee, uint32 maxPlayers) internal returns (uint256 id) {
        vm.prank(organizer);
        id = pool.createTournament(entryFee, maxPlayers, _defaultDeadline());
    }

    /// @dev Join `id` as `who`, paying the tournament's entry fee.
    function _join(uint256 id, address who) internal {
        uint256 fee = pool.getTournament(id).entryFee;
        vm.prank(who);
        pool.joinTournament{value: fee}(id);
    }

    /// @dev Open a tournament and seat everyone in `players`.
    function _createAndFill(uint256 entryFee, address[] memory players) internal returns (uint256 id) {
        id = _create(entryFee, uint32(players.length));
        for (uint256 i = 0; i < players.length; i++) {
            _join(id, players[i]);
        }
    }

    function _sign(bytes32 digest, uint256 pk) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signResult(uint256 id, address winner, uint256 pk) internal view returns (bytes memory) {
        return _sign(pool.tournamentResultDigest(id, winner), pk);
    }

    function _signResult(uint256 id, address winner) internal view returns (bytes memory) {
        return _signResult(id, winner, arbiterPk);
    }

    /// @dev The malleable twin of a signature: s' = n - s, v flipped. Must be rejected.
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

    /// @dev The solvency invariant, checkable at any point.
    function _assertSolvent() internal view {
        assertGe(
            address(pool).balance,
            pool.totalEscrowed() + pool.totalCredited(),
            "INSOLVENT: contract holds less than it owes"
        );
    }

    function _four() internal view returns (address[] memory p) {
        p = new address[](4);
        p[0] = alice;
        p[1] = bob;
        p[2] = carol;
        p[3] = dave;
    }
}
