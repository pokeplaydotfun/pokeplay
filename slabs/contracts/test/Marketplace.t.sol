// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaseTest} from "./Base.t.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {MirrorNFT} from "../src/MirrorNFT.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Approval-based listings mean a listing is a promise, not an escrow. Most of what
///         matters here is what happens when that promise goes stale.
contract MarketplaceTest is BaseTest {
    Marketplace internal market;
    address internal carol = makeAddr("carol");

    uint96 internal constant ASK = 120_000_000; // 120 USDG

    function setUp() public override {
        super.setUp();
        market = new Marketplace(address(usdg), address(mirror), owner, treasury, 250); // 2.5%

        // Give alice a card to sell, and carol money to buy it with.
        vm.prank(owner);
        mirror.setOperator(address(this));
        mirror.mint(alice, 1, _meta(), "ipfs://card");

        usdg.mint(carol, 1_000_000_000);
        vm.prank(carol);
        usdg.approve(address(market), type(uint256).max);

        vm.prank(alice);
        mirror.setApprovalForAll(address(market), true);
    }

    function _list(uint96 price) internal {
        vm.prank(alice);
        market.list(1, price);
    }

    // ------------------------------------------------------------ listing

    function test_list_storesSellerAndPrice() public {
        _list(ASK);
        Marketplace.Listing memory l = market.getListing(1);
        assertEq(l.seller, alice);
        assertEq(l.priceUsdg, ASK);
        assertTrue(market.isFillable(1));
    }

    /// The seller keeps the card. That is the whole point of approval-based listing.
    function test_list_doesNotTakeCustody() public {
        _list(ASK);
        assertEq(mirror.ownerOf(1), alice);
    }

    function test_list_byNonOwner_reverts() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.NotOwner.selector, 1, bob));
        market.list(1, ASK);
    }

    function test_list_withoutApproval_reverts() public {
        vm.prank(alice);
        mirror.setApprovalForAll(address(market), false);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.NotApproved.selector, 1));
        market.list(1, ASK);
    }

    function test_list_zeroPrice_reverts() public {
        vm.prank(alice);
        vm.expectRevert(Marketplace.PriceZero.selector);
        market.list(1, 0);
    }

    function test_list_twice_reverts() public {
        _list(ASK);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.AlreadyListed.selector, 1));
        market.list(1, ASK);
    }

    // ------------------------------------------------------------ buying

    function test_buy_movesCardAndSplitsPayment() public {
        _list(ASK);
        uint256 aliceBefore = usdg.balanceOf(alice);

        vm.prank(carol);
        market.buy(1, ASK);

        assertEq(mirror.ownerOf(1), carol, "card moved to buyer");
        // 2.5% of 120 = 3; seller keeps 117.
        assertEq(usdg.balanceOf(alice) - aliceBefore, 117_000_000);
        assertEq(usdg.balanceOf(treasury), 3_000_000);
        assertEq(market.getListing(1).seller, address(0), "listing cleared");
    }

    /// The contract must never hold funds; there is then nothing for a bug to strand.
    function test_buy_marketplaceHoldsNothing() public {
        _list(ASK);
        vm.prank(carol);
        market.buy(1, ASK);

        assertEq(usdg.balanceOf(address(market)), 0);
        assertEq(mirror.balanceOf(address(market)), 0);
    }

    function test_buy_unlisted_reverts() public {
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.NotListed.selector, 1));
        market.buy(1, ASK);
    }

    function test_buy_ownListing_reverts() public {
        _list(ASK);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.CannotBuyOwnListing.selector, 1));
        market.buy(1, ASK);
    }

    /// A buyer signs for a price. If the seller moved it first, the buy must fail rather
    /// than quietly charging the new one.
    function test_buy_afterPriceRaised_reverts() public {
        _list(ASK);
        vm.prank(alice);
        market.updatePrice(1, ASK * 2);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.PriceChanged.selector, ASK, ASK * 2));
        market.buy(1, ASK);
    }

    function test_buy_withoutFunds_reverts() public {
        _list(ASK);
        address broke = makeAddr("broke");
        vm.prank(broke);
        usdg.approve(address(market), type(uint256).max);

        vm.prank(broke);
        vm.expectRevert();
        market.buy(1, ASK);
    }

    // ------------------------------------------------- stale listings (the real risk)

    /// Seller sold or moved the card elsewhere while it was still listed.
    function test_buy_afterSellerTransfersAway_reverts() public {
        _list(ASK);
        vm.prank(alice);
        mirror.transferFrom(alice, bob, 1);

        assertFalse(market.isFillable(1), "UI should already show this as unfillable");

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.SellerNoLongerOwns.selector, 1, alice));
        market.buy(1, ASK);
    }

    /// Seller revoked approval while still holding the card.
    function test_buy_afterApprovalRevoked_reverts() public {
        _list(ASK);
        vm.prank(alice);
        mirror.setApprovalForAll(address(market), false);

        assertFalse(market.isFillable(1));

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.ApprovalRevoked.selector, 1));
        market.buy(1, ASK);
    }

    /// Seller unwrapped or sold the card back, burning the mirror.
    function test_buy_afterCardBurned_reverts() public {
        _list(ASK);
        _surrender(1, alice);
        mirror.burnForSell(1);

        vm.prank(carol);
        vm.expectRevert(); // ownerOf on a burned token
        market.buy(1, ASK);
    }

    /// A new owner inheriting a stale listing can clear it themselves.
    function test_newOwnerCanCancelStaleListing() public {
        _list(ASK);
        vm.prank(alice);
        mirror.transferFrom(alice, bob, 1);

        vm.prank(bob);
        market.cancel(1);
        assertEq(market.getListing(1).seller, address(0));
    }

    // ------------------------------------------------------------ cancelling

    function test_cancel_bySeller() public {
        _list(ASK);
        vm.prank(alice);
        market.cancel(1);
        assertEq(market.getListing(1).seller, address(0));
    }

    function test_cancel_byStranger_reverts() public {
        _list(ASK);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.NotSeller.selector, 1, stranger));
        market.cancel(1);
    }

    /// Never trap a seller's own offer, even while trading is halted.
    function test_cancel_worksWhilePaused() public {
        _list(ASK);
        vm.prank(owner);
        market.pause();

        vm.prank(alice);
        market.cancel(1);
        assertEq(market.getListing(1).seller, address(0));
    }

    // ------------------------------------------------------------ fees + admin

    function test_zeroFee_sellerGetsEverything() public {
        vm.prank(owner);
        market.setFeeBps(0);
        _list(ASK);

        uint256 before = usdg.balanceOf(alice);
        vm.prank(carol);
        market.buy(1, ASK);

        assertEq(usdg.balanceOf(alice) - before, ASK);
        assertEq(usdg.balanceOf(treasury), 0);
    }

    function test_feeAboveMax_reverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.FeeAboveMax.selector, 501));
        market.setFeeBps(501);
    }

    function test_setFee_byStranger_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        market.setFeeBps(100);
    }

    function test_pause_blocksListingAndBuying() public {
        _list(ASK);
        vm.prank(owner);
        market.pause();

        vm.prank(carol);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        market.buy(1, ASK);
    }

    function test_priceBreakdown() public {
        _list(ASK);
        (uint256 price, uint256 fee, uint256 receives) = market.priceBreakdown(1);
        assertEq(price, ASK);
        assertEq(fee, 3_000_000);
        assertEq(receives, 117_000_000);
    }

    // ------------------------------------------------------------ fuzz

    /// However the price falls, the split must be exact and never exceed what was paid.
    function testFuzz_feeSplitIsExact(uint96 price) public {
        price = uint96(bound(price, 1, 1e15));

        vm.prank(owner);
        mirror.setOperator(address(this));
        mirror.mint(bob, 2, _meta(), "ipfs://c2");
        vm.prank(bob);
        mirror.setApprovalForAll(address(market), true);
        vm.prank(bob);
        market.list(2, price);

        usdg.mint(carol, price);
        uint256 sellerBefore = usdg.balanceOf(bob);
        uint256 feeBefore = usdg.balanceOf(treasury);

        vm.prank(carol);
        market.buy(2, price);

        uint256 toSeller = usdg.balanceOf(bob) - sellerBefore;
        uint256 toFee = usdg.balanceOf(treasury) - feeBefore;
        assertEq(toSeller + toFee, price, "split must account for every unit");
        assertLe(toFee, (uint256(price) * 500) / 10_000, "fee can never exceed the 5% ceiling");
    }

    // ------------------------------------------------------------ offers

    uint96 internal constant BID = 90_000_000; // 90 USDG

    function _offer(address who, uint96 amount, uint64 expiry) internal {
        vm.prank(who);
        market.makeOffer(1, amount, expiry);
    }

    function test_makeOffer_storesAndEnumerates() public {
        _offer(carol, BID, 0);

        (uint96 amount, uint64 expiry) = market.offers(1, carol);
        assertEq(amount, BID);
        assertEq(expiry, 0);
        assertEq(market.offerCount(1), 1);
        assertTrue(market.isOfferFillable(1, carol));
    }

    /// An offer costs the offeror no capital. That is the point of allowance-based bidding.
    function test_makeOffer_doesNotMoveFunds() public {
        uint256 before = usdg.balanceOf(carol);
        _offer(carol, BID, 0);
        assertEq(usdg.balanceOf(carol), before);
        assertEq(usdg.balanceOf(address(market)), 0);
    }

    function test_makeOffer_onOwnCard_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.CannotOfferOnOwnCard.selector, 1));
        market.makeOffer(1, BID, 0);
    }

    function test_makeOffer_zeroAmount_reverts() public {
        vm.prank(carol);
        vm.expectRevert(Marketplace.AmountZero.selector);
        market.makeOffer(1, 0, 0);
    }

    function test_makeOffer_expiryInPast_reverts() public {
        vm.warp(1000);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.ExpiryInPast.selector, uint64(999)));
        market.makeOffer(1, BID, 999);
    }

    /// Re-offering replaces rather than duplicating, so raising a bid is one transaction.
    function test_makeOffer_twice_replacesWithoutDuplicating() public {
        _offer(carol, BID, 0);
        _offer(carol, BID * 2, 0);

        (uint96 amount,) = market.offers(1, carol);
        assertEq(amount, BID * 2);
        assertEq(market.offerCount(1), 1);
    }

    function test_withdrawOffer_clearsAndDeEnumerates() public {
        _offer(carol, BID, 0);
        vm.prank(carol);
        market.withdrawOffer(1);

        (uint96 amount,) = market.offers(1, carol);
        assertEq(amount, 0);
        assertEq(market.offerCount(1), 0);
    }

    function test_withdrawOffer_withoutOffer_reverts() public {
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.NoOffer.selector, 1, carol));
        market.withdrawOffer(1);
    }

    /// An offeror must never be trapped in a standing bid, even while paused.
    function test_withdrawOffer_worksWhilePaused() public {
        _offer(carol, BID, 0);
        vm.prank(owner);
        market.pause();

        vm.prank(carol);
        market.withdrawOffer(1);
        assertEq(market.offerCount(1), 0);
    }

    function test_acceptOffer_transfersCardAndPaysSellerNetOfFee() public {
        _offer(carol, BID, 0);

        uint256 sellerBefore = usdg.balanceOf(alice);
        uint256 treasuryBefore = usdg.balanceOf(treasury);

        vm.prank(alice);
        market.acceptOffer(1, carol, BID);

        uint256 fee = (uint256(BID) * 250) / 10_000;
        assertEq(mirror.ownerOf(1), carol);
        assertEq(usdg.balanceOf(alice), sellerBefore + BID - fee);
        assertEq(usdg.balanceOf(treasury), treasuryBefore + fee);
        assertEq(market.offerCount(1), 0);
    }

    function test_acceptOffer_byNonOwner_reverts() public {
        _offer(carol, BID, 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.NotOwner.selector, 1, bob));
        market.acceptOffer(1, carol, BID);
    }

    /// The seller agreed to a number. A bid lowered in the same block must not slip through.
    function test_acceptOffer_afterOfferLowered_reverts() public {
        _offer(carol, BID, 0);
        _offer(carol, BID / 2, 0);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.OfferChanged.selector, BID, BID / 2));
        market.acceptOffer(1, carol, BID);
    }

    function test_acceptOffer_expired_reverts() public {
        vm.warp(1000);
        _offer(carol, BID, 2000);
        vm.warp(2001);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.OfferExpired.selector, 1, carol, uint64(2000)));
        market.acceptOffer(1, carol, BID);
    }

    /// The offeror keeps their USDG, so it can be gone by the time the seller accepts.
    function test_acceptOffer_afterOfferorSpentFunds_reverts() public {
        _offer(carol, BID, 0);
        // Read the balance BEFORE the prank: a view call consumes it, and the transfer
        // would then run as the test contract instead of carol.
        uint256 carolAll = usdg.balanceOf(carol);
        vm.prank(carol);
        usdg.transfer(bob, carolAll);

        assertFalse(market.isOfferFillable(1, carol));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.OfferorCannotPay.selector, carol, BID));
        market.acceptOffer(1, carol, BID);
    }

    function test_acceptOffer_afterAllowanceRevoked_reverts() public {
        _offer(carol, BID, 0);
        vm.prank(carol);
        usdg.approve(address(market), 0);

        assertFalse(market.isOfferFillable(1, carol));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.OfferorCannotPay.selector, carol, BID));
        market.acceptOffer(1, carol, BID);
    }

    function test_acceptOffer_withoutNftApproval_reverts() public {
        _offer(carol, BID, 0);
        vm.prank(alice);
        mirror.setApprovalForAll(address(market), false);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Marketplace.NotApproved.selector, 1));
        market.acceptOffer(1, carol, BID);
    }

    /// Selling into an offer must not leave a live ask on a card the seller no longer owns.
    function test_acceptOffer_clearsAnyListing() public {
        _list(ASK);
        _offer(carol, BID, 0);

        vm.prank(alice);
        market.acceptOffer(1, carol, BID);

        assertEq(market.getListing(1).seller, address(0));
        assertFalse(market.isFillable(1));
    }

    /// Other bidders keep their offers; only the accepted one is consumed.
    function test_acceptOffer_leavesOtherOffersIntact() public {
        usdg.mint(bob, 1_000_000_000);
        vm.prank(bob);
        usdg.approve(address(market), type(uint256).max);

        _offer(carol, BID, 0);
        _offer(bob, BID / 2, 0);

        vm.prank(alice);
        market.acceptOffer(1, carol, BID);

        assertEq(market.offerCount(1), 1);
        (uint96 amount,) = market.offers(1, bob);
        assertEq(amount, BID / 2);
    }

    function test_getOffers_returnsAllWithFillability() public {
        usdg.mint(bob, 1_000_000_000);
        vm.prank(bob);
        usdg.approve(address(market), type(uint256).max);

        _offer(carol, BID, 0);
        _offer(bob, BID / 2, 0);

        // Drain bob so exactly one of the two is unfillable.
        uint256 bobAll = usdg.balanceOf(bob);
        vm.prank(bob);
        usdg.transfer(alice, bobAll);

        (address[] memory who, uint96[] memory amounts,, bool[] memory fillable) = market.getOffers(1);
        assertEq(who.length, 2);
        assertEq(amounts[0], BID);
        assertTrue(fillable[0]);
        assertEq(who[1], bob);
        assertFalse(fillable[1]);
    }

    /// Swap-and-pop removal must not corrupt the index of the element it moves.
    function test_offerEnumeration_survivesMiddleRemoval() public {
        address[3] memory bidders = [makeAddr("d1"), makeAddr("d2"), makeAddr("d3")];
        for (uint256 i = 0; i < 3; ++i) {
            usdg.mint(bidders[i], 1_000_000_000);
            vm.prank(bidders[i]);
            usdg.approve(address(market), type(uint256).max);
            _offer(bidders[i], BID, 0);
        }

        vm.prank(bidders[0]);
        market.withdrawOffer(1);

        assertEq(market.offerCount(1), 2);
        // Both survivors must still be withdrawable, which fails if an index went stale.
        vm.prank(bidders[1]);
        market.withdrawOffer(1);
        vm.prank(bidders[2]);
        market.withdrawOffer(1);
        assertEq(market.offerCount(1), 0);
    }

    function test_makeOffer_whilePaused_reverts() public {
        vm.prank(owner);
        market.pause();
        vm.prank(carol);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        market.makeOffer(1, BID, 0);
    }
}
