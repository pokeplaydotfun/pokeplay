// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {PokePlayTournamentPool} from "../src/PokePlayTournamentPool.sol";

/**
 * @dev Drives the tournament pool through random sequences of every user-facing
 *      action AND every owner-only action, then asserts the contract is always
 *      solvent and the owner can never extract a wei. Mirrors Invariant.t.sol.
 *
 *      The whole point is the interleaving: no ordering of joins, settlements,
 *      cancellations, timeout refunds, withdrawals and admin meddling may ever
 *      leave the contract owing more than it holds, or hand the owner a balance.
 */
contract TournamentHandler is Test {
    PokePlayTournamentPool public pool;

    address public owner;
    address public arbiter;
    uint256 public arbiterPk;
    address public treasury;

    address[] public players;
    uint256[] public liveIds;

    // Ghost accounting, maintained independently of the contract.
    uint256 public ghostDeposited; // total ETH ever sent in as entry fees
    uint256 public ghostWithdrawn; // total ETH ever taken out
    uint256 public ghostOwnerWithdrawn; // ETH the owner itself ever withdrew

    // Non-vacuity counters — the handler swallows reverts, so we must prove the
    // fuzzer actually reached the interesting states.
    uint256 public ghostJoined;
    uint256 public ghostLeft;
    uint256 public ghostSettled;
    uint256 public ghostRefunded;
    uint256 public ghostCancelled;
    uint256 public ghostWithdrawals;

    constructor(PokePlayTournamentPool pool_, address owner_, uint256 arbiterPk_, address treasury_) {
        pool = pool_;
        owner = owner_;
        arbiterPk = arbiterPk_;
        arbiter = vm.addr(arbiterPk_);
        treasury = treasury_;

        players.push(makeAddr("p1"));
        players.push(makeAddr("p2"));
        players.push(makeAddr("p3"));
        players.push(makeAddr("p4"));
        players.push(makeAddr("p5"));

        for (uint256 i = 0; i < players.length; i++) {
            vm.deal(players[i], 1_000_000 ether);
        }
        vm.deal(address(this), 1_000_000 ether);
        vm.deal(owner, 100 ether);
    }

    function _player(uint256 seed) internal view returns (address) {
        return players[seed % players.length];
    }

    function _sign(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(arbiterPk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------- actions

    function createTournament(uint96 feeRaw, uint32 ttl, uint32 capSeed) public {
        // Entry fee must be > 0; keep it modest so the fuzzer builds real pots.
        uint256 fee = bound(uint256(feeRaw), 1, 100 ether);
        uint64 deadline = uint64(block.timestamp + bound(uint256(ttl), 1, 30 days));
        uint32 cap = uint32(bound(uint256(capSeed), 2, 64));

        vm.prank(_player(0));
        try pool.createTournament(fee, cap, deadline) returns (uint256 id) {
            liveIds.push(id);
        } catch {}
    }

    function join(uint256 who, uint256 idxSeed) public {
        if (liveIds.length == 0) return;
        uint256 id = liveIds[idxSeed % liveIds.length];
        address p = _player(who);
        uint256 fee = pool.getTournament(id).entryFee;

        vm.prank(p);
        try pool.joinTournament{value: fee}(id) {
            ghostDeposited += fee;
            ghostJoined++;
        } catch {}
    }

    function settle(uint256 idxSeed, uint256 winnerSeed) public {
        if (liveIds.length == 0) return;
        uint256 id = liveIds[idxSeed % liveIds.length];
        address winner = _player(winnerSeed);
        // Only a real entrant can be named; the fuzzer often picks a non-entrant,
        // which simply bounces off the guard.
        try pool.settle(id, winner, _sign(pool.tournamentResultDigest(id, winner))) {
            ghostSettled++;
        } catch {}
    }

    function cancel(uint256 idxSeed) public {
        if (liveIds.length == 0) return;
        uint256 id = liveIds[idxSeed % liveIds.length];
        // The organizer is always _player(0) (see createTournament).
        vm.prank(_player(0));
        try pool.cancelTournament(id) {
            ghostCancelled++;
        } catch {}
    }

    function leave(uint256 who, uint256 idxSeed) public {
        if (liveIds.length == 0) return;
        uint256 id = liveIds[idxSeed % liveIds.length];
        vm.prank(_player(who));
        try pool.leaveTournament(id) {
            ghostLeft++;
        } catch {}
    }

    function extend(uint256 idxSeed, uint32 addSeed) public {
        if (liveIds.length == 0) return;
        uint256 id = liveIds[idxSeed % liveIds.length];
        uint64 current = pool.getTournament(id).registrationDeadline;
        // Only ever forward, and within the contract's cap.
        uint64 newDeadline = current + uint64(bound(uint256(addSeed), 1, 20 days));
        vm.prank(_player(0)); // the organizer
        try pool.extendDeadline(id, newDeadline) {} catch {}
    }

    function claimRefund(uint256 who, uint256 idxSeed) public {
        if (liveIds.length == 0) return;
        uint256 id = liveIds[idxSeed % liveIds.length];
        vm.prank(_player(who));
        try pool.claimRefund(id) {
            ghostRefunded++;
        } catch {}
    }

    function withdraw(uint256 who) public {
        address p = _player(who);
        uint256 expected = pool.balances(p);
        vm.prank(p);
        try pool.withdraw() returns (uint256 amount) {
            ghostWithdrawn += amount;
            ghostWithdrawals++;
            require(amount == expected, "withdrew an unexpected amount");
        } catch {}
    }

    function withdrawTreasury() public {
        uint256 expected = pool.balances(treasury);
        vm.prank(treasury);
        try pool.withdraw() returns (uint256 amount) {
            ghostWithdrawn += amount;
            require(amount == expected, "treasury withdrew an unexpected amount");
        } catch {}
    }

    /// @dev The owner tries, on every step, to extract value for itself.
    function ownerTriesToWithdraw() public {
        vm.prank(owner);
        try pool.withdraw() returns (uint256 amount) {
            ghostWithdrawn += amount;
            ghostOwnerWithdrawn += amount;
        } catch {}
    }

    function ownerMeddles(uint16 feeBps, uint64 timeout, uint256 arbiterSeed, bool doPause) public {
        vm.startPrank(owner);
        try pool.setFeeBps(uint16(bound(uint256(feeBps), 0, 500))) {} catch {}
        try pool.setSettleTimeout(uint64(bound(uint256(timeout), 5 minutes, 7 days))) {} catch {}
        if (arbiterSeed % 2 == 0) {
            try pool.setArbiter(owner) {} catch {}
        } else {
            try pool.setArbiter(arbiter) {} catch {}
        }
        try pool.setTreasury(owner) {} catch {}
        try pool.setTreasury(treasury) {} catch {}
        if (doPause) {
            try pool.pause() {} catch {}
        } else {
            try pool.unpause() {} catch {}
        }
        vm.stopPrank();
    }

    function warp(uint32 secs) public {
        vm.warp(block.timestamp + bound(uint256(secs), 1, 3 days));
    }

    function liveIdCount() external view returns (uint256) {
        return liveIds.length;
    }

    function idAt(uint256 i) external view returns (uint256) {
        return liveIds[i];
    }
}

contract TournamentInvariantTest is StdInvariant, Test {
    PokePlayTournamentPool internal pool;
    TournamentHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        (address arbiter, uint256 arbiterPk) = makeAddrAndKey("arbiter");
        pool = new PokePlayTournamentPool(owner, arbiter, treasury, 250);
        handler = new TournamentHandler(pool, owner, arbiterPk, treasury);
        targetContract(address(handler));
    }

    /**
     * @notice Non-vacuity guard: prove every terminal path is genuinely reachable,
     *         so the swallowed-revert fuzz campaign above is meaningful.
     */
    function test_handlerCanReachEveryTerminalState() public {
        // create + join x3 + settle
        handler.createTournament(uint96(1 ether), 1000, 8);
        handler.join(1, 0);
        handler.join(2, 0);
        handler.join(3, 0);
        handler.settle(0, 1); // winner = p2, an entrant

        // create + join + timeout refund
        handler.createTournament(uint96(2 ether), 100000, 8);
        handler.join(1, 1);
        handler.join(2, 1);
        handler.warp(type(uint32).max); // bounded to 3 days, still short of a fresh
        handler.warp(type(uint32).max); // deadline+timeout, so warp twice
        handler.warp(type(uint32).max);
        handler.warp(type(uint32).max);
        handler.warp(type(uint32).max);
        handler.warp(type(uint32).max);
        handler.warp(type(uint32).max);
        handler.warp(type(uint32).max);
        handler.warp(type(uint32).max);
        handler.claimRefund(1, 1);

        // create + join + organizer cancel
        handler.createTournament(uint96(3 ether), 1000, 8);
        handler.join(1, 2);
        handler.cancel(2);
        handler.claimRefund(1, 2);

        // withdraw
        handler.withdraw(1);
        handler.withdraw(2);
        handler.withdrawTreasury();

        assertGt(handler.ghostDeposited(), 0, "no ETH ever entered the contract");
        assertGt(handler.ghostJoined(), 0, "join path unreachable");
        assertGt(handler.ghostSettled(), 0, "settle path unreachable");
        assertGt(handler.ghostRefunded(), 0, "refund path unreachable");
        assertGt(handler.ghostCancelled(), 0, "cancel path unreachable");
        assertGt(handler.ghostWithdrawals(), 0, "withdraw path unreachable");
        assertGt(handler.ghostWithdrawn(), 0, "no ETH ever left the contract");

        handler.ownerTriesToWithdraw();
        assertEq(handler.ghostOwnerWithdrawn(), 0, "owner extracted value");
    }

    /// @notice The contract always holds at least what it owes.
    function invariant_solvent() public view {
        assertGe(address(pool).balance, pool.totalEscrowed() + pool.totalCredited(), "INSOLVENT");
    }

    /// @notice Balance is fully explained by deposits minus withdrawals.
    function invariant_balanceMatchesGhostAccounting() public view {
        assertEq(
            address(pool).balance,
            handler.ghostDeposited() - handler.ghostWithdrawn(),
            "balance drifted from deposit/withdrawal history"
        );
    }

    /// @notice The owner never extracts a single wei, no matter how it meddles.
    function invariant_ownerNeverExtractsValue() public view {
        assertEq(handler.ghostOwnerWithdrawn(), 0, "owner extracted user funds");
        assertEq(pool.balances(owner), 0, "owner accrued a withdrawable balance");
    }

    /// @notice Accounting mirrors never exceed the ETH actually held.
    function invariant_accountingNeverExceedsBalance() public view {
        assertLe(pool.totalEscrowed(), address(pool).balance, "escrow overstated");
        assertLe(pool.totalCredited(), address(pool).balance, "credits overstated");
    }
}
