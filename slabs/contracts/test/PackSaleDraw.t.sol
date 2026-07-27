// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaseTest} from "./Base.t.sol";
import {PackSale} from "../src/PackSale.sol";

/// @notice `drawForOpen`: paying for a pack out of the buyer's own money rather than the
///         operator's working capital.
///
///         The operator does not hold a float, and a bridge sends from an EOA rather than
///         from this contract, so the payment has to leave escrow before the pack is bought.
///         These tests pin what the buyer keeps either side of that line.
contract PackSaleDrawTest is BaseTest {
    address internal worker = makeAddr("workerEoa");

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        sale.setDrawer(worker);
    }

    // ------------------------------------------------------------ the draw itself

    function test_draw_sendsPaymentToTheDrawer() public {
        uint256 orderId = _buy(alice);
        assertEq(usdg.balanceOf(worker), 0);

        vm.prank(worker);
        sale.drawForOpen(orderId);

        assertEq(usdg.balanceOf(worker), PRICE, "the worker can now fund the pack");
        assertEq(usdg.balanceOf(address(sale)), 0, "and the contract holds nothing for it");
        assertEq(sale.escrowedUsdg(), 0, "escrow accounting follows the money");
        assertTrue(sale.getOrder(orderId).drawn);
    }

    function test_draw_isOneShot() public {
        uint256 orderId = _buy(alice);
        vm.startPrank(worker);
        sale.drawForOpen(orderId);
        vm.expectRevert(abi.encodeWithSelector(PackSale.AlreadyDrawn.selector, orderId));
        sale.drawForOpen(orderId);
        vm.stopPrank();
        assertEq(usdg.balanceOf(worker), PRICE, "drained exactly once");
    }

    function test_draw_byAnyoneElse_reverts() public {
        uint256 orderId = _buy(alice);
        for (uint256 i = 0; i < 3; i++) {
            address who = [stranger, alice, owner][i];
            vm.prank(who);
            vm.expectRevert(PackSale.NotDrawer.selector);
            sale.drawForOpen(orderId);
        }
    }

    function test_draw_operatorIsNotTheDrawer() public {
        // The operator is the Fulfiller CONTRACT. If it could draw, every payment would be
        // stranded in a contract that cannot bridge.
        uint256 orderId = _buy(alice);
        vm.prank(address(fulfiller));
        vm.expectRevert(PackSale.NotDrawer.selector);
        sale.drawForOpen(orderId);
    }

    function test_draw_afterRefund_reverts() public {
        uint256 orderId = _buy(alice);
        vm.warp(block.timestamp + 11 minutes);
        sale.refund(orderId);

        vm.prank(worker);
        vm.expectRevert();
        sale.drawForOpen(orderId);
    }

    // ------------------------------------------------ what the buyer keeps, either side

    function test_refund_beforeDraw_stillWorksAndIsPermissionless() public {
        uint256 orderId = _buy(alice);
        uint256 before = usdg.balanceOf(alice);
        vm.warp(block.timestamp + 11 minutes);

        // A stranger calls it: the buyer must never depend on us.
        vm.prank(stranger);
        sale.refund(orderId);

        assertEq(usdg.balanceOf(alice), before + PRICE, "fully refunded by the contract");
    }

    function test_refund_afterDraw_reverts() public {
        uint256 orderId = _buy(alice);
        vm.prank(worker);
        sale.drawForOpen(orderId);
        vm.warp(block.timestamp + 11 minutes);

        // Honest failure. The money is with the operator; paying from here would rob another
        // order's escrow. The operator refunds directly instead.
        vm.expectRevert(abi.encodeWithSelector(PackSale.AlreadyDrawn.selector, orderId));
        sale.refund(orderId);
    }

    /// A drawn order must still be CLOSABLE, or its open-order slot leaks forever and five
    /// of them halt the storefront. forceRefund settles the status without transferring,
    /// because the contract holds nothing for it — the operator owes the buyer directly.
    function test_forceRefund_afterDraw_closesWithoutPaying() public {
        uint256 orderId = _buy(alice);
        vm.prank(worker);
        sale.drawForOpen(orderId);
        vm.warp(block.timestamp + 3 hours);
        uint256 aliceBefore = usdg.balanceOf(alice);
        uint256 saleBefore = usdg.balanceOf(address(sale));

        vm.prank(owner);
        sale.forceRefund(orderId, "mint unrecoverable");

        assertEq(uint8(sale.getOrder(orderId).status), uint8(PackSale.OrderStatus.REFUNDED));
        assertEq(sale.openOrderCount(), 0, "the slot MUST be released");
        assertEq(usdg.balanceOf(alice), aliceBefore, "nothing paid from here; operator owes directly");
        assertEq(usdg.balanceOf(address(sale)), saleBefore, "no other escrow touched");
    }

    // ------------------------------------------------ the slot leak on the common path

    function test_closeDrawnOrder_freesTheSlot() public {
        uint256 orderId = _buy(alice);
        vm.startPrank(worker);
        sale.drawForOpen(orderId);
        assertEq(sale.openOrderCount(), 1);
        sale.closeDrawnOrder(orderId, "bridge failed after draw; refunded directly");
        vm.stopPrank();

        assertEq(sale.openOrderCount(), 0, "self-healing without waiting 2h for the owner");
        assertEq(uint8(sale.getOrder(orderId).status), uint8(PackSale.OrderStatus.REFUNDED));
    }

    function test_closeDrawnOrder_refusesAnUndrawnOrder() public {
        // Money is still in escrow: refund() is the correct route and pays the buyer.
        uint256 orderId = _buy(alice);
        vm.prank(worker);
        vm.expectRevert(abi.encodeWithSelector(PackSale.NotDrawn.selector, orderId));
        sale.closeDrawnOrder(orderId, "nope");
    }

    function test_closeDrawnOrder_byAnyoneElse_reverts() public {
        uint256 orderId = _buy(alice);
        vm.prank(worker);
        sale.drawForOpen(orderId);
        vm.prank(stranger);
        vm.expectRevert(PackSale.NotDrawer.selector);
        sale.closeDrawnOrder(orderId, "mine now");
    }

    function test_closeDrawnOrder_cannotTouchAnotherBuyersEscrow() public {
        uint256 aliceOrder = _buy(alice);
        _buy(bob);
        vm.startPrank(worker);
        sale.drawForOpen(aliceOrder);
        sale.closeDrawnOrder(aliceOrder, "failed");
        vm.stopPrank();

        assertEq(usdg.balanceOf(address(sale)), PRICE, "Bob's money is untouched");
        assertEq(sale.escrowedUsdg(), PRICE);
    }

    function test_draw_afterDeadline_reverts() public {
        // F1: without this, a drawer could sit on an expired order or front-run the buyer's
        // own refund, converting a refundable order into one with no on-chain remedy.
        uint256 orderId = _buy(alice);
        vm.warp(block.timestamp + 11 minutes);
        vm.prank(worker);
        vm.expectRevert();
        sale.drawForOpen(orderId);
    }

    // ------------------------------------------------------------ paying twice

    function test_fulfill_afterDraw_doesNotPayTreasuryAgain() public {
        uint256 orderId = _buy(alice);
        vm.prank(worker);
        sale.drawForOpen(orderId);

        uint256 treasuryBefore = usdg.balanceOf(treasury);
        _fulfill(orderId, alice);

        assertEq(usdg.balanceOf(treasury), treasuryBefore, "already paid out via the draw");
        assertEq(sale.escrowedUsdg(), 0);
        assertEq(sale.openOrderCount(), 0, "the slot is still released");
    }

    function test_fulfill_withoutDraw_stillPaysTreasury() public {
        uint256 orderId = _buy(alice);
        _fulfill(orderId, alice);
        assertEq(usdg.balanceOf(treasury), PRICE, "undrawn orders behave exactly as before");
    }

    /// THE ACCOUNTING ATTACK. A drawn order must never be able to pay itself out of another
    /// buyer's escrow. Alice draws and fulfils; Bob's money must be untouched and refundable.
    function test_drawnOrder_cannotConsumeAnotherBuyersEscrow() public {
        uint256 aliceOrder = _buy(alice);
        uint256 bobOrder = _buy(bob);
        assertEq(sale.escrowedUsdg(), PRICE * 2);

        vm.prank(worker);
        sale.drawForOpen(aliceOrder);
        assertEq(sale.escrowedUsdg(), PRICE, "only Alice's escrow left");
        assertEq(usdg.balanceOf(address(sale)), PRICE, "and only Bob's money is held");

        _fulfill(aliceOrder, alice);

        // Bob is entirely unaffected and can still be refunded in full.
        assertEq(usdg.balanceOf(address(sale)), PRICE, "Bob's money is still here");
        uint256 bobBefore = usdg.balanceOf(bob);
        vm.warp(block.timestamp + 11 minutes);
        sale.refund(bobOrder);
        assertEq(usdg.balanceOf(bob), bobBefore + PRICE, "Bob refunded in full");
        assertEq(sale.escrowedUsdg(), 0);
    }

    function test_escrowedUsdg_neverExceedsRealBalance() public {
        _buy(alice);
        uint256 bobOrder = _buy(bob);
        vm.prank(worker);
        sale.drawForOpen(bobOrder);
        // The invariant sweepSurplus depends on: accounting must never claim more than we hold.
        assertLe(sale.escrowedUsdg(), usdg.balanceOf(address(sale)));
    }
}
