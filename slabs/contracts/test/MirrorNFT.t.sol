// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaseTest} from "./Base.t.sol";
import {MirrorNFT} from "../src/MirrorNFT.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Doc 03 §4.5 — one-mint-per-order, burn paths, unwrap fee math and EIP-712
///         quote verification.
contract MirrorNFTTest is BaseTest {
    function setUp() public override {
        super.setUp();
        // Take the operator role directly so these tests can mint without the Fulfiller.
        vm.prank(owner);
        mirror.setOperator(address(this));
    }

    function _mintTo(address to, uint256 orderId) internal returns (uint256) {
        return mirror.mint(to, orderId, _meta(), "ipfs://card");
    }

    // ------------------------------------------------------------ minting

    function test_mint_recordsMetaAndOrderMapping() public {
        uint256 tokenId = _mintTo(alice, 42);

        assertEq(mirror.ownerOf(tokenId), alice);
        assertEq(mirror.mintedForOrder(42), tokenId);
        assertEq(mirror.orderOfToken(tokenId), 42);
        assertEq(mirror.tokenURI(tokenId), "ipfs://card");

        MirrorNFT.CardMeta memory m = mirror.cardMeta(tokenId);
        assertEq(m.ccOpenTxHash, keccak256("cc-open-sig"));
        assertEq(m.userWindowEndsAt, uint64(block.timestamp + 66 hours));
        assertEq(m.ccWindowEndsAt, uint64(block.timestamp + 72 hours));
    }

    function test_mint_twiceForSameOrder_reverts() public {
        _mintTo(alice, 42);
        vm.expectRevert(abi.encodeWithSelector(MirrorNFT.OrderAlreadyMinted.selector, 42));
        _mintTo(bob, 42);
    }

    function test_mint_byNonOperator_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(MirrorNFT.NotOperator.selector);
        _mintTo(alice, 42);
    }

    function test_mint_tokenIdsIncrement() public {
        assertEq(_mintTo(alice, 1), 1);
        assertEq(_mintTo(alice, 2), 2);
        assertEq(_mintTo(bob, 3), 3);
    }

    // ------------------------------------------------------------ transfers

    /// Mirrors are tradeable and the buyback right follows the holder — but the windows
    /// are absolute timestamps and must not reset on transfer.
    function test_transfer_doesNotResetWindows() public {
        uint256 tokenId = _mintTo(alice, 1);
        uint64 windowBefore = mirror.cardMeta(tokenId).userWindowEndsAt;

        vm.warp(block.timestamp + 10 hours);
        vm.prank(alice);
        mirror.transferFrom(alice, bob, tokenId);

        assertEq(mirror.ownerOf(tokenId), bob);
        assertEq(mirror.cardMeta(tokenId).userWindowEndsAt, windowBefore);
    }

    // ------------------------------------------------------------ burnForSell

    function test_burnForSell_byOperator() public {
        uint256 tokenId = _mintTo(alice, 1);
        _surrender(tokenId, alice);
        mirror.burnForSell(tokenId);

        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, tokenId));
        mirror.ownerOf(tokenId);
    }

    function test_burnForSell_byNonOperator_reverts() public {
        uint256 tokenId = _mintTo(alice, 1);
        vm.prank(alice);
        vm.expectRevert(MirrorNFT.NotOperator.selector);
        mirror.burnForSell(tokenId);
    }

    /// The mapping must survive the burn — it is what PackSale.forceRefund reads.
    function test_burnForSell_preservesMintedForOrder() public {
        uint256 tokenId = _mintTo(alice, 42);
        _surrender(tokenId, alice);
        mirror.burnForSell(tokenId);
        assertEq(mirror.mintedForOrder(42), tokenId);
    }

    // ------------------------------------------------------------ unwrap, fee off (launch)

    function test_unwrap_freeByDefault() public {
        uint256 tokenId = _mintTo(alice, 1);
        assertEq(mirror.unwrapFeeBps(), 0, "launch default is free");

        MirrorNFT.UnwrapQuote memory empty;
        vm.prank(alice);
        mirror.burnForUnwrap(tokenId, _solanaAddr(), empty, "");

        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, tokenId));
        mirror.ownerOf(tokenId);
        assertEq(usdg.balanceOf(treasury), 0, "no fee taken");
    }

    function test_unwrap_byNonOwner_reverts() public {
        uint256 tokenId = _mintTo(alice, 1);
        MirrorNFT.UnwrapQuote memory empty;

        vm.prank(bob);
        vm.expectRevert(MirrorNFT.NotTokenOwner.selector);
        mirror.burnForUnwrap(tokenId, _solanaAddr(), empty, "");
    }

    function test_unwrap_rejectsMalformedSolanaAddress() public {
        uint256 tokenId = _mintTo(alice, 1);
        MirrorNFT.UnwrapQuote memory empty;

        vm.prank(alice);
        vm.expectRevert(MirrorNFT.InvalidSolanaAddress.selector);
        mirror.burnForUnwrap(tokenId, hex"1234", empty, "");
    }

    // ------------------------------------------- unwrap, fee on (only if doc 01 T3 demands)

    function _enableFee() internal {
        vm.prank(owner);
        mirror.setUnwrapFeeBps(500);
    }

    function test_unwrap_withFee_chargesFivePercentOfInsuredValue() public {
        _enableFee();
        uint256 tokenId = _mintTo(alice, 1);

        uint256 insured = 52_000_000; // $52
        (MirrorNFT.UnwrapQuote memory q, bytes memory sig) = _signQuote(tokenId, insured, block.timestamp + 300);

        vm.startPrank(alice);
        usdg.approve(address(mirror), type(uint256).max);
        mirror.burnForUnwrap(tokenId, _solanaAddr(), q, sig);
        vm.stopPrank();

        assertEq(usdg.balanceOf(treasury), 2_600_000, "5% of $52 = $2.60");
    }

    /// After CC's own 72h window closes there is nothing left to bypass, so unwrapping is
    /// free even with the fee configured on.
    function test_unwrap_afterCcWindow_isFreeEvenWithFeeOn() public {
        _enableFee();
        uint256 tokenId = _mintTo(alice, 1);

        vm.warp(block.timestamp + 73 hours);

        MirrorNFT.UnwrapQuote memory empty;
        vm.prank(alice);
        mirror.burnForUnwrap(tokenId, _solanaAddr(), empty, "");

        assertEq(usdg.balanceOf(treasury), 0);
    }

    function test_unwrap_expiredQuote_reverts() public {
        _enableFee();
        uint256 tokenId = _mintTo(alice, 1);

        uint256 expiry = block.timestamp + 60;
        (MirrorNFT.UnwrapQuote memory q, bytes memory sig) = _signQuote(tokenId, 52_000_000, expiry);

        vm.warp(expiry + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MirrorNFT.QuoteExpired.selector, expiry));
        mirror.burnForUnwrap(tokenId, _solanaAddr(), q, sig);
    }

    function test_unwrap_wrongSigner_reverts() public {
        _enableFee();
        uint256 tokenId = _mintTo(alice, 1);

        (, uint256 impostorPk) = makeAddrAndKey("impostor");
        (MirrorNFT.UnwrapQuote memory q,) = _signQuote(tokenId, 52_000_000, block.timestamp + 300);

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("UnwrapQuote(uint256 tokenId,uint256 insuredValueUsdg,uint256 expiry)"),
                q.tokenId,
                q.insuredValueUsdg,
                q.expiry
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(impostorPk, digest);

        vm.prank(alice);
        vm.expectRevert();
        mirror.burnForUnwrap(tokenId, _solanaAddr(), q, abi.encodePacked(r, s, v));
    }

    /// A signed quote for a cheap card must not be replayed against an expensive one.
    function test_unwrap_quoteForDifferentToken_reverts() public {
        _enableFee();
        uint256 cheap = _mintTo(alice, 1);
        uint256 pricey = _mintTo(alice, 2);

        (MirrorNFT.UnwrapQuote memory q, bytes memory sig) = _signQuote(cheap, 1_000_000, block.timestamp + 300);

        vm.prank(alice);
        vm.expectRevert(MirrorNFT.QuoteTokenMismatch.selector);
        mirror.burnForUnwrap(pricey, _solanaAddr(), q, sig);
    }

    function test_unwrap_withFee_butNoApproval_reverts() public {
        _enableFee();
        uint256 tokenId = _mintTo(alice, 1);
        (MirrorNFT.UnwrapQuote memory q, bytes memory sig) = _signQuote(tokenId, 52_000_000, block.timestamp + 300);

        vm.prank(alice);
        vm.expectRevert();
        mirror.burnForUnwrap(tokenId, _solanaAddr(), q, sig);
    }

    function test_previewUnwrapFee_matchesCharged() public {
        _enableFee();
        uint256 tokenId = _mintTo(alice, 1);
        assertEq(mirror.previewUnwrapFee(tokenId, 52_000_000), 2_600_000);

        vm.warp(block.timestamp + 73 hours);
        assertEq(mirror.previewUnwrapFee(tokenId, 52_000_000), 0, "free after CC window");
    }

    // ------------------------------------------------------------ fee ceiling

    function test_setUnwrapFee_aboveFivePercent_reverts() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MirrorNFT.FeeAboveMax.selector, 501));
        mirror.setUnwrapFeeBps(501);
    }

    function test_setUnwrapFee_byNonOwner_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        mirror.setUnwrapFeeBps(100);
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_unwrapFee_neverExceedsFivePercent(uint96 insuredValue) public {
        _enableFee();
        uint256 tokenId = _mintTo(alice, 1);
        uint256 fee = mirror.previewUnwrapFee(tokenId, insuredValue);
        assertLe(fee, uint256(insuredValue) * 500 / 10_000);
    }
}

