// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaseTest} from "./Base.t.sol";
import {PackSale} from "../src/PackSale.sol";
import {MirrorNFT} from "../src/MirrorNFT.sol";
import {Marketplace} from "../src/Marketplace.sol";

/// @notice Final pre-launch review, 20 Jul 2026. Adversarial checks on the F1-F5 fixes and
///         on their combination, plus the new findings. Named `_SOUND` where the check
///         confirms the fix holds and `_FINDING` where it does not.
contract FinalReviewTest is BaseTest {
    address internal drawerEoa = makeAddr("drawerEoa");

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        sale.setDrawer(drawerEoa);
    }

    // ================================================================ F1: draw vs deadline

    /// The draw window and the refund window are exactly complementary — no instant exists
    /// in which both are callable, and none in which neither is.
    function test_F1_drawAndRefundWindowsArePerfectlyDisjoint_SOUND() public {
        uint256 id = _buy(alice);
        uint64 deadline = sale.getOrder(id).deadline;

        // One second BEFORE the deadline: draw allowed, refund refused.
        vm.warp(deadline - 1);
        vm.expectRevert(abi.encodeWithSelector(PackSale.DeadlineNotPassed.selector, id, deadline));
        sale.refund(id);

        // EXACTLY at the deadline: still the drawer's, still not refundable.
        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(PackSale.DeadlineNotPassed.selector, id, deadline));
        sale.refund(id);

        // One second AFTER: the draw is closed forever, the refund is open forever.
        vm.warp(deadline + 1);
        vm.prank(drawerEoa);
        vm.expectRevert(abi.encodeWithSelector(PackSale.DeadlineNotPassed.selector, id, deadline));
        sale.drawForOpen(id);

        sale.refund(id);
        assertEq(uint8(sale.getOrder(id).status), uint8(PackSale.OrderStatus.REFUNDED));
    }

    /// At the exact deadline second the drawer may still draw. That is the last instant it
    /// can, and the buyer has no refund right at that instant either, so nothing is taken
    /// from them that was theirs to take.
    function test_F1_drawAtExactDeadlineSucceedsButBuyerHadNoRefundRightYet_SOUND() public {
        uint256 id = _buy(alice);
        uint64 deadline = sale.getOrder(id).deadline;

        vm.warp(deadline);
        vm.prank(drawerEoa);
        sale.drawForOpen(id);
        assertTrue(sale.getOrder(id).drawn);
    }

    /// setTimeout cannot retro-extend an order that is already refundable, because the
    /// deadline is stamped into the order at buy time and never re-read.
    function test_F1_setTimeoutCannotReopenTheDrawWindowMidFlight_SOUND() public {
        uint256 id = _buy(alice);
        uint64 deadline = sale.getOrder(id).deadline;

        vm.warp(deadline + 1);

        // The owner stretches the timeout to the maximum, hoping to make the expired order
        // drawable again.
        vm.prank(owner);
        sale.setTimeout(1 hours);

        assertEq(sale.getOrder(id).deadline, deadline, "stored deadline must not move");

        vm.prank(drawerEoa);
        vm.expectRevert(abi.encodeWithSelector(PackSale.DeadlineNotPassed.selector, id, deadline));
        sale.drawForOpen(id);
    }

    /// Shortening the timeout likewise cannot cut an in-flight order's draw window short.
    function test_F1_shorteningTimeoutDoesNotAffectExistingOrders_SOUND() public {
        vm.prank(owner);
        sale.setTimeout(1 hours);
        uint256 id = _buy(alice);
        uint64 deadline = sale.getOrder(id).deadline;

        vm.prank(owner);
        sale.setTimeout(1 minutes);

        vm.warp(deadline - 1);
        vm.prank(drawerEoa);
        sale.drawForOpen(id); // still inside the ORIGINAL window
        assertTrue(sale.getOrder(id).drawn);
    }

    // ================================================================ F2: openOrderCount

    /// Every exit from PENDING decrements exactly once. Five orders, five different exit
    /// paths, count back to zero.
    function test_F2_allFiveExitPathsDecrementExactlyOnce_SOUND() public {
        vm.prank(owner);
        sale.setCaps(1000, MAX_PRICE, 10);

        // One buyer per path. Distinct addresses because the per-buyer cap is 2, and because
        // it lets this test check the SECOND counter too: a per-buyer slot that leaks on any
        // of these five paths locks that address out of the store permanently, which is worse
        // than the griefing the cap exists to prevent.
        address ua = _funded("exit-refund");
        address ub = _funded("exit-fulfil");
        address uc = _funded("exit-fulfil-drawn");
        address ud = _funded("exit-closedrawn");
        address ue = _funded("exit-forcerefund");

        uint256 a = _buy(ua); // -> refund()
        uint256 b = _buy(ub); // -> markFulfilled (not drawn)
        uint256 c = _buy(uc); // -> markFulfilled (drawn)
        uint256 d = _buy(ud); // -> closeDrawnOrder
        uint256 e = _buy(ue); // -> forceRefund (drawn)

        assertEq(sale.openOrderCount(), 5);

        vm.startPrank(drawerEoa);
        sale.drawForOpen(c);
        sale.drawForOpen(d);
        sale.drawForOpen(e);
        vm.stopPrank();

        _fulfill(b, ub);
        assertEq(sale.openOrderCount(), 4);

        _fulfill(c, uc);
        assertEq(sale.openOrderCount(), 3);

        vm.prank(drawerEoa);
        sale.closeDrawnOrder(d, "solana float gate");
        assertEq(sale.openOrderCount(), 2);

        vm.warp(block.timestamp + 3 hours);

        sale.refund(a);
        assertEq(sale.openOrderCount(), 1);

        vm.prank(owner);
        sale.forceRefund(e, "mint unrecoverable");
        assertEq(sale.openOrderCount(), 0);

        // The per-buyer counters must ALSO be back to zero, on every one of the five paths.
        // _releaseSlot is the single place both counters move, so this is what proves they
        // cannot drift apart.
        assertEq(sale.openOrdersOf(ua), 0, "refund leaked a per-buyer slot");
        assertEq(sale.openOrdersOf(ub), 0, "markFulfilled (undrawn) leaked a per-buyer slot");
        assertEq(sale.openOrdersOf(uc), 0, "markFulfilled (drawn) leaked a per-buyer slot");
        assertEq(sale.openOrdersOf(ud), 0, "closeDrawnOrder leaked a per-buyer slot");
        assertEq(sale.openOrdersOf(ue), 0, "forceRefund leaked a per-buyer slot");

        // And escrow is exactly zero, with the contract holding only what it should.
        assertEq(sale.escrowedUsdg(), 0);
    }

    /// No exit path can fire twice on the same order, from any role, in any order. This is
    /// what makes the count provably non-leaking: the PENDING guard is the only gate and
    /// every path passes through it.
    function test_F2_noExitPathIsReentrableOnASettledOrder_SOUND() public {
        uint256 id = _buy(alice);
        vm.prank(drawerEoa);
        sale.drawForOpen(id);

        vm.prank(drawerEoa);
        sale.closeDrawnOrder(id, "float gate");
        assertEq(sale.openOrderCount(), 0);

        // Second close.
        vm.prank(drawerEoa);
        vm.expectRevert(
            abi.encodeWithSelector(PackSale.OrderNotPending.selector, id, PackSale.OrderStatus.REFUNDED)
        );
        sale.closeDrawnOrder(id, "again");

        // forceRefund on the same order.
        vm.warp(block.timestamp + 3 hours);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(PackSale.OrderNotPending.selector, id, PackSale.OrderStatus.REFUNDED)
        );
        sale.forceRefund(id, "again");

        // refund().
        vm.expectRevert(
            abi.encodeWithSelector(PackSale.OrderNotPending.selector, id, PackSale.OrderStatus.REFUNDED)
        );
        sale.refund(id);

        // And it can never be fulfilled after being closed.
        vm.prank(workerKey);
        vm.expectRevert();
        fulfiller.fulfill(id, alice, _meta(), "ipfs://x", keccak256("s"));
    }

    /// closeDrawnOrder refuses an order whose money is still in escrow — otherwise it would
    /// be a permissionless way to strand a buyer's funds in the contract forever.
    function test_F2_closeDrawnOrderRefusesAnUndrawnOrder_SOUND() public {
        uint256 id = _buy(alice);
        vm.prank(drawerEoa);
        vm.expectRevert(abi.encodeWithSelector(PackSale.NotDrawn.selector, id));
        sale.closeDrawnOrder(id, "nope");

        assertEq(sale.escrowedUsdg(), PRICE);
        assertEq(sale.openOrderCount(), 1);
    }

    /// closeDrawnOrder moves no tokens at all, so it can never reach another buyer's escrow.
    function test_F2_closeDrawnOrderMovesNoTokens_SOUND() public {
        vm.prank(owner);
        sale.setCaps(1000, MAX_PRICE, 10);

        uint256 victimOrder = _buy(bob); // bob's money stays in escrow
        uint256 id = _buy(alice);

        vm.prank(drawerEoa);
        sale.drawForOpen(id);

        uint256 saleBalBefore = usdg.balanceOf(address(sale));
        uint256 aliceBefore = usdg.balanceOf(alice);
        uint256 drawerBefore = usdg.balanceOf(drawerEoa);

        vm.prank(drawerEoa);
        sale.closeDrawnOrder(id, "float gate");

        assertEq(usdg.balanceOf(address(sale)), saleBalBefore, "contract balance untouched");
        assertEq(usdg.balanceOf(alice), aliceBefore, "no payout from here");
        assertEq(usdg.balanceOf(drawerEoa), drawerBefore, "drawer gains nothing");

        // Bob's escrow is intact and he can still be served.
        assertEq(sale.escrowedUsdg(), PRICE);
        _fulfill(victimOrder, bob);
        assertEq(usdg.balanceOf(treasury), PRICE);
    }

    /// FINDING N1: closeDrawnOrder does NOT check mirror.mintedForOrder, which forceRefund
    ///             does. Today the Fulfiller makes mint and markFulfilled atomic so the gap
    ///             is unreachable — this test pins that dependency so a future
    ///             `mirror.setOperator(<EOA>)` cannot silently open it.
    function test_F2_closeDrawnOrderHasNoMintCheck_reachableOnlyIfOperatorIsSplit_FINDING() public {
        uint256 id = _buy(alice);
        vm.prank(drawerEoa);
        sale.drawForOpen(id);

        // The ONLY thing standing between closeDrawnOrder and a refunded-yet-minted order is
        // that MirrorNFT's operator is the Fulfiller, which cannot mint without also
        // settling the order. Split the roles and the gap is immediate.
        vm.prank(owner);
        mirror.setOperator(address(this));

        mirror.mint(alice, id, _meta(), "ipfs://card");
        assertEq(mirror.mintedForOrder(id), 1);

        // forceRefund correctly refuses.
        vm.warp(block.timestamp + 3 hours);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PackSale.MirrorAlreadyMinted.selector, id, 1));
        sale.forceRefund(id, "unrecoverable");

        // closeDrawnOrder does not. Alice ends up holding the card AND booked for a refund.
        vm.prank(drawerEoa);
        sale.closeDrawnOrder(id, "float gate");

        assertEq(uint8(sale.getOrder(id).status), uint8(PackSale.OrderStatus.REFUNDED));
        assertEq(mirror.ownerOf(1), alice, "refunded order still has a live mirror");
    }

    // ================================================================ F3: burnForSell custody

    /// A mirror sitting in a user's own wallet cannot be burned by the operator.
    function test_F3_operatorCannotBurnAUserHeldMirror_SOUND() public {
        uint256 id = _buy(alice);
        uint256 tokenId = _fulfill(id, alice);

        vm.prank(workerKey);
        vm.expectRevert(abi.encodeWithSelector(MirrorNFT.NotInCustody.selector, tokenId, alice));
        fulfiller.burnAfterSell(tokenId);

        assertEq(mirror.ownerOf(tokenId), alice);
    }

    /// Surrendering to custody is the consent, and only then does the burn work.
    function test_F3_burnWorksOnlyAfterSurrender_SOUND() public {
        uint256 id = _buy(alice);
        uint256 tokenId = _fulfill(id, alice);
        _surrender(tokenId, alice);

        vm.prank(workerKey);
        fulfiller.burnAfterSell(tokenId);

        vm.expectRevert();
        mirror.ownerOf(tokenId);
    }

    /// FINDING N2: the custody check is only as strong as the separation between the owner
    ///             key and the operator key. `setCustodian` is unrestricted, so an owner can
    ///             point custody at any holder and burn their mirror without consent.
    ///
    ///             In the deployed configuration owner, Fulfiller.caller and custodian are
    ///             ALL the same EOA, so the fix's stated benefit — "a compromised worker key
    ///             can no longer burn every mirror" — does not hold in production. It is two
    ///             transactions from one key instead of one.
    function test_F3_ownerCanBurnAnyMirrorByRepointingCustodian_FINDING() public {
        uint256 id = _buy(alice);
        uint256 tokenId = _fulfill(id, alice);
        assertEq(mirror.ownerOf(tokenId), alice);

        // Alice never consented to anything and never moved her token.
        vm.prank(owner);
        mirror.setCustodian(alice);

        vm.prank(workerKey);
        fulfiller.burnAfterSell(tokenId);

        vm.expectRevert();
        mirror.ownerOf(tokenId); // destroyed, no USDG paid, still in her wallet a block ago
    }

    /// CustodianNotSet is recoverable, not a brick: the owner can always set it back.
    function test_F3_custodianNotSetIsRecoverable_SOUND() public {
        uint256 id = _buy(alice);
        uint256 tokenId = _fulfill(id, alice);
        _surrender(tokenId, alice);

        vm.prank(owner);
        mirror.setCustodian(address(0));

        vm.prank(workerKey);
        vm.expectRevert(MirrorNFT.CustodianNotSet.selector);
        fulfiller.burnAfterSell(tokenId);

        vm.prank(owner);
        mirror.setCustodian(custody);
        vm.prank(workerKey);
        fulfiller.burnAfterSell(tokenId); // sell-back is live again
    }

    // ================================================================ F4: daily cap

    function test_F4_dailyCapDefaultsTo500_SOUND() public view {
        assertEq(sale.dailyPackCap(), 500);
        assertEq(sale.packsLeftToday(), 500);
    }

    /// The cap actually binds, and it rolls over on the UTC day boundary rather than on a
    /// sliding window.
    function test_F4_dailyCapBindsAndRollsOver_SOUND() public {
        vm.prank(owner);
        sale.setCaps(2, MAX_PRICE, 10);

        // Distinct buyers so the DAILY cap is the only thing that can bind. With one buyer the
        // per-buyer cap (also 2) fires first and this test would pass for the wrong reason —
        // proving the per-buyer limit works while claiming to prove the daily one does.
        _buy(_funded("day-1"));
        _buy(_funded("day-2"));

        address third = _funded("day-3");
        vm.prank(third);
        vm.expectRevert(abi.encodeWithSelector(PackSale.DailyCapReached.selector, uint32(2)));
        sale.buy(MACHINE);

        vm.warp((block.timestamp / 1 days + 1) * 1 days);
        _buy(third); // new UTC day, cap reset
    }

    // ================================================================ P2: the combination

    /// A drawn order that is fulfilled pays the operator once and the treasury never — the
    /// money already left at the draw. Paying again would come out of another buyer's escrow.
    function test_P2_drawThenFulfillDoesNotDoublePay_SOUND() public {
        vm.prank(owner);
        sale.setCaps(1000, MAX_PRICE, 10);

        uint256 victim = _buy(bob);
        uint256 id = _buy(alice);

        vm.prank(drawerEoa);
        sale.drawForOpen(id);
        assertEq(usdg.balanceOf(drawerEoa), PRICE);

        _fulfill(id, alice);

        assertEq(usdg.balanceOf(treasury), 0, "treasury must not be paid twice");
        assertEq(sale.escrowedUsdg(), PRICE, "bob's escrow untouched");
        assertEq(usdg.balanceOf(address(sale)), PRICE);

        // Bob is still whole.
        vm.warp(block.timestamp + 11 minutes);
        sale.refund(victim);
        assertEq(usdg.balanceOf(bob), 1_000_000_000);
    }

    /// A drawn order can never be refunded out of the contract, by any route. Both the
    /// permissionless path and the owner escape hatch settle status only.
    function test_P2_drawnOrderNeverPaysOutOfTheContract_SOUND() public {
        vm.prank(owner);
        sale.setCaps(1000, MAX_PRICE, 10);

        _buy(bob); // someone else's escrow sitting in the contract
        uint256 id = _buy(alice);

        vm.prank(drawerEoa);
        sale.drawForOpen(id);

        vm.warp(block.timestamp + 3 hours);

        vm.expectRevert(abi.encodeWithSelector(PackSale.AlreadyDrawn.selector, id));
        sale.refund(id);

        uint256 aliceBefore = usdg.balanceOf(alice);
        vm.prank(owner);
        sale.forceRefund(id, "bridge stuck");
        assertEq(usdg.balanceOf(alice), aliceBefore, "forceRefund pays nothing for a drawn order");
        assertEq(sale.escrowedUsdg(), PRICE, "bob's escrow still exactly backed");
        assertEq(usdg.balanceOf(address(sale)), PRICE);
    }

    /// escrowedUsdg is never larger than the real balance, across every ordering of the new
    /// functions. sweepSurplus is the sharpest probe: it can only ever move the excess.
    function test_P2_sweepSurplusCanNeverReachEscrow_SOUND() public {
        vm.prank(owner);
        sale.setCaps(1000, MAX_PRICE, 10);

        uint256 a = _buy(alice);
        uint256 b = _buy(bob);
        vm.prank(drawerEoa);
        sale.drawForOpen(a);

        // Someone donates tokens to the contract by mistake.
        usdg.mint(address(sale), 7_000_000);

        vm.prank(owner);
        sale.sweepSurplus(address(usdg), treasury);

        assertEq(usdg.balanceOf(treasury), 7_000_000, "only the surplus moved");
        assertEq(usdg.balanceOf(address(sale)), sale.escrowedUsdg());

        // And bob, the only still-escrowed buyer, is paid in full.
        vm.warp(block.timestamp + 11 minutes);
        sale.refund(b);
        assertEq(usdg.balanceOf(bob), 1_000_000_000);
    }

    /// A close cannot race a fulfilment that is already in flight, because both go through
    /// the same PENDING gate and whichever lands second reverts.
    function test_P2_closeAndFulfillCannotBothLand_SOUND() public {
        uint256 id = _buy(alice);
        vm.prank(drawerEoa);
        sale.drawForOpen(id);

        _fulfill(id, alice);

        vm.prank(drawerEoa);
        vm.expectRevert(
            abi.encodeWithSelector(PackSale.OrderNotPending.selector, id, PackSale.OrderStatus.FULFILLED)
        );
        sale.closeDrawnOrder(id, "too late");
    }

    // ================================================================ P3: new findings

    /// FINDING N3: PackSale.buy takes no price bound. The frontend grants an INFINITE USDG
    ///             approval (useBuyPack.ts, maxUint256), so a setMachine landing between a
    ///             buyer's signature and its execution charges them the new price silently,
    ///             up to maxPackPrice — 1000 USDG on the deployed contract.
    ///
    ///             Marketplace.buy already takes `expectedPriceUsdg` for exactly this reason;
    ///             PackSale is the inconsistent one.
    function test_P3_buyHasNoSlippageGuardAndOvercharges_FINDING() public {
        // Alice signs a buy believing the pack costs PRICE (50 USDG).
        uint256 aliceBefore = usdg.balanceOf(alice);

        // The owner repoints the machine first — a routine price sync, or a front-run.
        vm.prank(owner);
        sale.setMachine(MACHINE, MAX_PRICE, true); // 55 USDG

        uint256 id = _buy(alice);

        assertEq(sale.getOrder(id).price, MAX_PRICE);
        assertEq(aliceBefore - usdg.balanceOf(alice), MAX_PRICE, "charged more than she agreed to");

        // Contrast: the marketplace refuses the same manoeuvre outright.
    }

    /// FINDING N4: Marketplace offer slots are a per-token DoS. MAX_OFFERS_PER_TOKEN is 100
    ///             and there is no eviction, so 100 unfundable 1-unit offers permanently
    ///             block every real bid on a card. Only the griefer can clear them.
    ///
    ///             Proven in Marketplace terms in test_P3_offerSlotGriefing below.

    /// The drawer is fully trusted with in-flight escrow — drawing and immediately closing
    /// takes a buyer's money with no on-chain remedy and no minimum age. This is inherent to
    /// drawForOpen rather than new in closeDrawnOrder, but it bounds the trust: at most
    /// maxOpenOrders * maxPackPrice is exposed to that single key at any instant.
    function test_P3_drawerCanTakeAndCloseInOneBlock_ACCEPTED_TRUST() public {
        uint256 id = _buy(alice);
        uint256 aliceBefore = usdg.balanceOf(alice);

        vm.startPrank(drawerEoa);
        sale.drawForOpen(id);
        sale.closeDrawnOrder(id, "float gate"); // no minimum age, unlike forceRefund's 2h
        vm.stopPrank();

        assertEq(usdg.balanceOf(drawerEoa), PRICE, "drawer holds the buyer's money");
        assertEq(usdg.balanceOf(alice), aliceBefore, "buyer got nothing back on chain");
        assertEq(uint8(sale.getOrder(id).status), uint8(PackSale.OrderStatus.REFUNDED));

        // The bound: exposure is capped by the concurrency limit, not unbounded.
        assertEq(sale.maxOpenOrders(), 5);
    }
}

/// @notice FINDING N4, proven: the offer book on a card can be filled with junk and there is
///         no way for anyone but the griefer to clear it.
contract MarketplaceOfferGriefTest is BaseTest {
    Marketplace internal market;

    function setUp() public override {
        super.setUp();
        market = new Marketplace(address(usdg), address(mirror), owner, treasury, 250);

        vm.prank(owner);
        mirror.setOperator(address(this));
        mirror.mint(alice, 1, _meta(), "ipfs://card");
    }

    /// P3 — FIXED. 100 offers of 1 unit each, from throwaway addresses with no USDG and no
    /// allowance, used to close alice's offer book permanently. A real bidder could not get
    /// in, the card owner could not evict anyone, and only the attacker could clear the slots.
    ///
    /// Note these NEVER EXPIRE. Eviction therefore cannot key on expiry alone — it has to ask
    /// whether an offer could actually be paid, which is what _offerFillable already knew and
    /// nothing ever called on somebody else's behalf.
    function test_P3_FIXED_offerSlotGriefingIsClearable() public {
        for (uint256 i = 0; i < market.MAX_OFFERS_PER_TOKEN(); i++) {
            address junk = address(uint160(uint256(keccak256(abi.encode("grief", i)))));
            vm.prank(junk);
            market.makeOffer(1, 1, 0); // 1 unit, never expires, unfundable
        }
        assertEq(market.offerCount(1), 100);
        assertFalse(market.isOfferFillable(1, address(uint160(uint256(keccak256(abi.encode("grief", uint256(0))))))));

        // The genuine bidder is no longer locked out: makeOffer evicts a dead slot to fit.
        usdg.mint(bob, 1_000_000_000);
        vm.prank(bob);
        usdg.approve(address(market), type(uint256).max);
        vm.prank(bob);
        market.makeOffer(1, 500_000_000, 0);
        assertTrue(market.isOfferFillable(1, bob), "the real bid is live");

        // And anyone can clear the rest, including alice, who previously had no recourse.
        vm.prank(alice);
        uint256 pruned = market.pruneOffers(1, 0);
        assertEq(pruned, 99, "every unfundable offer goes");
        assertEq(market.offerCount(1), 1, "only the real bid remains");

        (address[] memory offerors,,,) = market.getOffers(1);
        assertEq(offerors[0], bob);
    }
}

/// @notice The one place an untrusted party gets control inside a privileged transaction:
///         `mirror.mint` uses `_safeMint`, so a contract buyer's `onERC721Received` runs
///         INSIDE `Fulfiller.fulfill`, after the token exists but BEFORE `markFulfilled`.
///         Neither `mint` nor `fulfill` is nonReentrant, so PackSale's guard is not held.
contract MintCallbackReentrancyTest is BaseTest {
    /// A buyer contract that tries to refund its own order from inside the mint callback.
    ReentrantBuyer internal attacker;

    function setUp() public override {
        super.setUp();
        attacker = new ReentrantBuyer(sale, mirror);
        usdg.mint(address(attacker), 1_000_000_000);
        attacker.approveSale();
    }

    /// Refunding from inside the callback cannot produce a card-and-money outcome: the
    /// reentrant refund succeeds, but `markFulfilled` then finds the order REFUNDED and
    /// reverts the whole transaction, unwinding the mint with it.
    function test_reentrantRefundDuringMintUnwindsEverything_SOUND() public {
        uint256 id = attacker.buyPack(MACHINE);
        attacker.armRefund(id);

        vm.warp(sale.getOrder(id).deadline + 1); // make the order refundable

        vm.prank(workerKey);
        vm.expectRevert(
            abi.encodeWithSelector(PackSale.OrderNotPending.selector, id, PackSale.OrderStatus.REFUNDED)
        );
        fulfiller.fulfill(id, address(attacker), _meta(), "ipfs://card", keccak256("s"));

        // Nothing moved: still PENDING, still escrowed, no token.
        assertEq(uint8(sale.getOrder(id).status), uint8(PackSale.OrderStatus.PENDING));
        assertEq(sale.escrowedUsdg(), PRICE);
        assertEq(mirror.mintedForOrder(id), 0);
    }

    /// FINDING N5 (informational): the buyer DOES already own the token during the callback
    /// and can burn it there. The order still settles and escrow still releases, so there is
    /// no financial gain — but `UnwrapRequested` is emitted BEFORE `Minted` and before
    /// `OrderFulfilled`, for a token the indexer has not yet seen.
    function test_buyerCanUnwrapInsideTheMintCallback_FINDING() public {
        uint256 id = attacker.buyPack(MACHINE);
        attacker.armUnwrap();

        vm.prank(workerKey);
        uint256 tokenId = fulfiller.fulfill(id, address(attacker), _meta(), "ipfs://card", keccak256("s"));

        // The order completed and the house was paid...
        assertEq(uint8(sale.getOrder(id).status), uint8(PackSale.OrderStatus.FULFILLED));
        assertEq(usdg.balanceOf(treasury), PRICE);
        // ...but the mirror the transaction just minted no longer exists.
        vm.expectRevert();
        mirror.ownerOf(tokenId);
        assertTrue(attacker.unwrapped());
    }
}

contract ReentrantBuyer {
    PackSale private immutable sale;
    MirrorNFT private immutable mirror;

    uint256 private refundOrderId;
    bool private doUnwrap;
    bool public unwrapped;

    constructor(PackSale sale_, MirrorNFT mirror_) {
        sale = sale_;
        mirror = mirror_;
    }

    function approveSale() external {
        IERC20Min(address(sale.usdg())).approve(address(sale), type(uint256).max);
    }

    function buyPack(bytes32 machineId) external returns (uint256) {
        return sale.buy(machineId);
    }

    function armRefund(uint256 orderId) external {
        refundOrderId = orderId;
    }

    function armUnwrap() external {
        doUnwrap = true;
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        if (refundOrderId != 0) {
            uint256 id = refundOrderId;
            refundOrderId = 0;
            sale.refund(id);
        }
        if (doUnwrap) {
            doUnwrap = false;
            unwrapped = true;
            MirrorNFT.UnwrapQuote memory q;
            mirror.burnForUnwrap(tokenId, abi.encodePacked(keccak256("sol")), q, "");
        }
        return this.onERC721Received.selector;
    }
}

interface IERC20Min {
    function approve(address, uint256) external returns (bool);
}
