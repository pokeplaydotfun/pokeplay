// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TournamentBaseTest} from "./TournamentBase.t.sol";
import {PokePlayTournamentPool} from "../src/PokePlayTournamentPool.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract PokePlayTournamentPoolTest is TournamentBaseTest {
    // =====================================================================
    //                            CONSTRUCTION
    // =====================================================================

    function test_constructor_setsConfig() public view {
        assertEq(pool.owner(), owner);
        assertEq(pool.arbiter(), arbiter);
        assertEq(pool.treasury(), treasury);
        assertEq(pool.feeBps(), DEFAULT_FEE_BPS);
        assertEq(pool.settleTimeout(), 24 hours);
        assertEq(pool.tournamentCount(), 0);
    }

    function test_constructor_revertsOnZeroAddresses() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new PokePlayTournamentPool(address(0), arbiter, treasury, 0);

        vm.expectRevert(PokePlayTournamentPool.ZeroAddress.selector);
        new PokePlayTournamentPool(owner, address(0), treasury, 0);

        vm.expectRevert(PokePlayTournamentPool.ZeroAddress.selector);
        new PokePlayTournamentPool(owner, arbiter, address(0), 0);
    }

    function test_constructor_enforcesFeeCap() public {
        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.FeeTooHigh.selector, 501, 500));
        new PokePlayTournamentPool(owner, arbiter, treasury, 501);

        PokePlayTournamentPool atCap = new PokePlayTournamentPool(owner, arbiter, treasury, 500);
        assertEq(atCap.feeBps(), 500);
    }

    // =====================================================================
    //                              CREATE
    // =====================================================================

    function test_create_setsFieldsAndAssignsIds() public {
        uint64 deadline = _defaultDeadline();
        vm.prank(organizer);
        uint256 id = pool.createTournament(1 ether, 8, deadline);
        assertEq(id, 1);

        PokePlayTournamentPool.Tournament memory t = pool.getTournament(id);
        assertEq(t.organizer, organizer);
        assertEq(t.entryFee, 1 ether);
        assertEq(t.maxPlayers, 8);
        assertEq(t.playerCount, 0);
        assertEq(t.registrationDeadline, deadline);
        assertEq(uint8(t.status), uint8(PokePlayTournamentPool.Status.OPEN));
        assertEq(t.nonce, 1);

        // Ids and nonces are monotonic.
        vm.prank(organizer);
        uint256 id2 = pool.createTournament(1 ether, 8, deadline);
        assertEq(id2, 2);
        assertEq(pool.getTournament(id2).nonce, 2);
    }

    function test_create_rejectsZeroEntryFee() public {
        vm.prank(organizer);
        vm.expectRevert(PokePlayTournamentPool.ZeroEntryFee.selector);
        pool.createTournament(0, 8, _defaultDeadline());
    }

    function test_create_enforcesPlayerRange() public {
        vm.startPrank(organizer);
        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.MaxPlayersOutOfRange.selector, 1, 2, 64));
        pool.createTournament(1 ether, 1, _defaultDeadline());

        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.MaxPlayersOutOfRange.selector, 65, 2, 64));
        pool.createTournament(1 ether, 65, _defaultDeadline());

        // The endpoints are allowed.
        pool.createTournament(1 ether, 2, _defaultDeadline());
        pool.createTournament(1 ether, 64, _defaultDeadline());
        vm.stopPrank();
    }

    function test_create_rejectsDeadlineInPast() public {
        vm.prank(organizer);
        vm.expectRevert(
            abi.encodeWithSelector(PokePlayTournamentPool.DeadlineInPast.selector, uint64(block.timestamp), block.timestamp)
        );
        pool.createTournament(1 ether, 8, uint64(block.timestamp));
    }

    // =====================================================================
    //                               JOIN
    // =====================================================================

    function test_join_escrowsAndCountsPlayers() public {
        uint256 fee = 2 ether;
        uint256 id = _create(fee, 8);

        uint256 before = alice.balance;
        _join(id, alice);
        assertEq(alice.balance, before - fee, "fee did not leave the wallet");
        assertEq(pool.getTournament(id).playerCount, 1);
        assertTrue(pool.isEntrant(id, alice));
        assertEq(address(pool).balance, fee);
        assertEq(pool.totalEscrowed(), fee);
        assertEq(pool.potOf(id), fee);

        _join(id, bob);
        assertEq(pool.getTournament(id).playerCount, 2);
        assertEq(pool.potOf(id), fee * 2);
        _assertSolvent();
    }

    function test_join_mustMatchFeeExactly() public {
        uint256 id = _create(2 ether, 8);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.EntryFeeMismatch.selector, 2 ether, 1 ether));
        pool.joinTournament{value: 1 ether}(id);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.EntryFeeMismatch.selector, 2 ether, 3 ether));
        pool.joinTournament{value: 3 ether}(id);
    }

    function test_join_cannotJoinTwice() public {
        uint256 id = _create(1 ether, 8);
        _join(id, alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.AlreadyJoined.selector, id, alice));
        pool.joinTournament{value: 1 ether}(id);
    }

    function test_join_respectsTheCap() public {
        uint256 id = _create(1 ether, 2);
        _join(id, alice);
        _join(id, bob);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.TournamentFull.selector, id, 2));
        pool.joinTournament{value: 1 ether}(id);
    }

    function test_join_closedAfterDeadline() public {
        uint256 id = _create(1 ether, 8);
        vm.warp(block.timestamp + 2 days);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                PokePlayTournamentPool.RegistrationClosed.selector, id, pool.getTournament(id).registrationDeadline
            )
        );
        pool.joinTournament{value: 1 ether}(id);
    }

    function test_join_nonexistentReverts() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PokePlayTournamentPool.TournamentNotOpen.selector, 999, PokePlayTournamentPool.Status.NONE)
        );
        pool.joinTournament{value: 1 ether}(999);
    }

    // =====================================================================
    //                          SETTLE / PAYOUT
    // =====================================================================

    function test_happyPath_fourPlayerWinnerTakesPot() public {
        uint256 fee = 5 ether;
        uint256 id = _createAndFill(fee, _four());

        uint256 pot = fee * 4;
        uint256 expectedFee = (pot * DEFAULT_FEE_BPS) / 10_000;
        uint256 expectedPayout = pot - expectedFee;

        // Anyone may relay the signed result; use a bystander to prove it.
        vm.prank(erin);
        pool.settle(id, carol, _signResult(id, carol));

        assertEq(uint8(pool.statusOf(id)), uint8(PokePlayTournamentPool.Status.SETTLED));
        assertEq(pool.balances(carol), expectedPayout, "winner credited wrong amount");
        assertEq(pool.balances(treasury), expectedFee, "treasury credited wrong fee");
        assertEq(pool.totalEscrowed(), 0);
        _assertSolvent();

        // Winner pulls the ETH out.
        uint256 before = carol.balance;
        vm.prank(carol);
        pool.withdraw();
        assertEq(carol.balance, before + expectedPayout);
        _assertSolvent();
    }

    function test_settle_potIsOverActualEntrantsNotTheCap() public {
        // A max-8 tournament that only drew 3 pays a 3-fee pot, not 8.
        uint256 fee = 1 ether;
        uint256 id = _create(fee, 8);
        _join(id, alice);
        _join(id, bob);
        _join(id, carol);

        pool.settle(id, bob, _signResult(id, bob));
        uint256 pot = fee * 3;
        uint256 expectedFee = (pot * DEFAULT_FEE_BPS) / 10_000;
        assertEq(pool.balances(bob), pot - expectedFee);
        assertEq(pool.balances(treasury), expectedFee);
    }

    function test_settle_feeMathsAtSeveralBps() public {
        uint16[4] memory bpsValues = [uint16(0), 100, 250, 500];
        for (uint256 i = 0; i < bpsValues.length; i++) {
            uint16 bps = bpsValues[i];
            vm.prank(owner);
            pool.setFeeBps(bps);

            uint256 fee = 3 ether;
            uint256 id = _createAndFill(fee, _four());
            uint256 pot = fee * 4;
            uint256 houseFee = (pot * bps) / 10_000;

            pool.settle(id, alice, _signResult(id, alice));
            assertEq(pool.balances(alice), pot - houseFee, "payout wrong at this bps");
            assertEq(pool.balances(treasury), houseFee, "fee wrong at this bps");

            // Drain balances so the next loop starts clean.
            vm.prank(alice);
            pool.withdraw();
            if (houseFee > 0) {
                vm.prank(treasury);
                pool.withdraw();
            }
            _assertSolvent();
        }
    }

    function test_settle_zeroBpsWinnerTakesEverything() public {
        vm.prank(owner);
        pool.setFeeBps(0);
        uint256 id = _createAndFill(2 ether, _four());
        pool.settle(id, dave, _signResult(id, dave));
        assertEq(pool.balances(dave), 8 ether);
        assertEq(pool.balances(treasury), 0);
    }

    function test_settle_winnerMustBeAnEntrant() public {
        uint256 id = _createAndFill(1 ether, _four());
        // erin never joined. Precompute the signature so expectRevert lands on
        // settle() and not on the view call inside the signing helper.
        bytes memory sig = _signResult(id, erin);
        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.WinnerNotEntrant.selector, id, erin));
        pool.settle(id, erin, sig);
    }

    function test_settle_needsAtLeastTwoPlayers() public {
        uint256 id = _create(1 ether, 8);
        _join(id, alice);
        bytes memory sig = _signResult(id, alice);
        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.NotEnoughPlayers.selector, id, 1));
        pool.settle(id, alice, sig);
    }

    function test_settle_cannotSettleTwice() public {
        uint256 id = _createAndFill(1 ether, _four());
        bytes memory sig = _signResult(id, alice);
        pool.settle(id, alice, sig);
        vm.expectRevert(
            abi.encodeWithSelector(
                PokePlayTournamentPool.TournamentNotOpen.selector, id, PokePlayTournamentPool.Status.SETTLED
            )
        );
        pool.settle(id, alice, sig);
    }

    function test_settle_losersGetNothing() public {
        uint256 id = _createAndFill(1 ether, _four());
        pool.settle(id, alice, _signResult(id, alice));
        assertEq(pool.balances(bob), 0);
        assertEq(pool.balances(carol), 0);
        assertEq(pool.balances(dave), 0);
        // A loser trying to withdraw finds nothing.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.NothingToWithdraw.selector, bob));
        pool.withdraw();
    }

    // =====================================================================
    //                              CANCEL
    // =====================================================================

    function test_cancel_organizerBeforeDeadlineRefundsAll() public {
        uint256 fee = 3 ether;
        uint256 id = _create(fee, 8);
        _join(id, alice);
        _join(id, bob);

        vm.prank(organizer);
        pool.cancelTournament(id);
        assertEq(uint8(pool.statusOf(id)), uint8(PokePlayTournamentPool.Status.REFUNDING));

        // Each entrant reclaims exactly their own fee, no fee taken.
        uint256 aBefore = alice.balance;
        vm.prank(alice);
        pool.claimRefund(id);
        vm.prank(alice);
        pool.withdraw();
        assertEq(alice.balance, aBefore + fee);

        vm.prank(bob);
        pool.claimRefund(id);
        assertEq(pool.balances(bob), fee);
        assertEq(pool.balances(treasury), 0, "cancel must never take a fee");
        _assertSolvent();
    }

    function test_cancel_nonOrganizerCannotBeforeDeadline() public {
        uint256 id = _create(1 ether, 8);
        _join(id, alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.CannotCancel.selector, id));
        pool.cancelTournament(id);
    }

    function test_cancel_organizerCannotAfterDeadlineIfRunnable() public {
        // Two players joined, deadline passed: it is runnable, so even the organizer
        // cannot cancel it — only the timeout can unwind a live tournament.
        uint256 id = _create(1 ether, 8);
        _join(id, alice);
        _join(id, bob);
        vm.warp(block.timestamp + 2 days);
        vm.prank(organizer);
        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.CannotCancel.selector, id));
        pool.cancelTournament(id);
    }

    function test_cancel_anyoneCanCancelUnrunnableAfterDeadline() public {
        // Only one player joined and the deadline passed: it can never produce a
        // winner, so anyone may cancel it to open refunds without waiting out the
        // full timeout.
        uint256 id = _create(1 ether, 8);
        _join(id, alice);
        vm.warp(block.timestamp + 2 days);

        vm.prank(erin); // a total stranger
        pool.cancelTournament(id);
        assertEq(uint8(pool.statusOf(id)), uint8(PokePlayTournamentPool.Status.REFUNDING));

        vm.prank(alice);
        pool.claimRefund(id);
        assertEq(pool.balances(alice), 1 ether);
    }

    function test_cancel_cannotCancelSettled() public {
        uint256 id = _createAndFill(1 ether, _four());
        pool.settle(id, alice, _signResult(id, alice));
        vm.prank(organizer);
        vm.expectRevert(
            abi.encodeWithSelector(
                PokePlayTournamentPool.TournamentNotOpen.selector, id, PokePlayTournamentPool.Status.SETTLED
            )
        );
        pool.cancelTournament(id);
    }

    // =====================================================================
    //                    TIMEOUT REFUND (liveness hatch)
    // =====================================================================

    function test_timeout_refundsEveryEntrantExactlyOnce() public {
        uint256 fee = 4 ether;
        uint256 id = _createAndFill(fee, _four());

        // Before the timeout, nobody can force a refund.
        uint64 claimAt = pool.timeoutAt(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.TimeoutNotReached.selector, id, claimAt));
        pool.claimRefund(id);

        // Jump past registrationDeadline + settleTimeout.
        vm.warp(uint256(claimAt) + 1);

        // The first claim flips the whole tournament to REFUNDING for everyone.
        vm.prank(alice);
        pool.claimRefund(id);
        assertEq(uint8(pool.statusOf(id)), uint8(PokePlayTournamentPool.Status.REFUNDING));
        assertEq(pool.balances(alice), fee);

        // Everyone else claims without re-checking the clock.
        vm.prank(bob);
        pool.claimRefund(id);
        vm.prank(carol);
        pool.claimRefund(id);
        vm.prank(dave);
        pool.claimRefund(id);
        assertEq(pool.balances(bob), fee);
        assertEq(pool.balances(carol), fee);
        assertEq(pool.balances(dave), fee);
        assertEq(pool.balances(treasury), 0, "timeout must never take a fee");
        assertEq(pool.totalEscrowed(), 0, "every fee should be released");
        _assertSolvent();
    }

    function test_timeout_doubleClaimIsRefused() public {
        uint256 id = _createAndFill(1 ether, _four());
        vm.warp(uint256(pool.timeoutAt(id)) + 1);
        vm.prank(alice);
        pool.claimRefund(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.NotEntrantOrAlreadyRefunded.selector, id, alice));
        pool.claimRefund(id);
    }

    function test_timeout_nonEntrantCannotClaim() public {
        uint256 id = _createAndFill(1 ether, _four());
        vm.warp(uint256(pool.timeoutAt(id)) + 1);
        vm.prank(erin);
        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.NotEntrantOrAlreadyRefunded.selector, id, erin));
        pool.claimRefund(id);
    }

    function test_timeout_cannotRefundAfterSettle() public {
        uint256 id = _createAndFill(1 ether, _four());
        pool.settle(id, alice, _signResult(id, alice));
        // bob is a real entrant but the pot is already paid out.
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                PokePlayTournamentPool.NotRefundable.selector, id, PokePlayTournamentPool.Status.SETTLED
            )
        );
        pool.claimRefund(id);
    }

    function test_timeout_cannotSettleAfterRefundBegan() public {
        uint256 id = _createAndFill(1 ether, _four());
        bytes memory sig = _signResult(id, alice);
        vm.warp(uint256(pool.timeoutAt(id)) + 1);
        vm.prank(bob);
        pool.claimRefund(id); // flips to REFUNDING

        vm.expectRevert(
            abi.encodeWithSelector(
                PokePlayTournamentPool.TournamentNotOpen.selector, id, PokePlayTournamentPool.Status.REFUNDING
            )
        );
        pool.settle(id, alice, sig);
    }

    function test_timeout_survivesRogueArbiterAndAbandonedOwner() public {
        // The nightmare: the owner vanishes and the arbiter key turns hostile. The
        // refund path needs neither of them, so the players' money still comes home.
        uint256 fee = 2 ether;
        uint256 id = _createAndFill(fee, _four());

        vm.warp(uint256(pool.timeoutAt(id)) + 1);
        for (uint256 i = 0; i < 4; i++) {
            address p = _four()[i];
            vm.prank(p);
            pool.claimRefund(id);
            vm.prank(p);
            pool.withdraw();
        }
        _assertSolvent();
        assertEq(address(pool).balance, 0);
    }

    function test_timeout_usesUpdatedTimeoutValue() public {
        vm.prank(owner);
        pool.setSettleTimeout(2 hours);
        uint256 id = _createAndFill(1 ether, _four());
        uint64 deadline = pool.getTournament(id).registrationDeadline;
        assertEq(pool.timeoutAt(id), deadline + 2 hours);
    }

    // =====================================================================
    //                       SIGNATURE / REPLAY SAFETY
    // =====================================================================

    function test_signature_fromNonArbiterReverts() public {
        uint256 id = _createAndFill(1 ether, _four());
        bytes memory sig = _signResult(id, alice, attackerPk);
        vm.expectRevert(
            abi.encodeWithSelector(PokePlayTournamentPool.InvalidArbiterSignature.selector, id, attacker)
        );
        pool.settle(id, alice, sig);
    }

    function test_signature_forDifferentWinnerReverts() public {
        uint256 id = _createAndFill(1 ether, _four());
        // A signature naming alice cannot settle bob as the winner.
        bytes memory sigForAlice = _signResult(id, alice);
        vm.expectRevert();
        pool.settle(id, bob, sigForAlice);
    }

    function test_signature_malleableIsRejected() public {
        uint256 id = _createAndFill(1 ether, _four());
        bytes memory good = _signResult(id, alice);
        bytes memory evil = _malleate(good);
        vm.expectRevert();
        pool.settle(id, alice, evil);
    }

    function test_signature_malformedLengthReverts() public {
        uint256 id = _createAndFill(1 ether, _four());
        vm.expectRevert();
        pool.settle(id, alice, hex"dead");
    }

    function test_signature_emptyReverts() public {
        uint256 id = _createAndFill(1 ether, _four());
        vm.expectRevert();
        pool.settle(id, alice, "");
    }

    function test_signature_replayAcrossTournamentsFails() public {
        uint256 id1 = _createAndFill(1 ether, _four());
        uint256 id2 = _createAndFill(1 ether, _four());
        // A signature for tournament 1 must not settle tournament 2, even for the
        // same winner — the id and per-tournament nonce are in the signed struct.
        bytes memory sigFor1 = _signResult(id1, alice);
        vm.expectRevert();
        pool.settle(id2, alice, sigFor1);
    }

    function test_signature_rotatingArbiterInvalidatesOldKey() public {
        uint256 id = _createAndFill(1 ether, _four());
        bytes memory oldSig = _signResult(id, alice); // signed by the current arbiter

        (address newArbiter,) = makeAddrAndKey("newArbiter");
        vm.prank(owner);
        pool.setArbiter(newArbiter);

        vm.expectRevert(
            abi.encodeWithSelector(PokePlayTournamentPool.InvalidArbiterSignature.selector, id, arbiter)
        );
        pool.settle(id, alice, oldSig);
    }

    function test_signature_boundToVerifyingContract() public {
        uint256 id = _createAndFill(1 ether, _four());
        // A second deployment with the SAME arbiter must not honour the first's sig:
        // the EIP-712 domain binds verifyingContract.
        PokePlayTournamentPool other = new PokePlayTournamentPool(owner, arbiter, treasury, DEFAULT_FEE_BPS);
        vm.prank(organizer);
        uint256 otherId = other.createTournament(1 ether, 4, _defaultDeadline());
        vm.prank(alice);
        other.joinTournament{value: 1 ether}(otherId);
        vm.prank(bob);
        other.joinTournament{value: 1 ether}(otherId);

        bytes memory sigForThisPool = _signResult(id, alice);
        vm.expectRevert();
        other.settle(otherId, alice, sigForThisPool);
    }

    function test_signature_replayAcrossChainIdReverts() public {
        uint256 id = _createAndFill(1 ether, _four());
        bytes memory sig = _signResult(id, alice);

        // Re-sign the digest as it WOULD be on another chain, then move there. The
        // digest changes with chainId, so the old signature stops verifying.
        vm.chainId(block.chainid + 1);
        vm.expectRevert();
        pool.settle(id, alice, sig);
    }

    // =====================================================================
    //                              PAUSE
    // =====================================================================

    function test_pause_blocksCreateAndJoin() public {
        uint256 id = _create(1 ether, 8);
        _join(id, alice);

        vm.prank(owner);
        pool.pause();

        vm.prank(organizer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pool.createTournament(1 ether, 8, _defaultDeadline());

        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pool.joinTournament{value: 1 ether}(id);
    }

    function test_pause_neverBlocksExits() public {
        uint256 id = _createAndFill(1 ether, _four());

        vm.prank(owner);
        pool.pause();

        // settle, withdraw all keep working while paused.
        pool.settle(id, alice, _signResult(id, alice));
        vm.prank(alice);
        pool.withdraw();
        assertEq(pool.balances(alice), 0);

        // And on a second, refunding tournament: cancel + claimRefund also work paused.
        vm.prank(owner);
        pool.unpause();
        uint256 id2 = _create(1 ether, 8);
        _join(id2, bob);
        vm.prank(owner);
        pool.pause();
        vm.prank(organizer);
        pool.cancelTournament(id2);
        vm.prank(bob);
        pool.claimRefund(id2);
        assertEq(pool.balances(bob), 1 ether);
    }

    function test_pause_unpauseRestores() public {
        vm.prank(owner);
        pool.pause();
        vm.prank(owner);
        pool.unpause();
        uint256 id = _create(1 ether, 8);
        _join(id, alice);
        assertTrue(pool.isEntrant(id, alice));
    }

    // =====================================================================
    //                          ACCESS CONTROL
    // =====================================================================

    function test_accessControl_ownerOnlyFunctions() public {
        vm.startPrank(attacker);
        bytes memory notOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker);

        vm.expectRevert(notOwner);
        pool.setArbiter(attacker);
        vm.expectRevert(notOwner);
        pool.setTreasury(attacker);
        vm.expectRevert(notOwner);
        pool.setFeeBps(0);
        vm.expectRevert(notOwner);
        pool.setSettleTimeout(1 hours);
        vm.expectRevert(notOwner);
        pool.pause();
        vm.stopPrank();
    }

    function test_setters_validation() public {
        vm.startPrank(owner);

        vm.expectRevert(PokePlayTournamentPool.ZeroAddress.selector);
        pool.setArbiter(address(0));
        vm.expectRevert(PokePlayTournamentPool.ZeroAddress.selector);
        pool.setTreasury(address(0));

        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.FeeTooHigh.selector, 501, 500));
        pool.setFeeBps(501);

        vm.expectRevert(
            abi.encodeWithSelector(
                PokePlayTournamentPool.TimeoutOutOfRange.selector, uint64(1 minutes), uint64(5 minutes), uint64(7 days)
            )
        );
        pool.setSettleTimeout(1 minutes);
        vm.expectRevert(
            abi.encodeWithSelector(
                PokePlayTournamentPool.TimeoutOutOfRange.selector, uint64(8 days), uint64(5 minutes), uint64(7 days)
            )
        );
        pool.setSettleTimeout(8 days);

        // Valid updates take.
        pool.setFeeBps(400);
        assertEq(pool.feeBps(), 400);
        pool.setSettleTimeout(6 days);
        assertEq(pool.settleTimeout(), 6 days);
        vm.stopPrank();
    }

    function test_ownership_isTwoStep() public {
        vm.prank(owner);
        pool.transferOwnership(alice);
        // Not yet — transfer is pending until acceptance.
        assertEq(pool.owner(), owner);
        assertEq(pool.pendingOwner(), alice);

        // A stranger cannot accept.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        pool.acceptOwnership();

        vm.prank(alice);
        pool.acceptOwnership();
        assertEq(pool.owner(), alice);
    }

    // =====================================================================
    //                    OWNER CANNOT DRAIN POOLED FEES
    // =====================================================================

    function test_ownerCannotDrainPot_noAdminPathMovesEth() public {
        uint256 id = _createAndFill(10 ether, _four());
        uint256 held = address(pool).balance;

        // Exercise every owner power. None can move a pooled fee.
        vm.startPrank(owner);
        pool.setFeeBps(500);
        pool.setTreasury(owner); // even pointing the treasury at themselves...
        pool.setSettleTimeout(1 hours);
        pool.pause();
        pool.unpause();
        vm.stopPrank();

        assertEq(address(pool).balance, held, "an owner action moved pooled ETH");
        _assertSolvent();
    }

    function test_ownerCannotDrainPot_maliciousArbiterStillBoundedToEntrants() public {
        // Worst case: owner repoints the arbiter at a key it controls. It STILL can
        // only pay an entrant of that tournament — never a fresh attacker address.
        uint256 id = _createAndFill(10 ether, _four());

        (address evilArbiter, uint256 evilPk) = makeAddrAndKey("evilArbiter");
        vm.prank(owner);
        pool.setArbiter(evilArbiter);

        // Naming the attacker (a non-entrant) is rejected.
        bytes memory sigForAttacker = _signResult(id, attacker, evilPk);
        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.WinnerNotEntrant.selector, id, attacker));
        pool.settle(id, attacker, sigForAttacker);

        // The most it can do is hand the pot to one of the four real players.
        pool.settle(id, alice, _signResult(id, alice, evilPk));
        uint256 pot = 40 ether;
        assertEq(pool.balances(alice), pot - (pot * DEFAULT_FEE_BPS) / 10_000);
        _assertSolvent();
    }

    function test_ownerCannotDrainPot_feeIsTheOnlyOwnerReachableEth() public {
        uint256 id = _createAndFill(10 ether, _four());
        pool.settle(id, alice, _signResult(id, alice));

        uint256 pot = 40 ether;
        uint256 fee = (pot * DEFAULT_FEE_BPS) / 10_000;
        // The treasury balance is exactly the fee, and it is withdrawn through the
        // same public path as everyone else — there is no admin sweep.
        assertEq(pool.balances(treasury), fee);
        vm.prank(treasury);
        pool.withdraw();
        assertEq(treasury.balance, fee);
    }

    // =====================================================================
    //                          LEAVE (unjoin + refund)
    // =====================================================================

    function test_leave_refundsAndDecrementsCount() public {
        uint256 fee = 2 ether;
        uint256 id = _createAndFill(fee, _four());
        assertEq(pool.getTournament(id).playerCount, 4);

        vm.prank(bob);
        pool.leaveTournament(id);

        assertFalse(pool.isEntrant(id, bob));
        assertEq(pool.getTournament(id).playerCount, 3);
        assertEq(pool.balances(bob), fee, "leaver was not refunded their fee");
        assertEq(pool.potOf(id), fee * 3, "pot did not shrink");

        uint256 before = bob.balance;
        vm.prank(bob);
        pool.withdraw();
        assertEq(bob.balance, before + fee);
        _assertSolvent();
    }

    function test_leave_cannotLeaveOnceRegistrationCloses() public {
        uint256 id = _createAndFill(1 ether, _four());
        vm.warp(block.timestamp + 2 days); // past the 1-day default deadline
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                PokePlayTournamentPool.RegistrationClosed.selector, id, pool.getTournament(id).registrationDeadline
            )
        );
        pool.leaveTournament(id);
    }

    function test_leave_nonEntrantReverts() public {
        uint256 id = _createAndFill(1 ether, _four());
        vm.prank(erin);
        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.NotEntrantOrAlreadyRefunded.selector, id, erin));
        pool.leaveTournament(id);
    }

    function test_leave_cannotLeaveSettledTournament() public {
        uint256 id = _createAndFill(1 ether, _four());
        pool.settle(id, alice, _signResult(id, alice));
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                PokePlayTournamentPool.TournamentNotOpen.selector, id, PokePlayTournamentPool.Status.SETTLED
            )
        );
        pool.leaveTournament(id);
    }

    function test_leave_canRejoinAfterLeaving() public {
        uint256 id = _create(1 ether, 4);
        _join(id, alice);
        vm.prank(alice);
        pool.leaveTournament(id);
        assertEq(pool.getTournament(id).playerCount, 0);

        _join(id, alice); // back in
        assertTrue(pool.isEntrant(id, alice));
        assertEq(pool.getTournament(id).playerCount, 1);
    }

    function test_leave_shrinksThePayout() public {
        // A player who leaves takes their fee out; the winner then wins a pot over
        // only the players who stayed.
        uint256 fee = 1 ether;
        uint256 id = _createAndFill(fee, _four());
        vm.prank(dave);
        pool.leaveTournament(id); // 3 remain

        pool.settle(id, alice, _signResult(id, alice));
        uint256 pot = fee * 3;
        uint256 expectedFee = (pot * DEFAULT_FEE_BPS) / 10_000;
        assertEq(pool.balances(alice), pot - expectedFee);
        assertEq(pool.balances(dave), fee, "the leaver kept their own fee");
        _assertSolvent();
    }

    // =====================================================================
    //                        EXTEND DEADLINE
    // =====================================================================

    function test_extend_pushesDeadlineForward() public {
        uint256 id = _create(1 ether, 8);
        uint64 orig = pool.getTournament(id).registrationDeadline;
        uint64 newDl = orig + 2 days;

        vm.prank(organizer);
        pool.extendDeadline(id, newDl);
        assertEq(pool.getTournament(id).registrationDeadline, newDl);

        // A join that would have been closed at the original deadline now works.
        vm.warp(uint256(orig) + 1);
        _join(id, alice);
        assertTrue(pool.isEntrant(id, alice));
    }

    function test_extend_alsoPushesTheRefundTimeout() public {
        uint256 id = _create(1 ether, 8);
        uint64 orig = pool.getTournament(id).registrationDeadline;
        uint64 timeout = pool.settleTimeout();
        assertEq(pool.timeoutAt(id), orig + timeout);

        vm.prank(organizer);
        pool.extendDeadline(id, orig + 3 days);
        assertEq(pool.timeoutAt(id), orig + 3 days + timeout);
    }

    function test_extend_onlyOrganizer() public {
        uint256 id = _create(1 ether, 8);
        uint64 target = pool.getTournament(id).registrationDeadline + 1 days;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.NotOrganizer.selector, id, alice));
        pool.extendDeadline(id, target);
    }

    function test_extend_mustBeLater() public {
        uint256 id = _create(1 ether, 8);
        uint64 dl = pool.getTournament(id).registrationDeadline;
        vm.prank(organizer);
        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.DeadlineNotLater.selector, dl, dl));
        pool.extendDeadline(id, dl); // equal is not "later"
    }

    function test_extend_boundedByMax() public {
        uint256 id = _create(1 ether, 8);
        uint64 tooFar = uint64(block.timestamp) + 31 days;
        uint64 max = uint64(block.timestamp) + 30 days;
        vm.prank(organizer);
        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.DeadlineTooFar.selector, tooFar, max));
        pool.extendDeadline(id, tooFar);
    }

    function test_extend_cannotExtendSettled() public {
        uint256 id = _createAndFill(1 ether, _four());
        pool.settle(id, alice, _signResult(id, alice));
        vm.prank(organizer);
        vm.expectRevert(
            abi.encodeWithSelector(
                PokePlayTournamentPool.TournamentNotOpen.selector, id, PokePlayTournamentPool.Status.SETTLED
            )
        );
        pool.extendDeadline(id, uint64(block.timestamp) + 1 days);
    }

    // =====================================================================
    //                        SOLVENCY / MISC
    // =====================================================================

    function test_solvency_holdsAcrossAMixedWorkload() public {
        // One settles, one refunds by timeout, one is cancelled, one is still filling.
        uint256 a = _createAndFill(3 ether, _four());
        uint256 b = _createAndFill(2 ether, _four());
        uint256 c = _create(1 ether, 8);
        _join(c, alice);
        _join(c, bob);
        uint256 d = _create(5 ether, 8);
        _join(d, carol);

        _assertSolvent();

        pool.settle(a, alice, _signResult(a, alice));
        _assertSolvent();

        // Cancel c while it is still before its deadline (the organizer's window).
        vm.prank(organizer);
        pool.cancelTournament(c);
        vm.prank(alice);
        pool.claimRefund(c);
        _assertSolvent();

        // Now jump past b's timeout and unwind it. This warp also passes c's and d's
        // deadlines, but c is already refunding and d is left as a stuck-but-solvent
        // pool nobody settled.
        vm.warp(uint256(pool.timeoutAt(b)) + 1);
        vm.prank(bob);
        pool.claimRefund(b);
        _assertSolvent();

        // Withdrawals in the middle keep the invariant.
        vm.prank(alice);
        pool.withdraw();
        _assertSolvent();

        // d is untouched and still escrowed.
        assertEq(pool.getTournament(d).playerCount, 1);
        _assertSolvent();
    }

    function test_receive_rejectsDirectPayments() public {
        vm.prank(alice);
        vm.expectRevert(PokePlayTournamentPool.DirectPaymentRejected.selector);
        (bool ok,) = address(pool).call{value: 1 ether}("");
        ok; // silence
    }

    function test_withdraw_zeroBalanceReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PokePlayTournamentPool.NothingToWithdraw.selector, alice));
        pool.withdraw();
    }

    function test_withdraw_accumulatesAcrossTournaments() public {
        // Winning two tournaments builds one withdrawable balance.
        uint256 id1 = _createAndFill(1 ether, _four());
        uint256 id2 = _createAndFill(2 ether, _four());
        pool.settle(id1, alice, _signResult(id1, alice));
        pool.settle(id2, alice, _signResult(id2, alice));

        uint256 pot1 = 4 ether;
        uint256 pot2 = 8 ether;
        uint256 fee1 = (pot1 * DEFAULT_FEE_BPS) / 10_000;
        uint256 fee2 = (pot2 * DEFAULT_FEE_BPS) / 10_000;
        uint256 expected = (pot1 - fee1) + (pot2 - fee2);
        assertEq(pool.balances(alice), expected);

        uint256 before = alice.balance;
        vm.prank(alice);
        pool.withdraw();
        assertEq(alice.balance, before + expected);
    }

    function test_view_timeoutAtIsZeroForNonOpen() public {
        uint256 id = _createAndFill(1 ether, _four());
        assertGt(pool.timeoutAt(id), 0);
        pool.settle(id, alice, _signResult(id, alice));
        assertEq(pool.timeoutAt(id), 0, "a settled tournament has no timeout");
    }

    function test_typehash_matchesTheDocumentedString() public view {
        assertEq(
            pool.TOURNAMENT_RESULT_TYPEHASH(),
            keccak256("TournamentResult(uint256 tournamentId,address winner,uint256 nonce)")
        );
    }
}
