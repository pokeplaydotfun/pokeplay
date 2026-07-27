// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PackSale} from "../src/PackSale.sol";
import {MirrorNFT} from "../src/MirrorNFT.sol";
import {Fulfiller} from "../src/Fulfiller.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";
import {SystemHandler} from "./Invariants.t.sol";

/// @notice Guards the invariant suite against going vacuous. Every handler action swallows
///         reverts by design, so a wiring mistake could leave the fuzzer spinning on
///         no-ops while every invariant "passes". This drives the handler by hand and
///         asserts each terminal state is actually reachable.
contract InvariantCoverageTest is Test {
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
        sale.setCaps(1_000_000, 55_000_000, 1_000_000);
        sale.setDrawer(drawerEoa);
        vm.stopPrank();

        handler = new SystemHandler(sale, mirror, fulfiller, usdg, owner, worker, drawerEoa, MACHINE);
    }

    function test_handlerReachesEveryTerminalState() public {
        // buy is live
        handler.buy(0);
        assertEq(handler.orderCount(), 1, "buy() did not create an order");
        uint256 first = handler.orderAt(0);
        assertEq(uint8(sale.getOrder(first).status), uint8(PackSale.OrderStatus.PENDING));

        // fulfill is live
        handler.fulfill(0);
        assertEq(
            uint8(sale.getOrder(first).status),
            uint8(PackSale.OrderStatus.FULFILLED),
            "fulfill() never succeeds: invariants would be vacuous"
        );
        assertEq(mirror.mintedForOrder(first), 1);

        // refund is live
        handler.buy(1);
        uint256 second = handler.orderAt(1);
        handler.warp(1 hours);
        handler.refund(1);
        assertEq(uint8(sale.getOrder(second).status), uint8(PackSale.OrderStatus.REFUNDED), "refund() never succeeds");

        // forceRefund is live
        handler.buy(2);
        uint256 third = handler.orderAt(2);
        handler.warp(3 hours);
        handler.warp(3 hours);
        handler.forceRefund(2);
        assertEq(
            uint8(sale.getOrder(third).status), uint8(PackSale.OrderStatus.REFUNDED), "forceRefund() never succeeds"
        );

        // pause is live
        handler.pause();
        assertTrue(sale.paused(), "pause() never takes effect");
        handler.unpause();
        assertFalse(sale.paused(), "unpause() never takes effect");

        assertFalse(handler.doubleTerminalDetected());
    }
}
