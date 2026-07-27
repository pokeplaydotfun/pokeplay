// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaseTest} from "./Base.t.sol";
import {PackSale} from "../src/PackSale.sol";
import {Marketplace} from "../src/Marketplace.sol";
import {MirrorNFT} from "../src/MirrorNFT.sol";

/// @dev A buyer contract that cannot receive ERC-721. Any smart-contract wallet without
///      onERC721Received behaves this way by accident.
contract DeadBuyer {
    function buy(PackSale s, bytes32 machine) external returns (uint256) {
        return s.buy(machine);
    }
}

contract AttackTest is BaseTest {
    // F1 (draw after deadline) and F2 (drawn order leaking an open-order slot) were FIXED on
    // 19 Jul 2026 and their proofs now live in PackSaleDraw.t.sol as assertions that the fix
    // holds. What remains below is deliberately kept: these are findings that are still open,
    // and the tests are the record of exactly how they are exploited.
    address internal drawer = makeAddr("drawerEoa");

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        sale.setDrawer(drawer);
    }

    /// F3 — FIXED. The per-buyer open-order cap landed; the note that used to sit here said
    /// "a per-address open-order limit would be the real fix; this test stands as the record."
    /// This is now the record of the fix, and of what it did and did not remove.
    ///
    /// Before: one funded address occupied every slot, rotating them indefinitely at zero
    /// principal cost, because every order refunds in full. The storefront closed for
    /// everyone.
    function test_F3_FIXED_oneAddressCannotOccupyEverySlot() public {
        // maxOpenOrdersPerBuyer is 2, so bob stops at 2 with three global slots free.
        _buy(bob);
        _buy(bob);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PackSale.TooManyOpenOrdersForBuyer.selector, uint32(2)));
        sale.buy(MACHINE);

        // The store stays OPEN to everyone else, which is the property that was lost before.
        _buy(alice);
        assertEq(sale.openOrderCount(), 3, "three of five taken, two still available");

        vm.prank(alice);
        sale.buy(MACHINE); // alice's second, still within her own cap
        assertEq(sale.openOrderCount(), 4, "a normal user is unaffected by bob's attempt");
    }

    /// What the grief COSTS now, stated rather than implied.
    ///
    /// It is not eliminated. An attacker can still fill the book, but needs ceil(5/2) = 3
    /// distinct funded wallets instead of one, and each needs its own USDG and gas. That turns
    /// a free single-wallet grief into a sybil operation, which is a different economic
    /// problem — and one the operator can price by lowering maxOpenOrdersPerBuyer or raising
    /// maxOpenOrders, both without a redeploy.
    function test_F3_residual_griefNowRequiresMultipleFundedWallets() public {
        address[3] memory sybils = [_funded("sybil-1"), _funded("sybil-2"), _funded("sybil-3")];

        _buy(sybils[0]);
        _buy(sybils[0]);
        _buy(sybils[1]);
        _buy(sybils[1]);
        _buy(sybils[2]);

        assertEq(sale.openOrderCount(), 5, "the book can still be filled, at 3x the setup");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PackSale.TooManyOpenOrders.selector, uint32(5)));
        sale.buy(MACHINE);

        // And it is still free in principal terms. That has not changed and should not be
        // claimed otherwise: the cost is wallet setup and gas, not capital.
        uint256 before = usdg.balanceOf(sybils[0]);
        vm.warp(block.timestamp + 11 minutes);
        sale.refund(1);
        assertEq(usdg.balanceOf(sybils[0]), before + PRICE, "principal always returns");
    }

    /// F4 — FIXED 20 Jul. `burnForSell` took nothing but a tokenId, so a compromised worker
    /// key could burn EVERY mirror in existence while the Solana cards stayed in custody:
    /// total loss of every user's claim, no USDG paid, no consent. It was the largest
    /// single-key blast radius in the system.
    ///
    /// The fix needed no signature scheme, because consent already existed in the design: a
    /// sell-back begins with the holder transferring their mirror to custody.
    function test_F4_FIXED_cannotBurnAMirrorHeldByItsOwner() public {
        uint256 orderId = _buy(alice);
        uint256 tokenId = _fulfill(orderId, alice);
        assertEq(mirror.ownerOf(tokenId), alice);

        // The worker key drives the real burn path, through the Fulfiller.
        vm.prank(workerKey);
        vm.expectRevert(abi.encodeWithSelector(MirrorNFT.NotInCustody.selector, tokenId, alice));
        fulfiller.burnAfterSell(tokenId);

        assertEq(mirror.ownerOf(tokenId), alice, "Alice still holds her card");

        // And the legitimate path still works once she surrenders it.
        _surrender(tokenId, alice);
        vm.prank(workerKey);
        fulfiller.burnAfterSell(tokenId);
        assertEq(mirror.balanceOf(custody), 0);
    }

    /// F5 — FIXED. Unfillable offers can be cleared, and a full book of them no longer
    /// blocks a real buyer.
    ///
    /// The attack: 100 offers of 1 unit each, from wallets holding no USDG and granting no
    /// allowance, expiring in a second. Free but for gas, they occupied every slot, and
    /// nobody could remove them — not the card's owner, not after expiry.
    function test_F5_FIXED_stuffedOfferBookCanBeCleared() public {
        Marketplace market = new Marketplace(address(usdg), address(mirror), owner, treasury, 250);

        uint256 tokenId = _fulfill(_buy(alice), alice);

        for (uint256 i = 0; i < 100; i++) {
            vm.prank(address(uint160(0xBEEF0000 + i)));
            market.makeOffer(tokenId, 1, uint64(block.timestamp + 1));
        }
        assertEq(market.offerCount(tokenId), 100);

        vm.warp(block.timestamp + 1 days);

        // ANYONE can clear them. Alice could not touch a single one before.
        vm.prank(alice);
        uint256 pruned = market.pruneOffers(tokenId, 0);
        assertEq(pruned, 100, "every dead offer cleared");
        assertEq(market.offerCount(tokenId), 0, "the book is empty again");

        // And a real offer now lands.
        usdg.mint(bob, 1_000_000_000);
        vm.startPrank(bob);
        usdg.approve(address(market), type(uint256).max);
        market.makeOffer(tokenId, 100_000_000, 0);
        vm.stopPrank();
        assertEq(market.offerCount(tokenId), 1);
    }

    /// A real buyer is not blocked even BEFORE anyone prunes: makeOffer evicts one dead offer
    /// to make room. Without this the fix would still require someone to notice and act first.
    function test_F5_FIXED_aRealOfferEvictsADeadOneAutomatically() public {
        Marketplace market = new Marketplace(address(usdg), address(mirror), owner, treasury, 250);
        uint256 tokenId = _fulfill(_buy(alice), alice);

        for (uint256 i = 0; i < 100; i++) {
            vm.prank(address(uint160(0xBEEF0000 + i)));
            market.makeOffer(tokenId, 1, uint64(block.timestamp + 1));
        }
        vm.warp(block.timestamp + 1 days);

        usdg.mint(bob, 1_000_000_000);
        vm.startPrank(bob);
        usdg.approve(address(market), type(uint256).max);
        market.makeOffer(tokenId, 100_000_000, 0); // no prune first, and it still works
        vm.stopPrank();

        assertEq(market.offerCount(tokenId), 100, "one dead offer made way for a live one");
        (,,, bool[] memory fillable) = market.getOffers(tokenId);
        uint256 live;
        for (uint256 i = 0; i < fillable.length; i++) if (fillable[i]) live++;
        assertEq(live, 1, "bob's offer is the only fillable one");
    }

    /// Pruning must not touch offers that can still be filled. This is the property that stops
    /// pruneOffers becoming a way to grief someone's genuine offer off a book.
    function test_F5_pruneLeavesLiveOffersAlone() public {
        Marketplace market = new Marketplace(address(usdg), address(mirror), owner, treasury, 250);
        uint256 tokenId = _fulfill(_buy(alice), alice);

        usdg.mint(bob, 1_000_000_000);
        vm.startPrank(bob);
        usdg.approve(address(market), type(uint256).max);
        market.makeOffer(tokenId, 100_000_000, 0);
        vm.stopPrank();

        vm.prank(address(0xDEAD));
        market.makeOffer(tokenId, 1, uint64(block.timestamp + 1));
        vm.warp(block.timestamp + 1 days);

        vm.prank(stranger);
        assertEq(market.pruneOffers(tokenId, 0), 1, "only the dead one goes");
        assertEq(market.offerCount(tokenId), 1);
        (address[] memory offerors,,,) = market.getOffers(tokenId);
        assertEq(offerors[0], bob, "bob's live offer survived");
    }

    /// Nothing to prune is an error, not a silent success, so a griefer cannot burn gas
    /// pretending to maintain a book that is already clean.
    function test_F5_pruneRevertsWhenTheBookIsHealthy() public {
        Marketplace market = new Marketplace(address(usdg), address(mirror), owner, treasury, 250);
        uint256 tokenId = _fulfill(_buy(alice), alice);

        usdg.mint(bob, 1_000_000_000);
        vm.startPrank(bob);
        usdg.approve(address(market), type(uint256).max);
        market.makeOffer(tokenId, 100_000_000, 0);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(Marketplace.NothingToPrune.selector, tokenId));
        market.pruneOffers(tokenId, 0);
    }
}
