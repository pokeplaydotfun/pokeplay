// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PackSale} from "../src/PackSale.sol";
import {MirrorNFT} from "../src/MirrorNFT.sol";
import {Fulfiller} from "../src/Fulfiller.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";

/// @notice Shared fixture: deployed system with roles wired exactly as doc 06 §4 requires —
///         owner and operator are DIFFERENT keys, because the whole point of forceRefund
///         being onlyOwner is that the worker cannot reach it.
abstract contract BaseTest is Test {
    MockUSDG internal usdg;
    MirrorNFT internal mirror;
    PackSale internal sale;
    Fulfiller internal fulfiller;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");
    /// Where a seller surrenders their mirror to start a sell-back. Only mirrors sitting here
    /// can be burned, so a token in a user's own wallet is never destroyable.
    address internal custody = makeAddr("custody");

    // The worker's hot key. Signs fulfilments and unwrap quotes; never holds the owner key.
    address internal workerKey;
    uint256 internal workerPk;

    bytes32 internal constant MACHINE = keccak256("cc-elite-50");
    uint96 internal constant PRICE = 50_000_000; // 50 USDG, 6dp
    uint96 internal constant MAX_PRICE = 55_000_000;

    function setUp() public virtual {
        (workerKey, workerPk) = makeAddrAndKey("worker");

        usdg = new MockUSDG();

        // Deploy order matters: MirrorNFT first, since PackSale takes it immutably.
        mirror = new MirrorNFT(address(usdg), owner, address(this), treasury);
        sale = new PackSale(address(usdg), address(mirror), owner, address(this), guardian, treasury, MAX_PRICE);
        fulfiller = new Fulfiller(address(sale), address(mirror), owner, workerKey);

        // Hand the operator role on both contracts to the Fulfiller, so mint+markFulfilled
        // are only ever reachable together.
        vm.startPrank(owner);
        mirror.setOperator(address(fulfiller));
        // Quote signing stays with the worker EOA — a contract cannot sign EIP-712.
        mirror.setQuoteSigner(workerKey);
        mirror.setCustodian(custody);
        sale.setOperator(address(fulfiller));
        sale.setMachine(MACHINE, PRICE, true);
        vm.stopPrank();

        usdg.mint(alice, 1_000_000_000);
        usdg.mint(bob, 1_000_000_000);
        vm.prank(alice);
        usdg.approve(address(sale), type(uint256).max);
        vm.prank(bob);
        usdg.approve(address(sale), type(uint256).max);
    }

    /// The seller's half of a sell-back: hand the mirror to custody. That transfer IS the
    /// consent, and it is what makes the token burnable.
    function _surrender(uint256 tokenId, address from) internal {
        vm.prank(from);
        mirror.transferFrom(from, custody, tokenId);
    }

    // -------------------------------------------------------------- helpers

    function _buy(address who) internal returns (uint256 orderId) {
        vm.prank(who);
        orderId = sale.buy(MACHINE);
    }

    /// A fresh, funded buyer.
    ///
    /// Needed because the per-buyer open-order cap means one address can no longer occupy
    /// every slot — which is the entire point of it. Tests that exercise the GLOBAL cap have
    /// to spread across distinct addresses now, exactly as real traffic would.
    function _funded(string memory label) internal returns (address who) {
        who = makeAddr(label);
        usdg.mint(who, 1_000_000_000);
        vm.prank(who);
        usdg.approve(address(sale), type(uint256).max);
    }

    function _meta() internal view returns (MirrorNFT.CardMeta memory) {
        return MirrorNFT.CardMeta({
            solanaMintHash: keccak256("solana-mint"),
            ccOpenTxHash: keccak256("cc-open-sig"),
            revealAt: uint64(block.timestamp),
            userWindowEndsAt: uint64(block.timestamp + 66 hours),
            ccWindowEndsAt: uint64(block.timestamp + 72 hours)
        });
    }

    function _fulfill(uint256 orderId, address buyer) internal returns (uint256 tokenId) {
        vm.prank(workerKey);
        tokenId = fulfiller.fulfill(orderId, buyer, _meta(), "ipfs://card", keccak256("cc-open-sig"));
    }

    /// @dev Signs an UnwrapQuote as the current quoteSigner (the worker key by default).
    function _signQuote(uint256 tokenId, uint256 insuredValue, uint256 expiry)
        internal
        view
        returns (MirrorNFT.UnwrapQuote memory quote, bytes memory sig)
    {
        quote = MirrorNFT.UnwrapQuote({tokenId: tokenId, insuredValueUsdg: insuredValue, expiry: expiry});

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("UnwrapQuote(uint256 tokenId,uint256 insuredValueUsdg,uint256 expiry)"),
                quote.tokenId,
                quote.insuredValueUsdg,
                quote.expiry
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(workerPk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function _domainSeparator() internal view returns (bytes32) {
        (, string memory name, string memory version,, address verifyingContract,,) = mirror.eip712Domain();
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                block.chainid,
                verifyingContract
            )
        );
    }

    function _solanaAddr() internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256("solana-destination-pubkey"));
    }
}
