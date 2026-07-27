// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaseTest} from "./Base.t.sol";
import {PackSale} from "../src/PackSale.sol";
import {MirrorNFT} from "../src/MirrorNFT.sol";
import {Fulfiller} from "../src/Fulfiller.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {stdStorage, StdStorage} from "forge-std/Test.sol";

/// @notice The Fulfiller exists so mint and markFulfilled cannot diverge. These tests are
///         about that guarantee, not about either contract's own rules.
contract FulfillerTest is BaseTest {
    using stdStorage for StdStorage;

    function test_fulfill_mintsAndReleasesInOneTx() public {
        uint256 orderId = _buy(alice);

        vm.prank(workerKey);
        uint256 tokenId = fulfiller.fulfill(orderId, alice, _meta(), "ipfs://card", keccak256("sig"));

        assertEq(mirror.ownerOf(tokenId), alice);
        assertEq(uint8(sale.getOrder(orderId).status), uint8(PackSale.OrderStatus.FULFILLED));
        assertEq(usdg.balanceOf(treasury), PRICE);
    }

    /// If markFulfilled reverts, the mint must roll back with it — no orphan cards.
    function test_fulfill_revertsAtomically_whenOrderAlreadyTerminal() public {
        uint256 orderId = _buy(alice);
        vm.warp(block.timestamp + 11 minutes);
        sale.refund(orderId);

        vm.prank(workerKey);
        vm.expectRevert();
        fulfiller.fulfill(orderId, alice, _meta(), "ipfs://card", keccak256("sig"));

        // The mint inside that call must have been rolled back.
        assertEq(mirror.mintedForOrder(orderId), 0, "no orphan mint survived the revert");
        assertEq(mirror.nextTokenId(), 1, "no token id was consumed");
    }

    /// A worker-side mix-up must fail loudly, not mint to the wrong person — there is no
    /// clawback for a mis-minted card.
    function test_fulfill_buyerMismatch_reverts() public {
        uint256 orderId = _buy(alice);

        vm.prank(workerKey);
        vm.expectRevert(abi.encodeWithSelector(Fulfiller.BuyerMismatch.selector, bob, alice));
        fulfiller.fulfill(orderId, bob, _meta(), "ipfs://card", keccak256("sig"));

        assertEq(mirror.mintedForOrder(orderId), 0);
    }

    function test_fulfill_byNonCaller_reverts() public {
        uint256 orderId = _buy(alice);

        vm.prank(stranger);
        vm.expectRevert(Fulfiller.NotCaller.selector);
        fulfiller.fulfill(orderId, alice, _meta(), "ipfs://card", keccak256("sig"));
    }

    function test_burnAfterSell_onlyCaller() public {
        uint256 orderId = _buy(alice);
        uint256 tokenId = _fulfill(orderId, alice);

        vm.prank(stranger);
        vm.expectRevert(Fulfiller.NotCaller.selector);
        fulfiller.burnAfterSell(tokenId);

        // A sell-back begins with the holder surrendering the mirror to custody. That
        // transfer is the consent, and it is what makes the token burnable at all.
        _surrender(tokenId, alice);
        vm.prank(workerKey);
        fulfiller.burnAfterSell(tokenId);
        assertEq(mirror.balanceOf(custody), 0, "burned out of custody, not out of a wallet");
    }

    // ------------------------------------------------------------ key rotation

    function test_setCaller_rotatesWorkerKey() public {
        address newWorker = makeAddr("newWorker");

        vm.prank(owner);
        fulfiller.setCaller(newWorker);

        uint256 orderId = _buy(alice);

        vm.prank(workerKey);
        vm.expectRevert(Fulfiller.NotCaller.selector);
        fulfiller.fulfill(orderId, alice, _meta(), "ipfs://card", keccak256("sig"));

        vm.prank(newWorker);
        fulfiller.fulfill(orderId, alice, _meta(), "ipfs://card", keccak256("sig"));
    }

    function test_setCaller_byNonOwner_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        fulfiller.setCaller(stranger);
    }

    /// The Fulfiller is a permission holder, not a vault. It must never accumulate value.
    function test_fulfiller_holdsNoFunds() public {
        uint256 orderId = _buy(alice);
        _fulfill(orderId, alice);

        assertEq(usdg.balanceOf(address(fulfiller)), 0);
        assertEq(mirror.balanceOf(address(fulfiller)), 0);
    }

    /* ------------------------------------------------------------------ deposits
     *
     * A deposited card has no PackSale order and no escrow. It borrows MirrorNFT's
     * one-mint-per-order-id guarantee via a synthetic id, so these tests are about that
     * borrowing being safe — specifically, that it can never cost a real buyer their pack.
     */

    bytes32 constant MINT_HASH = keccak256("SolanaMintAddressOfADepositedCard");

    function test_mintForDeposit_mintsWithoutAnOrder() public {
        uint256 depositId = fulfiller.DEPOSIT_ID_BASE() + 1;

        vm.prank(workerKey);
        uint256 tokenId = fulfiller.mintForDeposit(alice, depositId, MINT_HASH, _meta(), "ipfs://dep");

        assertEq(mirror.ownerOf(tokenId), alice, "the depositor holds the mirror");
        assertEq(fulfiller.mintedForDeposit(MINT_HASH), tokenId, "the card is recorded as mirrored");
        // No order was touched: PackSale must be exactly as it was.
        assertEq(sale.nextOrderId(), 1, "no PackSale order was consumed");
    }

    /// The Solana card is the identity that must be unique. A retry under a DIFFERENT deposit
    /// id must still refuse, or one physical card backs two mirrors.
    function test_mintForDeposit_sameCardTwice_reverts() public {
        uint256 base = fulfiller.DEPOSIT_ID_BASE();

        vm.prank(workerKey);
        fulfiller.mintForDeposit(alice, base + 1, MINT_HASH, _meta(), "ipfs://dep");

        vm.prank(workerKey);
        vm.expectRevert();
        fulfiller.mintForDeposit(alice, base + 2, MINT_HASH, _meta(), "ipfs://dep");
    }

    /// THE ONE THAT MATTERS. A deposit id below the base could collide with a real order id,
    /// and MirrorNFT refuses a second mint for an id — so that buyer's pack could never mint.
    function test_mintForDeposit_belowBase_reverts() public {
        vm.prank(workerKey);
        vm.expectRevert();
        fulfiller.mintForDeposit(alice, 7, MINT_HASH, _meta(), "ipfs://dep");
    }

    /// And the same protection, checked against LIVE PackSale state rather than a constant, so
    /// it still holds however far the order counter climbs.
    function test_mintForDeposit_refusesOnceRealOrdersReachTheBase() public {
        uint256 base = fulfiller.DEPOSIT_ID_BASE();
        // Force PackSale's counter into deposit territory.
        stdstore.target(address(sale)).sig("nextOrderId()").checked_write(base);

        vm.prank(workerKey);
        vm.expectRevert();
        fulfiller.mintForDeposit(alice, base + 1, MINT_HASH, _meta(), "ipfs://dep");
    }

    function test_mintForDeposit_onlyCaller() public {
        uint256 depositId = fulfiller.DEPOSIT_ID_BASE() + 1;
        vm.prank(alice);
        vm.expectRevert();
        fulfiller.mintForDeposit(alice, depositId, MINT_HASH, _meta(), "ipfs://dep");
    }

    function test_mintForDeposit_toZero_reverts() public {
        uint256 depositId = fulfiller.DEPOSIT_ID_BASE() + 1;
        vm.prank(workerKey);
        vm.expectRevert();
        fulfiller.mintForDeposit(address(0), depositId, MINT_HASH, _meta(), "ipfs://dep");
    }

    /// Packs must keep working unchanged alongside deposits — this is a live system.
    function test_deposits_doNotDisturbNormalFulfilment() public {
        // Read the base BEFORE the prank: vm.prank applies to the next call, and an external
        // getter in the argument list would consume it.
        uint256 depositId = fulfiller.DEPOSIT_ID_BASE() + 1;

        vm.prank(workerKey);
        fulfiller.mintForDeposit(alice, depositId, MINT_HASH, _meta(), "ipfs://dep");

        uint256 orderId = _buy(bob);
        vm.prank(workerKey);
        uint256 tokenId = fulfiller.fulfill(orderId, bob, _meta(), "ipfs://card", keccak256("sig"));

        assertEq(mirror.ownerOf(tokenId), bob, "a real pack still mints to its buyer");
        assertEq(uint8(sale.getOrder(orderId).status), uint8(PackSale.OrderStatus.FULFILLED));
    }
}
