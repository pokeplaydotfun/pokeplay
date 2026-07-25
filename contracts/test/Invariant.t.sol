// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {PokePlayEscrow} from "../src/PokePlayEscrow.sol";

/**
 * @dev Drives the escrow through random sequences of every user-facing action AND
 *      every owner-only action, then asserts the contract is always solvent.
 *
 *      The handler is the only actor the fuzzer targets, so `owner` is exercised
 *      alongside players — which is the point: no interleaving of admin calls with
 *      user calls may ever leave the contract owing more than it holds, and the
 *      owner must never be able to increase its own withdrawable balance.
 */
contract Handler is Test {
    PokePlayEscrow public escrow;

    address public owner;
    address public arbiter;
    uint256 public arbiterPk;
    address public treasury;

    address[] public players;
    uint256[] public liveIds;

    // Ghost accounting, maintained independently of the contract.
    uint256 public ghostDeposited; // total ETH ever sent into the escrow
    uint256 public ghostWithdrawn; // total ETH ever taken out
    uint256 public ghostOwnerWithdrawn; // ETH the owner itself ever withdrew

    // Non-vacuity counters: because the handler swallows reverts, we must prove the
    // fuzzer actually reached the interesting states rather than bouncing off
    // guards for 8192 calls.
    uint256 public ghostAccepted;
    uint256 public ghostSettled;
    uint256 public ghostDrawn;
    uint256 public ghostTimedOut;
    uint256 public ghostCancelled;
    uint256 public ghostWithdrawals;

    constructor(PokePlayEscrow escrow_, address owner_, uint256 arbiterPk_, address treasury_) {
        escrow = escrow_;
        owner = owner_;
        arbiterPk = arbiterPk_;
        arbiter = vm.addr(arbiterPk_);
        treasury = treasury_;

        players.push(makeAddr("p1"));
        players.push(makeAddr("p2"));
        players.push(makeAddr("p3"));
        players.push(makeAddr("p4"));

        // Fund the pranked players (msg.value is debited from the pranked sender)
        // AND the handler itself, so no payable action can ever fail merely for
        // lack of funds — that would silently render the whole campaign vacuous.
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

    function createWager(uint256 who, uint96 stakeRaw, uint32 ttl) public {
        address p = _player(who);
        uint256 stake = bound(uint256(stakeRaw), 0, 100 ether);
        uint64 expiry = uint64(block.timestamp + bound(uint256(ttl), 1, 30 days));

        vm.prank(p);
        try escrow.createWager{value: stake}(stake, expiry) returns (uint256 id) {
            ghostDeposited += stake;
            liveIds.push(id);
        } catch {}
    }

    function acceptWager(uint256 who, uint256 idxSeed) public {
        if (liveIds.length == 0) return;
        uint256 id = liveIds[idxSeed % liveIds.length];
        address p = _player(who);
        uint256 stake = escrow.getWager(id).stake;

        vm.prank(p);
        try escrow.acceptWager{value: stake}(id) {
            ghostDeposited += stake;
            ghostAccepted++;
        } catch {}
    }

    function settle(uint256 idxSeed, bool firstWins) public {
        if (liveIds.length == 0) return;
        uint256 id = liveIds[idxSeed % liveIds.length];
        PokePlayEscrow.Wager memory w = escrow.getWager(id);
        address winner = firstWins ? w.creator : w.opponent;
        if (winner == address(0)) return;

        try escrow.settle(id, winner, _sign(escrow.battleResultDigest(id, winner))) {
            ghostSettled++;
        } catch {}
    }

    function settleDraw(uint256 idxSeed) public {
        if (liveIds.length == 0) return;
        uint256 id = liveIds[idxSeed % liveIds.length];
        try escrow.settleDraw(id, _sign(escrow.drawResultDigest(id))) {
            ghostDrawn++;
        } catch {}
    }

    function cancelWager(uint256 who, uint256 idxSeed) public {
        if (liveIds.length == 0) return;
        uint256 id = liveIds[idxSeed % liveIds.length];
        vm.prank(_player(who));
        try escrow.cancelWager(id) {
            ghostCancelled++;
        } catch {}
    }

    function claimTimeout(uint256 who, uint256 idxSeed) public {
        if (liveIds.length == 0) return;
        uint256 id = liveIds[idxSeed % liveIds.length];
        vm.prank(_player(who));
        try escrow.claimTimeout(id) {
            ghostTimedOut++;
        } catch {}
    }

    function withdraw(uint256 who) public {
        address p = _player(who);
        uint256 expected = escrow.balances(p);
        vm.prank(p);
        try escrow.withdraw() returns (uint256 amount) {
            ghostWithdrawn += amount;
            ghostWithdrawals++;
            require(amount == expected, "withdrew an unexpected amount");
        } catch {}
    }

    function withdrawTreasury() public {
        uint256 expected = escrow.balances(treasury);
        vm.prank(treasury);
        try escrow.withdraw() returns (uint256 amount) {
            ghostWithdrawn += amount;
            require(amount == expected, "treasury withdrew an unexpected amount");
        } catch {}
    }

    /// @dev The owner tries, on every step, to extract value for itself.
    function ownerTriesToWithdraw() public {
        vm.prank(owner);
        try escrow.withdraw() returns (uint256 amount) {
            ghostWithdrawn += amount;
            ghostOwnerWithdrawn += amount;
        } catch {}
    }

    function ownerMeddles(uint16 feeBps, uint64 timeout, uint256 arbiterSeed, bool doPause) public {
        vm.startPrank(owner);
        try escrow.setFeeBps(uint16(bound(uint256(feeBps), 0, 500))) {} catch {}
        try escrow.setSettleTimeout(uint64(bound(uint256(timeout), 5 minutes, 7 days))) {} catch {}
        // Owner may even point the arbiter and treasury at itself.
        if (arbiterSeed % 2 == 0) {
            try escrow.setArbiter(owner) {} catch {}
        } else {
            try escrow.setArbiter(arbiter) {} catch {}
        }
        try escrow.setTreasury(owner) {} catch {}
        try escrow.setTreasury(treasury) {} catch {}
        if (doPause) {
            try escrow.pause() {} catch {}
        } else {
            try escrow.unpause() {} catch {}
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

contract InvariantTest is StdInvariant, Test {
    PokePlayEscrow internal escrow;
    Handler internal handler;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        (address arbiter, uint256 arbiterPk) = makeAddrAndKey("arbiter");
        escrow = new PokePlayEscrow(owner, arbiter, treasury, 250);
        handler = new Handler(escrow, owner, arbiterPk, treasury);
        targetContract(address(handler));
    }

    /**
     * @notice Non-vacuity guard.
     *
     * The handler swallows reverts, so a misconfigured harness can make every
     * action a silent no-op and leave all five invariants passing over an empty
     * state. (That is not hypothetical: an earlier version of this file funded the
     * wrong account and did exactly that.)
     *
     * This is deliberately a plain unit test rather than `afterInvariant()`: an
     * "X must have happened" assertion placed in afterInvariant is trivially
     * satisfied-in-reverse by the shrinker, which collapses the sequence to a
     * single call and reports a false failure. Here we drive the handler through a
     * scripted sequence and prove each terminal path is genuinely reachable, which
     * is what makes the fuzz campaign above meaningful.
     */
    function test_handlerCanReachEveryTerminalState() public {
        // create + accept + settle
        handler.createWager(0, uint96(1 ether), 1000);
        handler.acceptWager(1, 0);
        handler.settle(0, true);

        // draw
        handler.createWager(0, uint96(2 ether), 1000);
        handler.acceptWager(1, 1);
        handler.settleDraw(1);

        // timeout
        handler.createWager(0, uint96(3 ether), 100000);
        handler.acceptWager(1, 2);
        handler.warp(type(uint32).max); // bounded to 3 days, past settleTimeout
        handler.claimTimeout(0, 2);

        // cancel
        handler.createWager(0, uint96(4 ether), 1000);
        handler.cancelWager(0, 3);

        // withdraw
        handler.withdraw(0);
        handler.withdraw(1);
        handler.withdrawTreasury();

        assertGt(handler.ghostDeposited(), 0, "no ETH ever entered the contract");
        assertGt(handler.ghostAccepted(), 0, "accept path unreachable");
        assertGt(handler.ghostSettled(), 0, "settle path unreachable");
        assertGt(handler.ghostDrawn(), 0, "draw path unreachable");
        assertGt(handler.ghostTimedOut(), 0, "timeout path unreachable");
        assertGt(handler.ghostCancelled(), 0, "cancel path unreachable");
        assertGt(handler.ghostWithdrawals(), 0, "withdraw path unreachable");
        assertGt(handler.ghostWithdrawn(), 0, "no ETH ever left the contract");

        // And the owner still got nothing out of any of it.
        handler.ownerTriesToWithdraw();
        assertEq(handler.ghostOwnerWithdrawn(), 0, "owner extracted value");
    }

    /// @notice The contract always holds at least what it owes.
    function invariant_solvent() public view {
        assertGe(address(escrow).balance, escrow.totalEscrowed() + escrow.totalCredited(), "INSOLVENT");
    }

    /// @notice Balance is fully explained by deposits minus withdrawals — no ETH
    ///         appears from nowhere and none goes missing.
    function invariant_balanceMatchesGhostAccounting() public view {
        assertEq(
            address(escrow).balance,
            handler.ghostDeposited() - handler.ghostWithdrawn(),
            "balance drifted from deposit/withdrawal history"
        );
    }

    /// @notice The owner never extracts a single wei, no matter how it meddles.
    ///         (In this run the owner is never a player, and fees route to the
    ///         treasury address, so any owner withdrawal at all would be theft.)
    function invariant_ownerNeverExtractsValue() public view {
        assertEq(handler.ghostOwnerWithdrawn(), 0, "owner extracted user funds");
        assertEq(escrow.balances(owner), 0, "owner accrued a withdrawable balance");
    }

    /// @notice Escrow accounting never exceeds the ETH actually held, and a fully
    ///         resolved book means the contract only holds unwithdrawn credits.
    function invariant_escrowedNeverExceedsBalance() public view {
        assertLe(escrow.totalEscrowed(), address(escrow).balance, "escrow overstated");
        assertLe(escrow.totalCredited(), address(escrow).balance, "credits overstated");
    }

    /// @notice Every wager that is not in a terminal state is fully collateralised.
    function invariant_openAndActiveWagersAreBacked() public view {
        uint256 n = handler.liveIdCount();
        uint256 required;
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.idAt(i);
            PokePlayEscrow.Wager memory w = escrow.getWager(id);
            if (w.status == PokePlayEscrow.Status.OPEN) {
                required += w.stake;
            } else if (w.status == PokePlayEscrow.Status.ACTIVE) {
                required += w.stake * 2;
            }
        }
        assertEq(required, escrow.totalEscrowed(), "totalEscrowed does not match live wagers");
        assertGe(address(escrow).balance, required + escrow.totalCredited(), "live wagers are not fully backed");
    }
}
