// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {PokePlayEscrow} from "../src/PokePlayEscrow.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract PokePlayEscrowTest is BaseTest {
    // =====================================================================
    //                            CONSTRUCTION
    // =====================================================================

    function test_constructor_setsConfig() public view {
        assertEq(escrow.owner(), owner);
        assertEq(escrow.arbiter(), arbiter);
        assertEq(escrow.treasury(), treasury);
        assertEq(escrow.feeBps(), DEFAULT_FEE_BPS);
        assertEq(escrow.settleTimeout(), 1 hours);
        assertEq(escrow.wagerCount(), 0);
    }

    function test_constructor_revertsOnZeroAddresses() public {
        // Ownable's own constructor runs first and rejects a zero owner, so that
        // case surfaces as OwnableInvalidOwner rather than our ZeroAddress.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new PokePlayEscrow(address(0), arbiter, treasury, 0);

        vm.expectRevert(PokePlayEscrow.ZeroAddress.selector);
        new PokePlayEscrow(owner, address(0), treasury, 0);

        vm.expectRevert(PokePlayEscrow.ZeroAddress.selector);
        new PokePlayEscrow(owner, arbiter, address(0), 0);
    }

    function test_constructor_enforcesFeeCap() public {
        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.FeeTooHigh.selector, 501, 500));
        new PokePlayEscrow(owner, arbiter, treasury, 501);

        // Exactly at the cap is fine.
        PokePlayEscrow atCap = new PokePlayEscrow(owner, arbiter, treasury, 500);
        assertEq(atCap.feeBps(), 500);
    }

    // =====================================================================
    //                             HAPPY PATH
    // =====================================================================

    function test_happyPath_createAcceptSettleWithdraw() public {
        uint256 stake = 10 ether;
        uint256 aliceStart = alice.balance;
        uint256 bobStart = bob.balance;

        vm.prank(alice);
        uint256 id = escrow.createWager{value: stake}(stake, _defaultExpiry());
        assertEq(id, 1, "ids start at 1");
        assertEq(uint8(escrow.statusOf(id)), uint8(PokePlayEscrow.Status.OPEN));

        vm.prank(bob);
        escrow.acceptWager{value: stake}(id);
        assertEq(uint8(escrow.statusOf(id)), uint8(PokePlayEscrow.Status.ACTIVE));
        assertEq(escrow.totalEscrowed(), stake * 2);

        // Anyone may submit — carol, a total stranger, relays the signature.
        bytes memory sig = _signBattle(id, alice);
        vm.prank(carol);
        escrow.settle(id, alice, sig);

        uint256 pot = stake * 2;
        uint256 fee = (pot * DEFAULT_FEE_BPS) / 10_000;
        uint256 payout = pot - fee;

        assertEq(uint8(escrow.statusOf(id)), uint8(PokePlayEscrow.Status.SETTLED));
        assertEq(escrow.balances(alice), payout);
        assertEq(escrow.balances(bob), 0);
        assertEq(escrow.balances(treasury), fee);
        assertEq(escrow.totalEscrowed(), 0);
        _assertSolvent();

        // Winner withdraws.
        vm.prank(alice);
        escrow.withdraw();
        assertEq(alice.balance, aliceStart - stake + payout);
        assertEq(escrow.balances(alice), 0);

        // Treasury withdraws its fee.
        vm.prank(treasury);
        escrow.withdraw();
        assertEq(treasury.balance, fee);

        // Loser gets nothing and cannot withdraw.
        assertEq(bob.balance, bobStart - stake);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.NothingToWithdraw.selector, bob));
        escrow.withdraw();

        // Contract is fully drained: every wei accounted for.
        assertEq(address(escrow).balance, 0, "wei left stranded in contract");
        assertEq(payout + fee, pot, "payout + fee must equal pot exactly");
    }

    function test_settle_opponentCanWin() public {
        uint256 id = _createAndAccept(1 ether);
        bytes memory sig = _signBattle(id, bob);
        escrow.settle(id, bob, sig);

        uint256 fee = (2 ether * uint256(DEFAULT_FEE_BPS)) / 10_000;
        assertEq(escrow.balances(bob), 2 ether - fee);
        assertEq(escrow.balances(alice), 0);
    }

    function test_winnerCanSelfSubmit() public {
        uint256 id = _createAndAccept(1 ether);
        bytes memory sig = _signBattle(id, alice);
        vm.prank(alice);
        escrow.settle(id, alice, sig);
        assertGt(escrow.balances(alice), 0);
    }

    // =====================================================================
    //                              FEE MATHS
    // =====================================================================

    function test_feeMaths_exactAtSeveralBps() public {
        uint16[5] memory bpsValues = [uint16(0), 1, 100, 250, 500];

        for (uint256 i = 0; i < bpsValues.length; i++) {
            uint16 bps = bpsValues[i];
            vm.prank(owner);
            escrow.setFeeBps(bps);

            uint256 stake = 3.3333 ether; // deliberately not round
            uint256 id = _createAndAccept(stake);

            uint256 treasuryBefore = escrow.balances(treasury);
            escrow.settle(id, alice, _signBattle(id, alice));

            uint256 pot = stake * 2;
            uint256 expectedFee = (pot * bps) / 10_000;
            uint256 fee = escrow.balances(treasury) - treasuryBefore;
            uint256 payout = escrow.balances(alice);

            assertEq(fee, expectedFee, "fee mismatch");
            assertEq(payout + fee, pot, "wei lost: payout + fee != pot");

            // Reset alice's credited balance between iterations.
            vm.prank(alice);
            escrow.withdraw();
        }
    }

    function test_feeMaths_zeroBpsMeansWinnerTakesAll() public {
        vm.prank(owner);
        escrow.setFeeBps(0);

        uint256 id = _createAndAccept(5 ether);
        escrow.settle(id, alice, _signBattle(id, alice));

        assertEq(escrow.balances(alice), 10 ether);
        assertEq(escrow.balances(treasury), 0);
    }

    function test_feeMaths_atCapIsFivePercent() public {
        vm.prank(owner);
        escrow.setFeeBps(500);

        uint256 id = _createAndAccept(10 ether);
        escrow.settle(id, alice, _signBattle(id, alice));

        assertEq(escrow.balances(treasury), 1 ether); // 5% of a 20 ETH pot
        assertEq(escrow.balances(alice), 19 ether);
    }

    /// @dev Rounding always favours the winner (fee floors), never the house, and
    ///      never loses a wei.
    function testFuzz_feeMaths_noWeiLost(uint96 stakeRaw, uint16 bpsRaw) public {
        uint256 stake = bound(uint256(stakeRaw), 0, 100 ether);
        uint16 bps = uint16(bound(uint256(bpsRaw), 0, 500));

        vm.prank(owner);
        escrow.setFeeBps(bps);

        vm.deal(alice, stake);
        vm.deal(bob, stake);

        vm.prank(alice);
        uint256 id = escrow.createWager{value: stake}(stake, _defaultExpiry());
        vm.prank(bob);
        escrow.acceptWager{value: stake}(id);

        escrow.settle(id, alice, _signBattle(id, alice));

        uint256 pot = stake * 2;
        assertEq(escrow.balances(alice) + escrow.balances(treasury), pot, "wei lost");
        assertLe(escrow.balances(treasury) * 10_000, pot * uint256(bps), "fee exceeds bps");
        _assertSolvent();
    }

    // =====================================================================
    //                           ZERO-STAKE WAGERS
    // =====================================================================

    function test_zeroStake_fullLifecycle() public {
        vm.prank(alice);
        uint256 id = escrow.createWager{value: 0}(0, _defaultExpiry());
        vm.prank(bob);
        escrow.acceptWager{value: 0}(id);

        assertEq(uint8(escrow.statusOf(id)), uint8(PokePlayEscrow.Status.ACTIVE));

        escrow.settle(id, alice, _signBattle(id, alice));

        assertEq(uint8(escrow.statusOf(id)), uint8(PokePlayEscrow.Status.SETTLED));
        assertEq(escrow.balances(alice), 0);
        assertEq(escrow.balances(treasury), 0);
        assertEq(address(escrow).balance, 0);

        // Nothing to withdraw — correct, not an error state.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.NothingToWithdraw.selector, alice));
        escrow.withdraw();
    }

    function test_zeroStake_sendingValueReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.StakeMismatch.selector, 0, 1));
        escrow.createWager{value: 1}(0, _defaultExpiry());
    }

    function test_zeroStake_drawAndTimeoutWork() public {
        vm.prank(alice);
        uint256 id = escrow.createWager{value: 0}(0, _defaultExpiry());
        vm.prank(bob);
        escrow.acceptWager{value: 0}(id);
        escrow.settleDraw(id, _signDraw(id));
        assertEq(uint8(escrow.statusOf(id)), uint8(PokePlayEscrow.Status.REFUNDED));

        vm.prank(alice);
        uint256 id2 = escrow.createWager{value: 0}(0, _defaultExpiry());
        vm.prank(bob);
        escrow.acceptWager{value: 0}(id2);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(alice);
        escrow.claimTimeout(id2);
        assertEq(uint8(escrow.statusOf(id2)), uint8(PokePlayEscrow.Status.REFUNDED));
    }

    // =====================================================================
    //                          CREATE / ACCEPT GUARDS
    // =====================================================================

    function test_create_revertsIfValueMismatch() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.StakeMismatch.selector, 1 ether, 0.5 ether));
        escrow.createWager{value: 0.5 ether}(1 ether, _defaultExpiry());
    }

    function test_create_revertsIfExpiryInPast() public {
        uint64 past = uint64(block.timestamp);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.ExpiryInPast.selector, past, block.timestamp));
        escrow.createWager{value: 1 ether}(1 ether, past);
    }

    function test_accept_cannotAcceptOwnWager() public {
        vm.prank(alice);
        uint256 id = escrow.createWager{value: 1 ether}(1 ether, _defaultExpiry());

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.CannotAcceptOwnWager.selector, id));
        escrow.acceptWager{value: 1 ether}(id);
    }

    function test_accept_mustMatchStakeExactly() public {
        vm.prank(alice);
        uint256 id = escrow.createWager{value: 1 ether}(1 ether, _defaultExpiry());

        // Over-payment rejected (not `>=`).
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.StakeMismatch.selector, 1 ether, 1 ether + 1));
        escrow.acceptWager{value: 1 ether + 1}(id);

        // Under-payment rejected.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.StakeMismatch.selector, 1 ether, 1 ether - 1));
        escrow.acceptWager{value: 1 ether - 1}(id);
    }

    function test_accept_cannotAcceptTwice() public {
        uint256 id = _createAndAccept(1 ether);

        vm.prank(carol);
        vm.expectRevert(
            abi.encodeWithSelector(PokePlayEscrow.WagerNotOpen.selector, id, PokePlayEscrow.Status.ACTIVE)
        );
        escrow.acceptWager{value: 1 ether}(id);
    }

    function test_accept_cannotAcceptExpired() public {
        uint64 expiry = uint64(block.timestamp + 1 hours);
        vm.prank(alice);
        uint256 id = escrow.createWager{value: 1 ether}(1 ether, expiry);

        vm.warp(uint256(expiry) + 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.WagerExpired.selector, id, expiry));
        escrow.acceptWager{value: 1 ether}(id);
    }

    function test_accept_nonexistentWagerReverts() public {
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(PokePlayEscrow.WagerNotOpen.selector, 999, PokePlayEscrow.Status.NONE)
        );
        escrow.acceptWager{value: 1 ether}(999);
    }

    // =====================================================================
    //                                CANCEL
    // =====================================================================

    function test_cancel_byCreatorWhileOpen() public {
        uint256 start = alice.balance;
        vm.prank(alice);
        uint256 id = escrow.createWager{value: 4 ether}(4 ether, _defaultExpiry());

        vm.prank(alice);
        escrow.cancelWager(id);

        assertEq(uint8(escrow.statusOf(id)), uint8(PokePlayEscrow.Status.CANCELLED));
        assertEq(escrow.balances(alice), 4 ether);
        assertEq(escrow.totalEscrowed(), 0);

        vm.prank(alice);
        escrow.withdraw();
        assertEq(alice.balance, start, "creator must be made whole");
    }

    function test_cancel_byStrangerAfterExpiry_refundsCreatorNotStranger() public {
        uint64 expiry = uint64(block.timestamp + 1 hours);
        vm.prank(alice);
        uint256 id = escrow.createWager{value: 2 ether}(2 ether, expiry);

        vm.warp(uint256(expiry) + 1);
        vm.prank(carol); // a stranger triggers it
        escrow.cancelWager(id);

        assertEq(escrow.balances(alice), 2 ether, "refund goes to the creator");
        assertEq(escrow.balances(carol), 0, "stranger must not receive anything");
    }

    function test_cancel_strangerBeforeExpiryReverts() public {
        uint64 expiry = uint64(block.timestamp + 1 hours);
        vm.prank(alice);
        uint256 id = escrow.createWager{value: 1 ether}(1 ether, expiry);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.NotYetExpired.selector, id, expiry));
        escrow.cancelWager(id);
    }

    function test_cancel_cannotCancelActive() public {
        uint256 id = _createAndAccept(1 ether);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PokePlayEscrow.WagerNotOpen.selector, id, PokePlayEscrow.Status.ACTIVE)
        );
        escrow.cancelWager(id);
    }

    function test_cancel_cannotCancelTwice() public {
        vm.prank(alice);
        uint256 id = escrow.createWager{value: 1 ether}(1 ether, _defaultExpiry());
        vm.prank(alice);
        escrow.cancelWager(id);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PokePlayEscrow.WagerNotOpen.selector, id, PokePlayEscrow.Status.CANCELLED)
        );
        escrow.cancelWager(id);
    }

    // =====================================================================
    //                                 DRAW
    // =====================================================================

    function test_draw_refundsBothWithNoFee() public {
        uint256 stake = 7 ether;
        uint256 aliceStart = alice.balance;
        uint256 bobStart = bob.balance;

        uint256 id = _createAndAccept(stake);
        escrow.settleDraw(id, _signDraw(id));

        assertEq(uint8(escrow.statusOf(id)), uint8(PokePlayEscrow.Status.REFUNDED));
        assertEq(escrow.balances(alice), stake);
        assertEq(escrow.balances(bob), stake);
        assertEq(escrow.balances(treasury), 0, "draws must be fee-free");

        vm.prank(alice);
        escrow.withdraw();
        vm.prank(bob);
        escrow.withdraw();

        assertEq(alice.balance, aliceStart);
        assertEq(bob.balance, bobStart);
        assertEq(address(escrow).balance, 0);
    }

    function test_draw_cannotSettleAfterDraw() public {
        uint256 id = _createAndAccept(1 ether);
        bytes memory battleSig = _signBattle(id, alice);
        escrow.settleDraw(id, _signDraw(id));

        vm.expectRevert(
            abi.encodeWithSelector(PokePlayEscrow.WagerNotActive.selector, id, PokePlayEscrow.Status.REFUNDED)
        );
        escrow.settle(id, alice, battleSig);
    }

    function test_draw_battleSignatureIsNotADrawSignature() public {
        uint256 id = _createAndAccept(1 ether);
        // A valid decisive-result signature must not settle a draw.
        bytes memory battleSig = _signBattle(id, alice);
        vm.expectRevert();
        escrow.settleDraw(id, battleSig);
    }

    function test_draw_drawSignatureIsNotABattleSignature() public {
        uint256 id = _createAndAccept(1 ether);
        bytes memory drawSig = _signDraw(id);
        vm.expectRevert();
        escrow.settle(id, alice, drawSig);
    }

    // =====================================================================
    //                            TIMEOUT ESCAPE HATCH
    // =====================================================================

    function test_timeout_refundsExactStakesNoFee() public {
        uint256 stake = 9 ether;
        uint256 aliceStart = alice.balance;
        uint256 bobStart = bob.balance;

        uint256 id = _createAndAccept(stake);

        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(bob);
        escrow.claimTimeout(id);

        assertEq(escrow.balances(alice), stake);
        assertEq(escrow.balances(bob), stake);
        assertEq(escrow.balances(treasury), 0, "timeouts must be fee-free");

        vm.prank(alice);
        escrow.withdraw();
        vm.prank(bob);
        escrow.withdraw();
        assertEq(alice.balance, aliceStart);
        assertEq(bob.balance, bobStart);
    }

    function test_timeout_notReachedReverts() public {
        uint256 id = _createAndAccept(1 ether);
        uint64 claimableAt = escrow.timeoutAt(id);

        vm.warp(uint256(claimableAt)); // exactly at the boundary — not yet
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.TimeoutNotReached.selector, id, claimableAt));
        escrow.claimTimeout(id);

        vm.warp(uint256(claimableAt) + 1);
        vm.prank(alice);
        escrow.claimTimeout(id); // one second later it works
    }

    function test_timeout_onlyParticipants() public {
        uint256 id = _createAndAccept(1 ether);
        vm.warp(block.timestamp + 2 hours);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.NotParticipant.selector, id, carol));
        escrow.claimTimeout(id);
    }

    function test_timeout_cannotSettleAfterTimeout() public {
        uint256 id = _createAndAccept(1 ether);
        bytes memory sig = _signBattle(id, alice);

        vm.warp(block.timestamp + 2 hours);
        vm.prank(alice);
        escrow.claimTimeout(id);

        // The arbiter's signature is now worthless — the wager is terminal.
        vm.expectRevert(
            abi.encodeWithSelector(PokePlayEscrow.WagerNotActive.selector, id, PokePlayEscrow.Status.REFUNDED)
        );
        escrow.settle(id, alice, sig);
    }

    function test_timeout_survivesArbiterGoingRogueAndOwnerAbandoning() public {
        // The whole point: no admin action is needed for players to recover funds.
        uint256 id = _createAndAccept(3 ether);

        vm.prank(owner);
        escrow.pause(); // owner pauses and walks away

        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(alice);
        escrow.claimTimeout(id);

        vm.prank(alice);
        escrow.withdraw();
        vm.prank(bob);
        escrow.withdraw();
        assertEq(address(escrow).balance, 0);
    }

    function test_timeout_usesUpdatedTimeoutValue() public {
        uint256 id = _createAndAccept(1 ether);

        vm.prank(owner);
        escrow.setSettleTimeout(7 days);

        vm.warp(block.timestamp + 2 hours);
        vm.prank(alice);
        vm.expectRevert();
        escrow.claimTimeout(id);

        vm.warp(block.timestamp + 8 days);
        vm.prank(alice);
        escrow.claimTimeout(id);
    }

    // =====================================================================
    //                        SETTLE — STATE GUARDS
    // =====================================================================

    function test_settle_cannotSettleOpenWager() public {
        vm.prank(alice);
        uint256 id = escrow.createWager{value: 1 ether}(1 ether, _defaultExpiry());
        bytes memory sig = _signBattle(id, alice);

        vm.expectRevert(
            abi.encodeWithSelector(PokePlayEscrow.WagerNotActive.selector, id, PokePlayEscrow.Status.OPEN)
        );
        escrow.settle(id, alice, sig);
    }

    function test_settle_cannotSettleNonexistent() public {
        bytes memory sig = _signBattle(42, alice);
        vm.expectRevert(
            abi.encodeWithSelector(PokePlayEscrow.WagerNotActive.selector, 42, PokePlayEscrow.Status.NONE)
        );
        escrow.settle(42, alice, sig);
    }

    function test_settle_winnerMustBeParticipant() public {
        uint256 id = _createAndAccept(1 ether);
        // Even a perfectly valid arbiter signature naming an outsider is rejected.
        bytes memory sig = _signBattle(id, carol);

        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.WinnerNotParticipant.selector, id, carol));
        escrow.settle(id, carol, sig);
    }

    function test_settle_winnerCannotBeZeroAddress() public {
        uint256 id = _createAndAccept(1 ether);
        bytes memory sig = _signBattle(id, address(0));
        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.WinnerNotParticipant.selector, id, address(0)));
        escrow.settle(id, address(0), sig);
    }

    function test_settle_cannotSettleTwice() public {
        uint256 id = _createAndAccept(1 ether);
        bytes memory sig = _signBattle(id, alice);
        escrow.settle(id, alice, sig);

        vm.expectRevert(
            abi.encodeWithSelector(PokePlayEscrow.WagerNotActive.selector, id, PokePlayEscrow.Status.SETTLED)
        );
        escrow.settle(id, alice, sig);
    }

    // =====================================================================
    //                     SIGNATURE / REPLAY ATTACKS
    // =====================================================================

    function test_replay_signatureFromWagerOneFailsOnWagerTwo() public {
        uint256 id1 = _createAndAccept(1 ether);
        uint256 id2 = _createAndAccept(1 ether);

        bytes memory sig1 = _signBattle(id1, alice);
        escrow.settle(id1, alice, sig1);

        // Same participants, same stake, same winner — different id and nonce.
        vm.expectRevert();
        escrow.settle(id2, alice, sig1);

        assertEq(uint8(escrow.statusOf(id2)), uint8(PokePlayEscrow.Status.ACTIVE));
    }

    function test_replay_afterSettleIsBlockedByStatus() public {
        uint256 id = _createAndAccept(1 ether);
        bytes memory sig = _signBattle(id, alice);
        escrow.settle(id, alice, sig);

        uint256 balanceAfterFirst = escrow.balances(alice);
        vm.expectRevert();
        escrow.settle(id, alice, sig);
        assertEq(escrow.balances(alice), balanceAfterFirst, "no double credit");
    }

    function test_replay_nonceMakesSignaturesUniquePerWager() public {
        uint256 id1 = _createAndAccept(1 ether);
        uint256 id2 = _createAndAccept(1 ether);

        PokePlayEscrow.Wager memory w1 = escrow.getWager(id1);
        PokePlayEscrow.Wager memory w2 = escrow.getWager(id2);
        assertTrue(w1.nonce != w2.nonce, "nonces must differ");
        assertTrue(
            escrow.battleResultDigest(id1, alice) != escrow.battleResultDigest(id2, alice), "digests must differ"
        );
    }

    function test_replay_drawSignatureNotReusableAcrossWagers() public {
        uint256 id1 = _createAndAccept(1 ether);
        uint256 id2 = _createAndAccept(1 ether);

        bytes memory drawSig1 = _signDraw(id1);
        escrow.settleDraw(id1, drawSig1);

        vm.expectRevert();
        escrow.settleDraw(id2, drawSig1);
    }

    function test_forgedSignature_fromNonArbiterReverts() public {
        uint256 id = _createAndAccept(1 ether);
        bytes memory forged = _signBattle(id, alice, attackerPk);

        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.InvalidArbiterSignature.selector, id, attacker));
        escrow.settle(id, alice, forged);
    }

    function test_forgedSignature_participantCannotSignForThemselves() public {
        (address mallory, uint256 malloryPk) = makeAddrAndKey("mallory");
        vm.deal(mallory, 10 ether);

        vm.prank(alice);
        uint256 id = escrow.createWager{value: 1 ether}(1 ether, _defaultExpiry());
        vm.prank(mallory);
        escrow.acceptWager{value: 1 ether}(id);

        bytes memory selfSigned = _signBattle(id, mallory, malloryPk);
        vm.prank(mallory);
        vm.expectRevert();
        escrow.settle(id, mallory, selfSigned);
    }

    function test_signature_forDifferentWinnerReverts() public {
        uint256 id = _createAndAccept(1 ether);
        // Arbiter signed "bob wins"; someone tries to claim it for alice.
        bytes memory sigForBob = _signBattle(id, bob);

        vm.expectRevert();
        escrow.settle(id, alice, sigForBob);

        // The original is still good.
        escrow.settle(id, bob, sigForBob);
        assertGt(escrow.balances(bob), 0);
    }

    function test_signature_malleableIsRejected() public {
        uint256 id = _createAndAccept(1 ether);
        bytes memory sig = _signBattle(id, alice);
        bytes memory malleable = _malleate(sig);

        assertTrue(keccak256(sig) != keccak256(malleable), "malleation produced the same bytes");

        vm.expectRevert(); // ECDSAInvalidSignatureS via our InvalidArbiterSignature wrapper
        escrow.settle(id, alice, malleable);

        // The canonical signature still works, so the wager is not bricked.
        escrow.settle(id, alice, sig);
    }

    function test_signature_malformedLengthReverts() public {
        uint256 id = _createAndAccept(1 ether);
        vm.expectRevert();
        escrow.settle(id, alice, hex"deadbeef");
    }

    function test_signature_emptyReverts() public {
        uint256 id = _createAndAccept(1 ether);
        vm.expectRevert();
        escrow.settle(id, alice, "");
    }

    function test_signature_boundToVerifyingContract() public {
        // A second deployment with identical config must not accept the first's
        // signatures — the domain separator includes verifyingContract.
        PokePlayEscrow other = new PokePlayEscrow(owner, arbiter, treasury, DEFAULT_FEE_BPS);

        vm.prank(alice);
        uint256 id = other.createWager{value: 1 ether}(1 ether, _defaultExpiry());
        vm.prank(bob);
        other.acceptWager{value: 1 ether}(id);

        uint256 idHere = _createAndAccept(1 ether);
        assertEq(id, idHere, "ids line up, so only the domain differs");

        bytes memory sigForThis = _signBattle(idHere, alice);
        vm.expectRevert();
        other.settle(id, alice, sigForThis);

        assertTrue(other.domainSeparator() != escrow.domainSeparator(), "domains must differ");
    }

    function test_signature_domainSeparatorTracksChainId() public {
        bytes32 before = escrow.domainSeparator();
        vm.chainId(999999);
        bytes32 afterFork = escrow.domainSeparator();
        assertTrue(before != afterFork, "domain separator must change on a chain fork");
    }

    function test_signature_replayAcrossChainIdReverts() public {
        uint256 id = _createAndAccept(1 ether);
        bytes memory sig = _signBattle(id, alice);

        vm.chainId(999999); // simulate a fork of this chain
        vm.expectRevert();
        escrow.settle(id, alice, sig);
    }

    function test_signature_rotatingArbiterInvalidatesOldSignatures() public {
        uint256 id = _createAndAccept(1 ether);
        bytes memory oldSig = _signBattle(id, alice);

        (address newArbiter,) = makeAddrAndKey("newArbiter");
        vm.prank(owner);
        escrow.setArbiter(newArbiter);

        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.InvalidArbiterSignature.selector, id, arbiter));
        escrow.settle(id, alice, oldSig);
    }

    // =====================================================================
    //                                PAUSE
    // =====================================================================

    function test_pause_blocksCreateAndAccept() public {
        vm.prank(alice);
        uint256 openId = escrow.createWager{value: 1 ether}(1 ether, _defaultExpiry());

        vm.prank(owner);
        escrow.pause();

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.createWager{value: 1 ether}(1 ether, _defaultExpiry());

        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.acceptWager{value: 1 ether}(openId);
    }

    function test_pause_neverBlocksExits() public {
        // Set up one ACTIVE (to settle), one ACTIVE (to time out), one OPEN
        // (to cancel), all before pausing.
        uint256 toSettle = _createAndAccept(1 ether);
        uint256 toTimeout = _createAndAccept(1 ether);
        vm.prank(alice);
        uint256 toCancel = escrow.createWager{value: 1 ether}(1 ether, _defaultExpiry());
        uint256 toDraw = _createAndAccept(1 ether);

        bytes memory settleSig = _signBattle(toSettle, alice);
        bytes memory drawSig = _signDraw(toDraw);

        vm.prank(owner);
        escrow.pause();
        assertTrue(escrow.paused());

        // settle works while paused
        escrow.settle(toSettle, alice, settleSig);
        assertEq(uint8(escrow.statusOf(toSettle)), uint8(PokePlayEscrow.Status.SETTLED));

        // settleDraw works while paused
        escrow.settleDraw(toDraw, drawSig);
        assertEq(uint8(escrow.statusOf(toDraw)), uint8(PokePlayEscrow.Status.REFUNDED));

        // cancelWager works while paused
        vm.prank(alice);
        escrow.cancelWager(toCancel);
        assertEq(uint8(escrow.statusOf(toCancel)), uint8(PokePlayEscrow.Status.CANCELLED));

        // claimTimeout works while paused
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(bob);
        escrow.claimTimeout(toTimeout);
        assertEq(uint8(escrow.statusOf(toTimeout)), uint8(PokePlayEscrow.Status.REFUNDED));

        // withdraw works while paused — everyone gets out.
        vm.prank(alice);
        escrow.withdraw();
        vm.prank(bob);
        escrow.withdraw();
        vm.prank(treasury);
        escrow.withdraw();

        assertEq(address(escrow).balance, 0, "paused contract must not trap funds");
    }

    function test_pause_unpauseRestoresCreate() public {
        vm.prank(owner);
        escrow.pause();
        vm.prank(owner);
        escrow.unpause();

        vm.prank(alice);
        escrow.createWager{value: 1 ether}(1 ether, _defaultExpiry());
    }

    // =====================================================================
    //                            ACCESS CONTROL
    // =====================================================================

    function test_accessControl_ownerOnlyFunctions() public {
        address[2] memory intruders = [alice, attacker];

        for (uint256 i = 0; i < intruders.length; i++) {
            address who = intruders[i];

            vm.prank(who);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who));
            escrow.setArbiter(who);

            vm.prank(who);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who));
            escrow.setTreasury(who);

            vm.prank(who);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who));
            escrow.setFeeBps(0);

            vm.prank(who);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who));
            escrow.setSettleTimeout(2 hours);

            vm.prank(who);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who));
            escrow.pause();

            vm.prank(who);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who));
            escrow.unpause();

            vm.prank(who);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who));
            escrow.transferOwnership(who);
        }
    }

    function test_setters_validation() public {
        vm.startPrank(owner);

        vm.expectRevert(PokePlayEscrow.ZeroAddress.selector);
        escrow.setArbiter(address(0));

        vm.expectRevert(PokePlayEscrow.ZeroAddress.selector);
        escrow.setTreasury(address(0));

        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.FeeTooHigh.selector, 501, 500));
        escrow.setFeeBps(501);

        vm.expectRevert(
            abi.encodeWithSelector(PokePlayEscrow.TimeoutOutOfRange.selector, 7 days + 1, 5 minutes, 7 days)
        );
        escrow.setSettleTimeout(7 days + 1);

        vm.expectRevert(
            abi.encodeWithSelector(PokePlayEscrow.TimeoutOutOfRange.selector, 1 minutes, 5 minutes, 7 days)
        );
        escrow.setSettleTimeout(1 minutes);

        // Valid updates
        escrow.setFeeBps(500);
        escrow.setSettleTimeout(7 days);
        escrow.setArbiter(alice);
        escrow.setTreasury(bob);

        vm.stopPrank();

        assertEq(escrow.feeBps(), 500);
        assertEq(escrow.settleTimeout(), 7 days);
        assertEq(escrow.arbiter(), alice);
        assertEq(escrow.treasury(), bob);
    }

    function testFuzz_setFeeBps_neverExceedsCap(uint16 bps) public {
        vm.prank(owner);
        if (bps > 500) {
            vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.FeeTooHigh.selector, bps, 500));
            escrow.setFeeBps(bps);
            assertEq(escrow.feeBps(), DEFAULT_FEE_BPS);
        } else {
            escrow.setFeeBps(bps);
            assertEq(escrow.feeBps(), bps);
        }
        assertLe(escrow.feeBps(), escrow.MAX_FEE_BPS());
    }

    function test_ownership_isTwoStep() public {
        vm.prank(owner);
        escrow.transferOwnership(carol);

        // Not transferred until accepted — a typo'd address cannot brick ownership.
        assertEq(escrow.owner(), owner);
        assertEq(escrow.pendingOwner(), carol);

        // A third party cannot accept.
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        escrow.acceptOwnership();

        vm.prank(carol);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), carol);

        // Old owner is powerless.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        escrow.pause();
    }

    // =====================================================================
    //                    OWNER CANNOT TOUCH USER STAKES
    // =====================================================================

    function test_ownerCannotDrainStakes_noAdminPathMovesEth() public {
        _createAndAccept(5 ether);
        vm.prank(alice);
        escrow.createWager{value: 3 ether}(3 ether, _defaultExpiry());

        uint256 contractBalance = address(escrow).balance;
        uint256 ownerBefore = owner.balance;
        assertEq(contractBalance, 13 ether);

        // Exercise every owner-only lever available.
        vm.startPrank(owner);
        escrow.setFeeBps(500);
        escrow.setArbiter(owner);
        escrow.setTreasury(owner);
        escrow.setSettleTimeout(7 days);
        escrow.pause();
        escrow.unpause();
        vm.stopPrank();

        assertEq(address(escrow).balance, contractBalance, "owner moved escrowed ETH");
        assertEq(owner.balance, ownerBefore, "owner gained ETH");

        // The owner has no credited balance and therefore cannot withdraw.
        assertEq(escrow.balances(owner), 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.NothingToWithdraw.selector, owner));
        escrow.withdraw();
    }

    function test_ownerCannotDrainStakes_maliciousArbiterStillBoundedToParticipants() public {
        // Worst case: owner points the arbiter at itself and tries to take a pot.
        uint256 id = _createAndAccept(5 ether);

        (address evilArbiter, uint256 evilPk) = makeAddrAndKey("evilArbiter");
        vm.prank(owner);
        escrow.setArbiter(evilArbiter);

        // It cannot name itself as winner — not a participant.
        bytes memory sig = _sign(escrow.battleResultDigest(id, evilArbiter), evilPk);
        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.WinnerNotParticipant.selector, id, evilArbiter));
        escrow.settle(id, evilArbiter, sig);

        // The most it can do is pick which of the two players wins.
        bytes memory sigForBob = _sign(escrow.battleResultDigest(id, bob), evilPk);
        escrow.settle(id, bob, sigForBob);
        assertGt(escrow.balances(bob), 0);
        assertEq(escrow.balances(evilArbiter), 0);
    }

    function test_ownerCannotDrainStakes_feeIsTheOnlyOwnerReachableEth() public {
        uint256 id = _createAndAccept(10 ether);
        escrow.settle(id, alice, _signBattle(id, alice));

        uint256 fee = (20 ether * uint256(DEFAULT_FEE_BPS)) / 10_000;
        assertEq(escrow.balances(treasury), fee);

        vm.prank(treasury);
        uint256 got = escrow.withdraw();
        assertEq(got, fee, "treasury can only ever take the accrued fee");
        assertEq(escrow.balances(treasury), 0);
    }

    function test_solvency_holdsAcrossAMixedWorkload() public {
        uint256 a = _createAndAccept(1 ether);
        uint256 b = _createAndAccept(2 ether);
        uint256 c = _createAndAccept(3 ether);
        vm.prank(alice);
        uint256 d = escrow.createWager{value: 4 ether}(4 ether, _defaultExpiry());
        _assertSolvent();

        escrow.settle(a, alice, _signBattle(a, alice));
        _assertSolvent();

        escrow.settleDraw(b, _signDraw(b));
        _assertSolvent();

        vm.warp(block.timestamp + 2 hours);
        vm.prank(bob);
        escrow.claimTimeout(c);
        _assertSolvent();

        vm.prank(alice);
        escrow.cancelWager(d);
        _assertSolvent();

        vm.prank(alice);
        escrow.withdraw();
        vm.prank(bob);
        escrow.withdraw();
        vm.prank(treasury);
        escrow.withdraw();

        assertEq(escrow.totalEscrowed(), 0);
        assertEq(escrow.totalCredited(), 0);
        assertEq(address(escrow).balance, 0, "every wei accounted for");
    }

    // =====================================================================
    //                              MISC
    // =====================================================================

    function test_receive_rejectsDirectPayments() public {
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(escrow).call{value: 1 ether}("");
        assertFalse(ok, "direct ETH must be rejected");
        assertEq(bytes4(ret), PokePlayEscrow.DirectPaymentRejected.selector);
    }

    function test_withdraw_zeroBalanceReverts() public {
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(PokePlayEscrow.NothingToWithdraw.selector, carol));
        escrow.withdraw();
    }

    function test_withdraw_accumulatesAcrossWagers() public {
        vm.prank(owner);
        escrow.setFeeBps(0);

        uint256 id1 = _createAndAccept(1 ether);
        uint256 id2 = _createAndAccept(2 ether);
        escrow.settle(id1, alice, _signBattle(id1, alice));
        escrow.settle(id2, alice, _signBattle(id2, alice));

        assertEq(escrow.balances(alice), 6 ether);
        vm.prank(alice);
        assertEq(escrow.withdraw(), 6 ether);
    }

    function test_view_timeoutAtIsZeroForNonActive() public {
        vm.prank(alice);
        uint256 id = escrow.createWager{value: 1 ether}(1 ether, _defaultExpiry());
        assertEq(escrow.timeoutAt(id), 0);

        vm.prank(bob);
        escrow.acceptWager{value: 1 ether}(id);
        assertEq(escrow.timeoutAt(id), uint64(block.timestamp) + 1 hours);
    }

    function test_typehashes_matchTheDocumentedStrings() public view {
        assertEq(
            escrow.BATTLE_RESULT_TYPEHASH(), keccak256("BattleResult(uint256 wagerId,address winner,uint256 nonce)")
        );
        assertEq(escrow.DRAW_RESULT_TYPEHASH(), keccak256("DrawResult(uint256 wagerId,uint256 nonce)"));
    }

    function testFuzz_fullLifecycle(uint96 stakeRaw, uint16 bpsRaw, bool aliceWins) public {
        uint256 stake = bound(uint256(stakeRaw), 0, 500 ether);
        uint16 bps = uint16(bound(uint256(bpsRaw), 0, 500));

        vm.prank(owner);
        escrow.setFeeBps(bps);

        vm.deal(alice, stake);
        vm.deal(bob, stake);

        vm.prank(alice);
        uint256 id = escrow.createWager{value: stake}(stake, _defaultExpiry());
        vm.prank(bob);
        escrow.acceptWager{value: stake}(id);
        _assertSolvent();

        address winner = aliceWins ? alice : bob;
        escrow.settle(id, winner, _signBattle(id, winner));
        _assertSolvent();

        uint256 pot = stake * 2;
        uint256 fee = (pot * bps) / 10_000;
        assertEq(escrow.balances(winner), pot - fee);
        assertEq(escrow.balances(treasury), fee);

        if (pot - fee > 0) {
            vm.prank(winner);
            escrow.withdraw();
        }
        if (fee > 0) {
            vm.prank(treasury);
            escrow.withdraw();
        }
        assertEq(address(escrow).balance, 0);
    }
}
