// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {PokePlayEscrow} from "../src/PokePlayEscrow.sol";
import {RevertingReceiver, ReentrantWithdrawer, ReentrantSettler} from "./mocks/Malicious.sol";

contract ReentrancyTest is BaseTest {
    // =====================================================================
    //          A REVERTING PARTICIPANT CANNOT GRIEF THE COUNTERPARTY
    // =====================================================================

    /// @dev This is the whole reason for pull payments. A contract player that
    ///      refuses ETH must not be able to hold the honest player's winnings
    ///      hostage by making settlement revert.
    function test_revertingParticipant_cannotBlockSettlement() public {
        RevertingReceiver griefer = new RevertingReceiver(escrow);
        vm.deal(address(griefer), 10 ether);

        // The griefer creates, the honest player accepts.
        griefer.create{value: 1 ether}(1 ether, _defaultExpiry());
        uint256 id = escrow.wagerCount();
        vm.prank(alice);
        escrow.acceptWager{value: 1 ether}(id);

        // Alice wins. Settlement must succeed even though the loser rejects ETH.
        escrow.settle(id, alice, _signBattle(id, alice));
        assertEq(uint8(escrow.statusOf(id)), uint8(PokePlayEscrow.Status.SETTLED));

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        escrow.withdraw();
        assertGt(alice.balance, aliceBefore, "honest winner must be paid");
    }

    /// @dev And when the griefer WINS, only its own withdrawal breaks. The
    ///      settlement itself still succeeds, so the fee and the loser's side of
    ///      the accounting are finalised.
    function test_revertingParticipant_onlyBreaksItsOwnWithdrawal() public {
        RevertingReceiver griefer = new RevertingReceiver(escrow);
        vm.deal(address(griefer), 10 ether);

        griefer.create{value: 1 ether}(1 ether, _defaultExpiry());
        uint256 id = escrow.wagerCount();
        vm.prank(alice);
        escrow.acceptWager{value: 1 ether}(id);

        escrow.settle(id, address(griefer), _signBattle(id, address(griefer)));
        assertGt(escrow.balances(address(griefer)), 0);

        // Its own withdrawal fails, by its own doing.
        vm.expectRevert();
        griefer.withdraw();

        // Funds are not lost: the balance is still credited and becomes claimable
        // the moment it stops rejecting ETH.
        griefer.setAcceptEth(true);
        uint256 amount = escrow.balances(address(griefer));
        uint256 balanceBefore = address(griefer).balance;
        griefer.withdraw();
        assertEq(address(griefer).balance, balanceBefore + amount);
        assertEq(escrow.balances(address(griefer)), 0);

        // The treasury is unaffected throughout.
        vm.prank(treasury);
        escrow.withdraw();
        assertGt(treasury.balance, 0);
    }

    function test_revertingParticipant_cannotBlockDrawOrTimeout() public {
        RevertingReceiver griefer = new RevertingReceiver(escrow);
        vm.deal(address(griefer), 10 ether);

        // Draw
        griefer.create{value: 1 ether}(1 ether, _defaultExpiry());
        uint256 id1 = escrow.wagerCount();
        vm.prank(alice);
        escrow.acceptWager{value: 1 ether}(id1);
        escrow.settleDraw(id1, _signDraw(id1));
        assertEq(uint8(escrow.statusOf(id1)), uint8(PokePlayEscrow.Status.REFUNDED));

        // Timeout
        griefer.create{value: 1 ether}(1 ether, _defaultExpiry());
        uint256 id2 = escrow.wagerCount();
        vm.prank(alice);
        escrow.acceptWager{value: 1 ether}(id2);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(alice);
        escrow.claimTimeout(id2);
        assertEq(uint8(escrow.statusOf(id2)), uint8(PokePlayEscrow.Status.REFUNDED));

        // Alice gets her money regardless.
        vm.prank(alice);
        escrow.withdraw();
        assertEq(escrow.balances(alice), 0);
    }

    // =====================================================================
    //                        REENTRANCY ON withdraw()
    // =====================================================================

    function test_reentrantWithdraw_cannotDoubleSpend() public {
        ReentrantWithdrawer attackerC = new ReentrantWithdrawer(escrow);
        vm.deal(address(attackerC), 10 ether);

        attackerC.create{value: 1 ether}(1 ether, _defaultExpiry());
        uint256 id = escrow.wagerCount();
        vm.prank(alice);
        escrow.acceptWager{value: 1 ether}(id);

        escrow.settle(id, address(attackerC), _signBattle(id, address(attackerC)));

        uint256 credited = escrow.balances(address(attackerC));
        uint256 contractBalanceBefore = address(escrow).balance;
        uint256 attackerBalanceBefore = address(attackerC).balance;

        attackerC.withdraw();

        assertEq(attackerC.reentryAttempts(), 1, "reentry was not exercised");
        assertTrue(attackerC.reentryReverted(), "reentrant withdraw must revert");

        // Exactly the credited amount left the contract — not a wei more.
        assertEq(address(attackerC).balance, attackerBalanceBefore + credited);
        assertEq(address(escrow).balance, contractBalanceBefore - credited);
        assertEq(escrow.balances(address(attackerC)), 0);
        _assertSolvent();
    }

    /// @dev Even with a large pool of other users' funds sitting in the contract,
    ///      the attacker cannot take more than its own credited balance.
    function test_reentrantWithdraw_cannotTouchOtherUsersFunds() public {
        // Other users park real money in the contract.
        uint256 other1 = _createAndAccept(20 ether);
        escrow.settleDraw(other1, _signDraw(other1));
        vm.prank(carol);
        escrow.createWager{value: 30 ether}(30 ether, _defaultExpiry());

        ReentrantWithdrawer attackerC = new ReentrantWithdrawer(escrow);
        vm.deal(address(attackerC), 5 ether);
        attackerC.create{value: 1 ether}(1 ether, _defaultExpiry());
        uint256 id = escrow.wagerCount();
        vm.prank(alice);
        escrow.acceptWager{value: 1 ether}(id);
        escrow.settle(id, address(attackerC), _signBattle(id, address(attackerC)));

        uint256 credited = escrow.balances(address(attackerC));
        uint256 poolBefore = address(escrow).balance;

        attackerC.withdraw();

        assertTrue(attackerC.reentryReverted());
        assertEq(address(escrow).balance, poolBefore - credited, "attacker drained extra funds");

        // Everyone else is still whole.
        assertEq(escrow.balances(alice), 20 ether);
        assertEq(escrow.balances(bob), 20 ether);
        _assertSolvent();
    }

    // =====================================================================
    //                        REENTRANCY ON settle()
    // =====================================================================

    /// @dev The attacker holds a valid signature and tries to re-enter settle()
    ///      during its own withdrawal, hoping to get paid twice. The status enum
    ///      (and the guard) make this impossible.
    function test_reentrantSettle_cannotSettleTwice() public {
        ReentrantSettler attackerC = new ReentrantSettler(escrow);
        vm.deal(address(attackerC), 10 ether);

        attackerC.create{value: 1 ether}(1 ether, _defaultExpiry());
        uint256 id = escrow.wagerCount();
        vm.prank(alice);
        escrow.acceptWager{value: 1 ether}(id);

        bytes memory sig = _signBattle(id, address(attackerC));
        attackerC.arm(id, address(attackerC), sig);

        escrow.settle(id, address(attackerC), sig);

        uint256 credited = escrow.balances(address(attackerC));
        uint256 contractBefore = address(escrow).balance;

        attackerC.withdraw(); // triggers receive() -> settle() reentry

        assertEq(attackerC.reentryAttempts(), 1, "reentry was not exercised");
        assertTrue(attackerC.reentryReverted(), "reentrant settle must revert");
        assertEq(address(escrow).balance, contractBefore - credited);
        assertEq(escrow.balances(address(attackerC)), 0, "no second credit");
        _assertSolvent();
    }

    /// @dev A second, still-ACTIVE wager must not be settleable by reentering with
    ///      a signature meant for a different wager, even mid-withdrawal.
    function test_reentrantSettle_cannotCrossSettleAnotherWager() public {
        ReentrantSettler attackerC = new ReentrantSettler(escrow);
        vm.deal(address(attackerC), 10 ether);

        // Wager 1: attacker wins, will withdraw.
        attackerC.create{value: 1 ether}(1 ether, _defaultExpiry());
        uint256 id1 = escrow.wagerCount();
        vm.prank(alice);
        escrow.acceptWager{value: 1 ether}(id1);
        bytes memory sig1 = _signBattle(id1, address(attackerC));
        escrow.settle(id1, address(attackerC), sig1);

        // Wager 2: still ACTIVE, attacker is a participant.
        attackerC.create{value: 1 ether}(1 ether, _defaultExpiry());
        uint256 id2 = escrow.wagerCount();
        vm.prank(bob);
        escrow.acceptWager{value: 1 ether}(id2);

        // Re-enter targeting wager 2 with wager 1's signature.
        attackerC.arm(id2, address(attackerC), sig1);
        attackerC.withdraw();

        assertTrue(attackerC.reentryReverted(), "cross-wager reentry must revert");
        assertEq(uint8(escrow.statusOf(id2)), uint8(PokePlayEscrow.Status.ACTIVE), "wager 2 must be untouched");
        _assertSolvent();
    }
}
