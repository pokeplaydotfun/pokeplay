// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {PackSale} from "../src/PackSale.sol";
import {MirrorNFT} from "../src/MirrorNFT.sol";
import {Fulfiller} from "../src/Fulfiller.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";

/// @notice Drives the system through random orderings of every lifecycle action, tracking
///         enough state on the side to check the two properties users actually rely on:
///         escrow is always fully backed, and no order is ever served twice.
contract SystemHandler is Test {
    PackSale public sale;
    MirrorNFT public mirror;
    Fulfiller public fulfiller;
    MockUSDG public usdg;

    address public owner;
    address public worker;
    address public drawer;
    bytes32 public machine;

    uint256[] public orderIds;
    mapping(uint256 => bool) public sawFulfilled;
    mapping(uint256 => bool) public sawRefunded;

    /// Set if any order was ever observed in two terminal states — the thing that must
    /// never happen, recorded rather than asserted so the fuzzer keeps exploring.
    bool public doubleTerminalDetected;

    address[] public buyers;

    constructor(
        PackSale sale_,
        MirrorNFT mirror_,
        Fulfiller fulfiller_,
        MockUSDG usdg_,
        address owner_,
        address worker_,
        address drawer_,
        bytes32 machine_
    ) {
        sale = sale_;
        mirror = mirror_;
        fulfiller = fulfiller_;
        usdg = usdg_;
        owner = owner_;
        worker = worker_;
        drawer = drawer_;
        machine = machine_;

        for (uint256 i = 0; i < 4; i++) {
            address b = address(uint160(uint256(keccak256(abi.encode("buyer", i)))));
            buyers.push(b);
            usdg.mint(b, 100_000_000_000);
            vm.prank(b);
            usdg.approve(address(sale), type(uint256).max);
        }
    }

    function _buyer(uint256 seed) internal view returns (address) {
        return buyers[seed % buyers.length];
    }

    function _order(uint256 seed) internal view returns (uint256) {
        if (orderIds.length == 0) return 0;
        return orderIds[seed % orderIds.length];
    }

    function buy(uint256 seed) external {
        vm.prank(_buyer(seed));
        try sale.buy(machine) returns (uint256 id) {
            orderIds.push(id);
        } catch {}
    }

    function fulfill(uint256 seed) external {
        uint256 id = _order(seed);
        if (id == 0) return;
        PackSale.Order memory o = sale.getOrder(id);

        MirrorNFT.CardMeta memory meta = MirrorNFT.CardMeta({
            solanaMintHash: keccak256(abi.encode("mint", id)),
            ccOpenTxHash: keccak256(abi.encode("sig", id)),
            revealAt: uint64(block.timestamp),
            userWindowEndsAt: uint64(block.timestamp + 66 hours),
            ccWindowEndsAt: uint64(block.timestamp + 72 hours)
        });

        vm.prank(worker);
        try fulfiller.fulfill(id, o.buyer, meta, "ipfs://x", keccak256("sig")) {
            if (sawRefunded[id]) doubleTerminalDetected = true;
            sawFulfilled[id] = true;
        } catch {}
    }

    function refund(uint256 seed) external {
        uint256 id = _order(seed);
        if (id == 0) return;
        try sale.refund(id) {
            if (sawFulfilled[id] || sawRefunded[id]) doubleTerminalDetected = true;
            sawRefunded[id] = true;
        } catch {}
    }

    function forceRefund(uint256 seed) external {
        uint256 id = _order(seed);
        if (id == 0) return;
        vm.prank(owner);
        try sale.forceRefund(id, "fuzz") {
            if (sawFulfilled[id] || sawRefunded[id]) doubleTerminalDetected = true;
            sawRefunded[id] = true;
        } catch {}
    }

    /// The buyer's own payment leaving escrow to fund the pack purchase.
    function drawForOpen(uint256 seed) external {
        uint256 id = _order(seed);
        if (id == 0) return;
        vm.prank(drawer);
        try sale.drawForOpen(id) {} catch {}
    }

    /// The drawer freeing the slot of a drawn order it can no longer fulfil. Added 20 Jul
    /// 2026: this shipped alongside drawForOpen but was never driven by the fuzzer, so the
    /// openOrderCount and escrow invariants had no coverage of the path that changes an
    /// order's terminal state WITHOUT moving any tokens.
    function closeDrawnOrder(uint256 seed) external {
        uint256 id = _order(seed);
        if (id == 0) return;
        vm.prank(drawer);
        try sale.closeDrawnOrder(id, "fuzz-close") {
            if (sawFulfilled[id] || sawRefunded[id]) doubleTerminalDetected = true;
            sawRefunded[id] = true;
        } catch {}
    }

    function warp(uint256 seconds_) external {
        vm.warp(block.timestamp + (seconds_ % 6 hours) + 1);
    }

    function pause() external {
        vm.prank(owner);
        try sale.pause() {} catch {}
    }

    function unpause() external {
        vm.prank(owner);
        try sale.unpause() {} catch {}
    }

    function orderCount() external view returns (uint256) {
        return orderIds.length;
    }

    function orderAt(uint256 i) external view returns (uint256) {
        return orderIds[i];
    }
}

contract InvariantsTest is StdInvariant, Test {
    MockUSDG internal usdg;
    MirrorNFT internal mirror;
    PackSale internal sale;
    Fulfiller internal fulfiller;
    SystemHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal guardian = makeAddr("guardian");
    address internal worker = makeAddr("worker");
    address internal drawerEoa = makeAddr("drawerEoa");
    bytes32 internal constant MACHINE = keccak256("cc-elite-50");

    function setUp() public {
        usdg = new MockUSDG();
        mirror = new MirrorNFT(address(usdg), owner, address(this), treasury);
        sale = new PackSale(address(usdg), address(mirror), owner, address(this), guardian, treasury, 55_000_000);
        fulfiller = new Fulfiller(address(sale), address(mirror), owner, worker);

        vm.startPrank(owner);
        mirror.setOperator(address(fulfiller));
        sale.setOperator(address(fulfiller));
        sale.setMachine(MACHINE, 50_000_000, true);
        sale.setCaps(1_000_000, 55_000_000, 1_000_000); // lift caps; they are tested elsewhere
        sale.setDrawer(drawerEoa);
        vm.stopPrank();

        handler = new SystemHandler(sale, mirror, fulfiller, usdg, owner, worker, drawerEoa, MACHINE);
        targetContract(address(handler));
    }

    /// Every USDG the contract holds is owed to a specific pending buyer. If this drifts,
    /// someone's refund is being funded by someone else's escrow.
    function invariant_escrowIsFullyBacked() public view {
        assertGe(usdg.balanceOf(address(sale)), sale.escrowedUsdg());
    }

    /// escrowedUsdg must equal the sum of still-pending order prices — not merely be
    /// covered by the balance.
    function invariant_escrowEqualsSumOfPendingOrders() public view {
        uint256 expected;
        uint256 n = handler.orderCount();
        for (uint256 i = 0; i < n; i++) {
            PackSale.Order memory o = sale.getOrder(handler.orderAt(i));
            if (o.status == PackSale.OrderStatus.PENDING && !o.drawn) expected += o.price;
        }
        assertEq(sale.escrowedUsdg(), expected);
    }

    /// No order is ever both served and refunded, by any path or ordering.
    function invariant_noDoubleTerminalState() public view {
        assertFalse(handler.doubleTerminalDetected());
    }

    /// openOrderCount must match reality, or the flood cap silently stops working.
    function invariant_openOrderCountMatchesPendingOrders() public view {
        uint256 pending;
        uint256 n = handler.orderCount();
        for (uint256 i = 0; i < n; i++) {
            if (sale.getOrder(handler.orderAt(i)).status == PackSale.OrderStatus.PENDING) pending++;
        }
        assertEq(sale.openOrderCount(), pending);
    }

    /// A refunded order must never have a mirror against it — that is exactly the case
    /// forceRefund's mintedForOrder check exists to prevent.
    function invariant_refundedOrdersHaveNoMirror() public view {
        uint256 n = handler.orderCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.orderAt(i);
            if (sale.getOrder(id).status == PackSale.OrderStatus.REFUNDED) {
                assertEq(mirror.mintedForOrder(id), 0);
            }
        }
    }
}
