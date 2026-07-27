// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaseTest} from "./Base.t.sol";
import {PackSale} from "../src/PackSale.sol";
import {MirrorNFT} from "../src/MirrorNFT.sol";
import {Fulfiller} from "../src/Fulfiller.sol";
import {MockUSDG, FeeOnTransferUSDG} from "./mocks/MockUSDG.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Vm} from "forge-std/Vm.sol";

/// @notice Doc 03 §4 items 1–4, 6. The exclusion matrix (§4.2b) is the heart of it: an
///         order must reach at most one terminal state, by any path, in any order.
contract PackSaleTest is BaseTest {
    // ------------------------------------------------------------ §4.1 happy paths

    function test_buy_escrowsAndEmits() public {
        uint256 balanceBefore = usdg.balanceOf(alice);

        uint256 orderId = _buy(alice);

        assertEq(orderId, 1);
        assertEq(usdg.balanceOf(alice), balanceBefore - PRICE);
        assertEq(usdg.balanceOf(address(sale)), PRICE);
        assertEq(sale.escrowedUsdg(), PRICE);
        assertEq(sale.openOrderCount(), 1);

        PackSale.Order memory o = sale.getOrder(orderId);
        assertEq(o.buyer, alice);
        assertEq(o.price, PRICE);
        assertEq(uint8(o.status), uint8(PackSale.OrderStatus.PENDING));
    }

    function test_buyThenFulfill_releasesToTreasury() public {
        uint256 orderId = _buy(alice);
        uint256 tokenId = _fulfill(orderId, alice);

        assertEq(usdg.balanceOf(treasury), PRICE);
        assertEq(usdg.balanceOf(address(sale)), 0);
        assertEq(sale.escrowedUsdg(), 0);
        assertEq(sale.openOrderCount(), 0);
        assertEq(mirror.ownerOf(tokenId), alice);
        assertEq(uint8(sale.getOrder(orderId).status), uint8(PackSale.OrderStatus.FULFILLED));
    }

    function test_refund_afterTimeout_byBuyer() public {
        uint256 orderId = _buy(alice);
        uint256 balanceAfterBuy = usdg.balanceOf(alice);

        vm.warp(block.timestamp + 11 minutes);
        vm.prank(alice);
        sale.refund(orderId);

        assertEq(usdg.balanceOf(alice), balanceAfterBuy + PRICE);
        assertEq(sale.escrowedUsdg(), 0);
    }

    /// A user must never depend on us to get their money back.
    function test_refund_afterTimeout_byStranger() public {
        uint256 orderId = _buy(alice);
        uint256 balanceAfterBuy = usdg.balanceOf(alice);

        vm.warp(block.timestamp + 11 minutes);
        vm.prank(stranger);
        sale.refund(orderId);

        assertEq(usdg.balanceOf(alice), balanceAfterBuy + PRICE);
        assertEq(usdg.balanceOf(stranger), 0);
    }

    function test_refund_beforeDeadline_reverts() public {
        uint256 orderId = _buy(alice);
        vm.expectRevert();
        sale.refund(orderId);
    }

    // ------------------------------------------------------------ §4.2 refund/fulfill race

    /// Slow-but-successful fulfilment must still complete. Lateness alone is not failure.
    function test_fulfillAfterDeadline_butBeforeRefund_succeeds() public {
        uint256 orderId = _buy(alice);
        vm.warp(block.timestamp + 30 minutes);

        uint256 tokenId = _fulfill(orderId, alice);

        assertEq(mirror.ownerOf(tokenId), alice);
        assertEq(usdg.balanceOf(treasury), PRICE);
    }

    function test_refundThenFulfill_reverts() public {
        uint256 orderId = _buy(alice);
        vm.warp(block.timestamp + 11 minutes);
        sale.refund(orderId);

        vm.prank(workerKey);
        vm.expectRevert(
            abi.encodeWithSelector(PackSale.OrderNotPending.selector, orderId, PackSale.OrderStatus.REFUNDED)
        );
        fulfiller.fulfill(orderId, alice, _meta(), "ipfs://card", keccak256("sig"));
    }

    function test_fulfillThenRefund_reverts() public {
        uint256 orderId = _buy(alice);
        _fulfill(orderId, alice);

        vm.warp(block.timestamp + 11 minutes);
        vm.expectRevert(
            abi.encodeWithSelector(PackSale.OrderNotPending.selector, orderId, PackSale.OrderStatus.FULFILLED)
        );
        sale.refund(orderId);
    }

    function test_doubleRefund_reverts() public {
        uint256 orderId = _buy(alice);
        vm.warp(block.timestamp + 11 minutes);
        sale.refund(orderId);

        vm.expectRevert();
        sale.refund(orderId);
    }

    // ------------------------------------------------- §4.2b forceRefund exclusion matrix

    function test_forceRefund_happyPath() public {
        uint256 orderId = _buy(alice);
        uint256 balanceAfterBuy = usdg.balanceOf(alice);

        vm.warp(block.timestamp + 2 hours);
        vm.prank(owner);
        sale.forceRefund(orderId, "mint reverted 8x: RH RPC rejecting txs, order stranded");

        assertEq(usdg.balanceOf(alice), balanceAfterBuy + PRICE);
        assertEq(sale.escrowedUsdg(), 0);
        assertEq(sale.openOrderCount(), 0);
        assertEq(uint8(sale.getOrder(orderId).status), uint8(PackSale.OrderStatus.REFUNDED));
    }

    function test_forceRefund_paysBuyerNotCaller() public {
        uint256 orderId = _buy(alice);
        uint256 aliceAfterBuy = usdg.balanceOf(alice);
        uint256 ownerBefore = usdg.balanceOf(owner);

        vm.warp(block.timestamp + 2 hours);
        vm.prank(owner);
        sale.forceRefund(orderId, "stranded");

        assertEq(usdg.balanceOf(alice), aliceAfterBuy + PRICE, "buyer made whole");
        assertEq(usdg.balanceOf(owner), ownerBefore, "owner receives nothing");
    }

    function test_forceRefundThenMarkFulfilled_reverts() public {
        uint256 orderId = _buy(alice);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(owner);
        sale.forceRefund(orderId, "stranded");

        vm.prank(workerKey);
        vm.expectRevert(
            abi.encodeWithSelector(PackSale.OrderNotPending.selector, orderId, PackSale.OrderStatus.REFUNDED)
        );
        fulfiller.fulfill(orderId, alice, _meta(), "ipfs://card", keccak256("sig"));
    }

    function test_markFulfilledThenForceRefund_reverts() public {
        uint256 orderId = _buy(alice);
        _fulfill(orderId, alice);

        vm.warp(block.timestamp + 2 hours);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(PackSale.OrderNotPending.selector, orderId, PackSale.OrderStatus.FULFILLED)
        );
        sale.forceRefund(orderId, "should not be possible");
    }

    function test_refundThenForceRefund_reverts() public {
        uint256 orderId = _buy(alice);
        vm.warp(block.timestamp + 2 hours);
        sale.refund(orderId);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(PackSale.OrderNotPending.selector, orderId, PackSale.OrderStatus.REFUNDED)
        );
        sale.forceRefund(orderId, "already refunded");
    }

    function test_forceRefundThenRefund_reverts() public {
        uint256 orderId = _buy(alice);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(owner);
        sale.forceRefund(orderId, "stranded");

        vm.expectRevert(
            abi.encodeWithSelector(PackSale.OrderNotPending.selector, orderId, PackSale.OrderStatus.REFUNDED)
        );
        sale.refund(orderId);
    }

    function test_doubleForceRefund_reverts() public {
        uint256 orderId = _buy(alice);
        vm.warp(block.timestamp + 2 hours);

        vm.startPrank(owner);
        sale.forceRefund(orderId, "stranded");
        vm.expectRevert(
            abi.encodeWithSelector(PackSale.OrderNotPending.selector, orderId, PackSale.OrderStatus.REFUNDED)
        );
        sale.forceRefund(orderId, "again");
        vm.stopPrank();
    }

    // ---------------------------------------------- §4.2b forceRefund preconditions

    function test_forceRefund_byStranger_reverts() public {
        uint256 orderId = _buy(alice);
        vm.warp(block.timestamp + 2 hours);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        sale.forceRefund(orderId, "nope");
    }

    /// The key separation that makes this human-only: the worker cannot reach the hatch.
    function test_forceRefund_byOperatorKey_reverts() public {
        uint256 orderId = _buy(alice);
        vm.warp(block.timestamp + 2 hours);

        vm.prank(workerKey);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, workerKey));
        sale.forceRefund(orderId, "worker must not be able to do this");
    }

    function test_forceRefund_oneSecondEarly_reverts() public {
        uint256 orderId = _buy(alice);
        uint64 createdAt = sale.getOrder(orderId).createdAt;

        vm.warp(createdAt + 2 hours - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PackSale.OrderTooYoung.selector, orderId, createdAt + 2 hours));
        sale.forceRefund(orderId, "too early");
    }

    function test_forceRefund_exactlyAtTwoHours_succeeds() public {
        uint256 orderId = _buy(alice);
        uint64 createdAt = sale.getOrder(orderId).createdAt;

        vm.warp(createdAt + 2 hours);
        vm.prank(owner);
        sale.forceRefund(orderId, "eligible on the boundary");

        assertEq(uint8(sale.getOrder(orderId).status), uint8(PackSale.OrderStatus.REFUNDED));
    }

    function test_forceRefund_emptyReason_reverts() public {
        uint256 orderId = _buy(alice);
        vm.warp(block.timestamp + 2 hours);

        vm.prank(owner);
        vm.expectRevert(PackSale.EmptyReason.selector);
        sale.forceRefund(orderId, "");
    }

    /// The case markFulfilled bookkeeping alone would miss: the mint landed, but the worker
    /// died before marking it. The user holds a real card — refunding would pay them twice.
    function test_forceRefund_whenMintLandedButNotMarked_reverts() public {
        uint256 orderId = _buy(alice);

        // Simulate the divergence: mint directly, bypassing Fulfiller's atomic path.
        vm.prank(owner);
        mirror.setOperator(address(this));
        uint256 tokenId = mirror.mint(alice, orderId, _meta(), "ipfs://card");

        assertEq(uint8(sale.getOrder(orderId).status), uint8(PackSale.OrderStatus.PENDING));
        assertEq(mirror.ownerOf(tokenId), alice);

        vm.warp(block.timestamp + 2 hours);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PackSale.MirrorAlreadyMinted.selector, orderId, tokenId));
        sale.forceRefund(orderId, "worker lost track");
    }

    /// And it must still refuse after the user has burned that card — burning does not
    /// clear `mintedForOrder`, so the order stays permanently ineligible.
    function test_forceRefund_afterMintAndBurn_stillReverts() public {
        uint256 orderId = _buy(alice);

        vm.prank(owner);
        mirror.setOperator(address(this));
        uint256 tokenId = mirror.mint(alice, orderId, _meta(), "ipfs://card");
        _surrender(tokenId, alice);
        mirror.burnForSell(tokenId);

        vm.warp(block.timestamp + 2 hours);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PackSale.MirrorAlreadyMinted.selector, orderId, tokenId));
        sale.forceRefund(orderId, "card is gone but the order was still served");
    }

    function test_forceRefund_unknownOrder_reverts() public {
        vm.warp(block.timestamp + 2 hours);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PackSale.OrderNotPending.selector, 999, PackSale.OrderStatus.NONE));
        sale.forceRefund(999, "does not exist");
    }

    // ------------------------------------------------------------ §4.3 caps

    function test_dailyCap_blocksEleventhPack() public {
        vm.prank(owner);
        sale.setCaps(10, MAX_PRICE, 100); // lift open-order cap to isolate the daily one

        for (uint256 i = 0; i < 10; i++) {
            uint256 id = _buy(alice);
            _fulfill(id, alice);
        }

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PackSale.DailyCapReached.selector, 10));
        sale.buy(MACHINE);
    }

    function test_dailyCap_resetsNextUtcDay() public {
        vm.prank(owner);
        sale.setCaps(1, MAX_PRICE, 100);

        uint256 id = _buy(alice);
        _fulfill(id, alice);

        vm.prank(alice);
        vm.expectRevert();
        sale.buy(MACHINE);

        vm.warp(block.timestamp + 1 days);
        uint256 id2 = _buy(alice);
        assertGt(id2, 0);
    }

    /// The GLOBAL cap, which now takes five DISTINCT buyers to reach.
    ///
    /// It used to be reached by alice alone, and that was the griefing: one address could shut
    /// the storefront for everyone at zero principal cost, since every order refunds in full.
    /// Needing five separate funded wallets is the fix, expressed as a test.
    function test_openOrderCap_blocksFlooding() public {
        vm.prank(owner);
        sale.setCaps(100, MAX_PRICE, 5);

        for (uint256 i = 0; i < 5; i++) {
            _buy(_funded(string.concat("flooder", vm.toString(i))));
        }

        address next = _funded("flooder-last");
        vm.prank(next);
        vm.expectRevert(abi.encodeWithSelector(PackSale.TooManyOpenOrders.selector, 5));
        sale.buy(MACHINE);
    }

    /// The per-buyer cap: one address cannot consume the global allowance.
    function test_perBuyerCap_stopsOneAddressTakingEverySlot() public {
        vm.prank(owner);
        sale.setCaps(100, MAX_PRICE, 5);

        _buy(alice);
        _buy(alice);

        // Alice is done at 2 even though three global slots remain.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PackSale.TooManyOpenOrdersForBuyer.selector, 2));
        sale.buy(MACHINE);

        // And the store is still open to everybody else, which is the whole point.
        _buy(bob);
        assertEq(sale.openOrderCount(), 3, "other buyers are unaffected");
    }

    function test_perBuyerCap_freesUpWhenAnOrderCloses() public {
        uint256 first = _buy(alice);
        _buy(alice);

        vm.prank(alice);
        vm.expectRevert();
        sale.buy(MACHINE);

        // Time out and refund the first, and alice's slot must come back.
        vm.warp(block.timestamp + 11 minutes);
        sale.refund(first);
        assertEq(sale.openOrdersOf(alice), 1, "the refund released her slot");

        _buy(alice);
        assertEq(sale.openOrdersOf(alice), 2, "she can buy again");
    }

    function test_perBuyerCap_canBeDisabled() public {
        vm.prank(owner);
        sale.setMaxOpenOrdersPerBuyer(0);

        for (uint256 i = 0; i < 5; i++) {
            _buy(alice);
        }
        assertEq(sale.openOrdersOf(alice), 5, "0 disables the per-buyer cap entirely");
    }

    function test_openOrderCap_freesUpAfterFulfilment() public {
        vm.prank(owner);
        sale.setCaps(100, MAX_PRICE, 2);

        uint256 a = _buy(alice);
        _buy(alice);

        vm.prank(alice);
        vm.expectRevert();
        sale.buy(MACHINE);

        _fulfill(a, alice);

        vm.prank(alice);
        sale.buy(MACHINE); // slot freed
    }

    function test_maxPrice_blocksEnablingExpensiveMachine() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PackSale.PriceAboveMax.selector, MAX_PRICE + 1, MAX_PRICE));
        sale.setMachine(keccak256("pricey"), MAX_PRICE + 1, true);
    }

    /// A machine enabled under an old cap must stop selling when the cap drops beneath it.
    function test_maxPrice_blocksBuyIfCapLoweredAfterEnabling() public {
        vm.prank(owner);
        sale.setCaps(10, PRICE - 1, 5);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PackSale.PriceAboveMax.selector, PRICE, PRICE - 1));
        sale.buy(MACHINE);
    }

    function test_disabledMachine_reverts() public {
        vm.prank(owner);
        sale.setMachine(MACHINE, PRICE, false);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PackSale.MachineDisabled.selector, MACHINE));
        sale.buy(MACHINE);
    }

    // ------------------------------------------------------------ §4.4 pause semantics

    function test_pause_blocksBuy() public {
        vm.prank(guardian);
        sale.pause();

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        sale.buy(MACHINE);
    }

    /// Non-negotiable: a paused contract must never trap user funds.
    function test_pause_allowsRefund() public {
        uint256 orderId = _buy(alice);
        vm.prank(guardian);
        sale.pause();

        vm.warp(block.timestamp + 11 minutes);
        sale.refund(orderId);

        assertEq(sale.escrowedUsdg(), 0);
    }

    function test_pause_allowsForceRefund() public {
        uint256 orderId = _buy(alice);
        vm.prank(guardian);
        sale.pause();

        vm.warp(block.timestamp + 2 hours);
        vm.prank(owner);
        sale.forceRefund(orderId, "stranded while paused");

        assertEq(sale.escrowedUsdg(), 0);
    }

    function test_pause_allowsFulfilmentOfInFlightOrders() public {
        uint256 orderId = _buy(alice);
        vm.prank(guardian);
        sale.pause();

        uint256 tokenId = _fulfill(orderId, alice);
        assertEq(mirror.ownerOf(tokenId), alice);
    }

    function test_guardianCannotUnpause() public {
        vm.prank(guardian);
        sale.pause();

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        sale.unpause();
    }

    function test_strangerCannotPause() public {
        vm.prank(stranger);
        vm.expectRevert(PackSale.NotGuardianOrOwner.selector);
        sale.pause();
    }

    // ------------------------------------------------------------ §4.6 USDG edge cases

    function test_buy_withoutApproval_reverts() public {
        address carol = makeAddr("carol");
        usdg.mint(carol, 1_000_000_000);

        vm.prank(carol);
        vm.expectRevert();
        sale.buy(MACHINE);
    }

    function test_buy_withInsufficientBalance_reverts() public {
        address carol = makeAddr("carol");
        vm.prank(carol);
        usdg.approve(address(sale), type(uint256).max);

        vm.prank(carol);
        vm.expectRevert();
        sale.buy(MACHINE);
    }

    /// Balance-diff accounting: a token that skims on transfer must be rejected outright
    /// rather than silently under-funding escrow.
    function test_buy_feeOnTransferToken_reverts() public {
        FeeOnTransferUSDG feeToken = new FeeOnTransferUSDG(100); // 1%
        MirrorNFT m2 = new MirrorNFT(address(feeToken), owner, address(this), treasury);
        PackSale s2 = new PackSale(address(feeToken), address(m2), owner, address(this), guardian, treasury, MAX_PRICE);

        vm.prank(owner);
        s2.setMachine(MACHINE, PRICE, true);

        feeToken.mint(alice, 1_000_000_000);
        vm.startPrank(alice);
        feeToken.approve(address(s2), type(uint256).max);
        vm.expectRevert(PackSale.UnexpectedTokenBalance.selector);
        s2.buy(MACHINE);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ escrow protection

    function test_sweepSurplus_cannotTouchEscrow() public {
        _buy(alice);
        usdg.mint(address(sale), 7_000_000); // stray donation

        vm.prank(owner);
        sale.sweepSurplus(address(usdg), treasury);

        assertEq(usdg.balanceOf(treasury), 7_000_000, "only the surplus moves");
        assertEq(usdg.balanceOf(address(sale)), PRICE, "escrow untouched");
    }

    function test_setTimeout_rejectsAbsurdValues() public {
        vm.startPrank(owner);
        vm.expectRevert(PackSale.InvalidTimeout.selector);
        sale.setTimeout(1 seconds);
        vm.expectRevert(PackSale.InvalidTimeout.selector);
        sale.setTimeout(2 days);
        sale.setTimeout(15 minutes);
        vm.stopPrank();
        assertEq(sale.orderTimeout(), 15 minutes);
    }

    // ---------------------------------------------------------------- turbo

    /// The whole reason Turbo could not ship: the worker learns about orders from the CHAIN,
    /// so an order that carries no turbo flag is indistinguishable from a normal one no matter
    /// what the website recorded.
    function test_turbo_flagReachesTheChain() public {
        vm.recordLogs();
        vm.prank(alice);
        uint256 id = sale.buyTurbo(MACHINE);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != keccak256("OrderCreated(uint256,address,bytes32,uint256,uint64,bool)")) continue;
            (,, bool turbo) = abi.decode(logs[i].data, (uint256, uint64, bool));
            assertTrue(turbo, "OrderCreated must carry the flag or the worker cannot see it");
            found = true;
        }
        assertTrue(found, "OrderCreated was not emitted");

        assertTrue(sale.getOrder(id).turbo, "and it must survive in storage for a later read");
    }

    function test_turbo_plainBuyIsNotTurbo() public {
        uint256 id = _buy(alice);
        assertFalse(sale.getOrder(id).turbo, "an ordinary buy must never be read as turbo");
    }

    /// buyTurbo is a separate entry point precisely so the deployed frontend keeps working.
    /// If this ever regresses, every existing caller breaks on the redeploy.
    function test_turbo_plainBuySignatureUnchanged() public {
        uint256 id = _buy(alice);
        assertEq(sale.openOrdersOf(alice), 1);
        assertEq(sale.getOrder(id).buyer, alice);
    }

    /// Turbo must not become a way around the caps.
    function test_turbo_obeysEveryCap() public {
        vm.prank(owner);
        sale.setCaps(1, MAX_PRICE, 5);

        vm.prank(alice);
        sale.buyTurbo(MACHINE);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PackSale.DailyCapReached.selector, uint32(1)));
        sale.buyTurbo(MACHINE);
    }

    function test_turbo_obeysThePerBuyerCap() public {
        vm.startPrank(alice);
        sale.buyTurbo(MACHINE);
        sale.buyTurbo(MACHINE);
        vm.expectRevert(abi.encodeWithSelector(PackSale.TooManyOpenOrdersForBuyer.selector, uint32(2)));
        sale.buyTurbo(MACHINE);
        vm.stopPrank();
    }
}
