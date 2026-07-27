// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MirrorNFT} from "./MirrorNFT.sol";

/// @title PackSale
/// @notice Takes USDG for a configured Collector Crypt machine, holds it until the pack is
///         fulfilled or the order times out, and enforces the launch caps.
/// @dev    Doc 03 §1. Thin, boring, capped: this contract decides almost nothing. Its only
///         job is that user funds are never stranded and never double-spent — an order is
///         FULFILLED xor REFUNDED, exactly once, forever.
contract PackSale is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum OrderStatus {
        NONE,
        PENDING,
        FULFILLED,
        REFUNDED
    }

    struct Order {
        address buyer;
        uint96 price; // USDG has 6 decimals; uint96 covers ~7.9e22 units. Packed with buyer.
        bytes32 machineId;
        uint64 createdAt;
        uint64 deadline;
        OrderStatus status;
        /// @notice The operator has taken this order's payment out to fund the pack purchase.
        ///         Once true the contract no longer holds the money, so refund() cannot pay
        ///         it back and reverts. Packs into the slot with createdAt/deadline/status.
        bool drawn;
        /// @notice The buyer asked for a turbo open.
        ///
        /// @dev    Recorded here and echoed in OrderCreated because the worker learns about
        ///         orders from the CHAIN, not from the website. Without this it has no way to
        ///         know an order was meant to be turbo, which is why Turbo could not ship at
        ///         all. Shares the packed slot with `drawn`, so it costs no extra storage.
        bool turbo;
    }

    struct Machine {
        uint96 priceUsdg;
        bool enabled;
    }

    /// @notice Minimum age before the owner-only escape hatch can fire. Deliberately far
    ///         longer than any plausible ORDER_TIMEOUT (10 min) so forceRefund can never
    ///         race a fulfillment that is merely slow. Immutable by design — an operator
    ///         under pressure must not be able to shorten it.
    uint64 public constant FORCE_REFUND_MIN_AGE = 2 hours;

    IERC20 public immutable usdg;
    /// @notice Consulted by forceRefund to prove no mirror was ever minted for an order.
    MirrorNFT public immutable mirror;

    address public operator;
    /// @notice The hot EOA allowed to draw an order's payment out to fund its pack purchase.
    ///
    /// @dev    Deliberately NOT `operator`. In production `operator` is the Fulfiller CONTRACT,
    ///         so that mint and markFulfilled can only ever happen together. A contract cannot
    ///         bridge to Solana; that needs an EOA holding a key. Reusing `operator` here
    ///         would have sent every draw to the Fulfiller, where the money would be stranded.
    address public drawer;
    address public guardian;
    address public revenueRecipient;

    uint64 public orderTimeout = 10 minutes;
    /// @notice Raised from the testing-phase 10, but deliberately NOT unlimited.
    ///
    /// @dev    High enough that it can never constrain real usage: the worker's gas runs out
    ///         after roughly 35 opens, so this ceiling is about 14x further away than the
    ///         binding constraint. It will not get in the way.
    ///
    ///         Low enough to still be a brake. It was briefly set to type(uint32).max on the
    ///         reasoning that the operator no longer fronts pack money (see drawForOpen), so
    ///         volume costs bridge fees and gas rather than principal. That reasoning is
    ///         sound but it was written while drawForOpen was undeployed working-tree code —
    ///         reasoning from a mechanism that is not live is exactly the mistake this
    ///         codebase keeps making.
    ///
    ///         And the argument does not actually survive scrutiny even once the draw ships.
    ///         Uncapped, the worst case is not a runaway bleed: the worker simply exhausts
    ///         its ETH after ~35 opens (~$125 of bridge fees) and then HALTS, with orders
    ///         mid-flight and buyer money sitting in the worker wallet. What a cap really
    ///         bounds is how much damage accumulates before a human notices, and that holds
    ///         no matter who funds the pack.
    ///
    ///         `maxOpenOrders` remains the sharper limit — it bounds how much buyer money is
    ///         in flight at once, and raising it costs working capital rather than gas.
    ///
    ///         Adjustable through setCaps with no redeploy.
    uint32 public dailyPackCap = 500;
    uint96 public maxPackPrice;
    uint32 public maxOpenOrders = 5;

    uint256 public nextOrderId = 1;
    uint256 public openOrderCount;

    /// @notice Open orders per buyer, so one address cannot consume every slot.
    /// @dev    `maxOpenOrders` bounds systemic exposure — how many buyers can sit in the drawn
    ///         state at once, where refund() reverts by design and only the worker can make
    ///         them whole. That bound must stay. What it could not do is stop ONE address
    ///         taking all of it: five concurrent buys closed the storefront for everyone for
    ///         the order timeout, at zero principal cost to the griefer, since every order is
    ///         refunded in full.
    mapping(address => uint32) public openOrdersOf;

    /// @notice Per-buyer cap. 0 disables it, leaving only the global `maxOpenOrders`.
    uint32 public maxOpenOrdersPerBuyer = 2;
    /// @notice USDG owed to buyers of still-pending orders. Every transfer out is checked
    ///         against this so revenue can never be paid from another user's escrow.
    uint256 public escrowedUsdg;

    mapping(uint256 orderId => Order) public orders;
    mapping(bytes32 machineId => Machine) public machines;
    mapping(uint256 utcDay => uint32 count) public dailyCount;

    /// @dev `turbo` is NOT indexed: the worker reads every order anyway, and an extra topic
    ///      costs gas on the hottest event in the system for a filter nobody needs.
    event OrderCreated(
        uint256 indexed orderId,
        address indexed buyer,
        bytes32 indexed machineId,
        uint256 price,
        uint64 deadline,
        bool turbo
    );
    event OrderFulfilled(uint256 indexed orderId, uint256 mirrorTokenId, bytes32 ccTxSigHash);
    event OrderRefunded(uint256 indexed orderId, address indexed buyer, uint256 price);
    /// @notice Payment left escrow to fund the pack purchase. After this the contract holds
    ///         nothing for the order and only the operator can make the buyer whole.
    event OrderDrawn(uint256 indexed orderId, address indexed to, uint256 price);
    event DrawerUpdated(address indexed previous, address indexed next);
    event ForceRefunded(uint256 indexed orderId, address indexed buyer, uint256 price, string reason);
    event MachineUpdated(bytes32 indexed machineId, uint256 priceUsdg, bool enabled);
    event CapsUpdated(uint32 dailyCap, uint96 maxPrice, uint32 maxOpen);
    event PerBuyerCapUpdated(uint32 previous, uint32 current);
    event TimeoutUpdated(uint64 previous, uint64 current);
    event OperatorUpdated(address indexed previous, address indexed current);
    event GuardianUpdated(address indexed previous, address indexed current);
    event RevenueRecipientUpdated(address indexed previous, address indexed current);

    error NotOperator();
    error NotGuardianOrOwner();
    error ZeroAddress();
    error MachineDisabled(bytes32 machineId);
    error PriceAboveMax(uint256 price, uint256 maxPrice);
    error DailyCapReached(uint32 cap);
    error TooManyOpenOrders(uint32 cap);
    /// @notice This buyer already has the maximum number of orders in flight.
    error TooManyOpenOrdersForBuyer(uint32 cap);
    error OrderNotPending(uint256 orderId, OrderStatus status);
    /// @notice This order's payment has already left escrow to fund its pack. The contract
    ///         cannot pay it out a second time, whether as a draw or as a refund.
    error AlreadyDrawn(uint256 orderId);
    error NotDrawer();
    /// @notice This order's payment is still in escrow, so refund() is the correct route.
    error NotDrawn(uint256 orderId);
    error DeadlineNotPassed(uint256 orderId, uint64 deadline);
    error OrderTooYoung(uint256 orderId, uint64 eligibleAt);
    error MirrorAlreadyMinted(uint256 orderId, uint256 tokenId);
    error EmptyReason();
    error UnexpectedTokenBalance();
    error InvalidTimeout();
    error InvalidCaps();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(
        address usdg_,
        address mirror_,
        address owner_,
        address operator_,
        address guardian_,
        address revenueRecipient_,
        uint96 maxPackPrice_
    ) Ownable(owner_) {
        if (usdg_ == address(0) || mirror_ == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        if (operator_ == address(0) || guardian_ == address(0) || revenueRecipient_ == address(0)) {
            revert ZeroAddress();
        }
        usdg = IERC20(usdg_);
        mirror = MirrorNFT(mirror_);
        operator = operator_;
        guardian = guardian_;
        revenueRecipient = revenueRecipient_;
        maxPackPrice = maxPackPrice_;
    }

    // ---------------------------------------------------------------- user

    /// @notice Pay for a pack. Price comes from on-chain machine config, synced from CC's
    ///         live menu by the ops job — never from the caller.
    function buy(bytes32 machineId) external whenNotPaused nonReentrant returns (uint256 orderId) {
        return _buy(machineId, false);
    }

    /// @notice Buy a pack, optionally in turbo mode.
    ///
    /// @dev    Separate entry point rather than a changed signature: every existing caller,
    ///         including the deployed frontend, keeps working unchanged. A turbo Common is
    ///         auto-sold by Collector Crypt into USDC on Solana with no NFT, so the buyer is
    ///         owed money over the inbound bridge rather than a card — the worker needs to
    ///         know which it is BEFORE it opens the pack.
    function buyTurbo(bytes32 machineId) external whenNotPaused nonReentrant returns (uint256 orderId) {
        return _buy(machineId, true);
    }

    function _buy(bytes32 machineId, bool turbo) private returns (uint256 orderId) {
        Machine memory m = machines[machineId];
        if (!m.enabled) revert MachineDisabled(machineId);
        if (m.priceUsdg > maxPackPrice) revert PriceAboveMax(m.priceUsdg, maxPackPrice);

        uint256 today = block.timestamp / 1 days;
        uint32 count = dailyCount[today];
        if (count >= dailyPackCap) revert DailyCapReached(dailyPackCap);
        if (openOrderCount >= maxOpenOrders) revert TooManyOpenOrders(maxOpenOrders);
        if (maxOpenOrdersPerBuyer > 0 && openOrdersOf[msg.sender] >= maxOpenOrdersPerBuyer) {
            revert TooManyOpenOrdersForBuyer(maxOpenOrdersPerBuyer);
        }

        // Balance-diff accounting so a fee-on-transfer USDG can never leave escrow short.
        // Paxos tokens do not take fees today; this makes that assumption non-load-bearing.
        uint256 before = usdg.balanceOf(address(this));
        usdg.safeTransferFrom(msg.sender, address(this), m.priceUsdg);
        uint256 received = usdg.balanceOf(address(this)) - before;
        if (received != m.priceUsdg) revert UnexpectedTokenBalance();

        orderId = nextOrderId++;
        uint64 deadline = uint64(block.timestamp) + orderTimeout;

        orders[orderId] = Order({
            buyer: msg.sender,
            price: m.priceUsdg,
            machineId: machineId,
            createdAt: uint64(block.timestamp),
            deadline: deadline,
            status: OrderStatus.PENDING,
            drawn: false,
            turbo: turbo
        });

        dailyCount[today] = count + 1;
        openOrderCount += 1;
        openOrdersOf[msg.sender] += 1;
        escrowedUsdg += m.priceUsdg;

        emit OrderCreated(orderId, msg.sender, machineId, m.priceUsdg, deadline, turbo);
    }

    /// @notice Reclaim a timed-out order. Callable by ANYONE — a user must never depend on
    ///         us to get their money back. Allowed while paused, deliberately.
    function refund(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        if (o.status != OrderStatus.PENDING) revert OrderNotPending(orderId, o.status);
        if (block.timestamp <= o.deadline) revert DeadlineNotPassed(orderId, o.deadline);
        // The contract no longer holds this money; the operator does. Refunding from here
        // would pay the buyer out of somebody else's escrow.
        if (o.drawn) revert AlreadyDrawn(orderId);

        _settleRefund(o);
        emit OrderRefunded(orderId, o.buyer, o.price);
    }

    // ---------------------------------------------------------------- operator

    /// @notice Take an order's payment out of escrow so it can fund the pack purchase.
    ///
    /// @dev    THE POINT OF THIS FUNCTION. Opening a pack means bridging USDG to Solana and
    ///         buying from Collector Crypt, and a bridge sends from an EOA, not from this
    ///         contract. Without this the operator would have to front the full pack price
    ///         out of its own working capital for every order and wait to be reimbursed at
    ///         markFulfilled. That is capital the operator does not have, and it scales with
    ///         maxOpenOrders rather than with revenue.
    ///
    ///         The buyer's protection is deliberately preserved either side of this call:
    ///
    ///           not drawn -> refund() is permissionless and paid by the contract. This
    ///                        covers every failure BEFORE we commit: machine sold out, bridge
    ///                        quote too expensive, deadline passed, insufficient funds.
    ///           drawn     -> the contract holds nothing, so refund() reverts. The operator
    ///                        now holds the money and refunds directly. This is the same
    ///                        boundary the fulfilment pipeline already treats as
    ///                        must-complete, so no new class of stuck order is created.
    ///
    ///         Drawer-gated and one-shot: a second call reverts, so an order can never be
    ///         drained twice.
    function drawForOpen(uint256 orderId) external nonReentrant {
        if (msg.sender != drawer) revert NotDrawer();
        Order storage o = orders[orderId];
        if (o.status != OrderStatus.PENDING) revert OrderNotPending(orderId, o.status);
        if (o.drawn) revert AlreadyDrawn(orderId);
        /**
         * A draw may NEVER happen once the order is refundable.
         *
         * Without this the "permissionless refund before the draw" guarantee is worthless:
         * nothing bounded WHEN a draw could occur, so the drawer could sit on an expired
         * order for a year, or watch the mempool and front-run the buyer's own refund
         * transaction, converting a fully refundable order into one with no on-chain remedy
         * at all. Found by adversarial review of this function, 19 Jul 2026.
         *
         * There is no legitimate reason to draw an expired order. Past the deadline the only
         * correct action is to refund it, and now that is the only action available.
         */
        if (block.timestamp > o.deadline) revert DeadlineNotPassed(orderId, o.deadline);

        uint256 price = o.price;
        o.drawn = true;
        escrowedUsdg -= price;

        usdg.safeTransfer(msg.sender, price);
        emit OrderDrawn(orderId, msg.sender, price);
    }

    /// @notice Close a DRAWN order that can never be fulfilled, freeing its open-order slot.
    ///
    /// @dev    The other half of drawForOpen, and it is not optional.
    ///
    ///         `openOrderCount` decrements only in markFulfilled and _settleRefund. A drawn
    ///         order that then fails before purchase — the Solana float gate is the documented
    ///         common case, not an exotic one — is refunded to the buyer DIRECTLY by the
    ///         worker, because the contract no longer holds their money. Without this function
    ///         that order stays PENDING forever and keeps its slot. Five of them close the
    ///         storefront for everyone, permanently, with no automated recovery.
    ///
    ///         Safe by construction: a drawn order has no escrow here, so nothing is
    ///         transferred and no other buyer's money can be touched. The drawer calls it
    ///         immediately after paying the buyer back, so the on-chain state matches ours.
    ///
    ///         Deliberately drawer-gated rather than owner-gated: the worker must be able to
    ///         self-heal within seconds. forceRefund remains the owner's 2-hour escape for
    ///         orders that got further, and still works for these.
    function closeDrawnOrder(uint256 orderId, string calldata reason) external nonReentrant {
        if (msg.sender != drawer) revert NotDrawer();
        Order storage o = orders[orderId];
        if (o.status != OrderStatus.PENDING) revert OrderNotPending(orderId, o.status);
        if (!o.drawn) revert NotDrawn(orderId);
        if (bytes(reason).length == 0) revert EmptyReason();

        o.status = OrderStatus.REFUNDED;
        _releaseSlot(o.buyer);
        emit ForceRefunded(orderId, o.buyer, o.price, reason);
    }

    /// @notice Release escrow to the treasury once the mirror is minted. Called atomically
    ///         with the mint by Fulfiller so the two can never diverge.
    /// @dev    Intentionally allowed after the deadline: a slow-but-successful fulfillment
    ///         should complete, not refund. Only an actual refund closes that door.
    function markFulfilled(uint256 orderId, uint256 mirrorTokenId, bytes32 ccTxSigHash)
        external
        onlyOperator
        nonReentrant
    {
        Order storage o = orders[orderId];
        if (o.status != OrderStatus.PENDING) revert OrderNotPending(orderId, o.status);

        uint256 price = o.price;
        bool drawn = o.drawn;
        o.status = OrderStatus.FULFILLED;
        _releaseSlot(o.buyer);

        // A drawn order was already paid out to the operator to fund the pack, and its
        // escrow was decremented then. Paying again here would send money this contract does
        // not have earmarked, draining another order's escrow to do it.
        if (!drawn) {
            escrowedUsdg -= price;
            usdg.safeTransfer(revenueRecipient, price);
        }
        emit OrderFulfilled(orderId, mirrorTokenId, ccTxSigHash);
    }

    // ---------------------------------------------------------------- owner escape hatch

    /// @notice Refund a buyer whose pack opened on Solana but whose mirror mint is
    ///         permanently unrecoverable. Human-triggered only: the worker holds the
    ///         operator key, not the owner key, so automation cannot reach this.
    /// @dev    Doc 06 runbook 6. The card we hold becomes SALVAGE inventory. `reason` is
    ///         permanent and public — write what actually broke.
    function forceRefund(uint256 orderId, string calldata reason) external onlyOwner nonReentrant {
        Order storage o = orders[orderId];
        if (o.status != OrderStatus.PENDING) revert OrderNotPending(orderId, o.status);
        if (bytes(reason).length == 0) revert EmptyReason();

        uint64 eligibleAt = o.createdAt + FORCE_REFUND_MIN_AGE;
        if (block.timestamp < eligibleAt) revert OrderTooYoung(orderId, eligibleAt);

        // Checked against the NFT contract, not our own bookkeeping: a mint that landed
        // while the worker lost track still blocks the refund, so a user can never end up
        // holding both the card and their money back.
        uint256 tokenId = mirror.mintedForOrder(orderId);
        if (tokenId != 0) revert MirrorAlreadyMinted(orderId, tokenId);

        /**
         * A DRAWN order has no escrow here to give back — we already took it to buy the pack.
         * It must still be closable, or the order is stuck PENDING forever and permanently
         * consumes one of the `maxOpenOrders` slots. Five of those halt the storefront for
         * everyone, and it happens by ACCIDENT to any contract wallet that cannot receive an
         * ERC-721, because `_safeMint` then reverts on every attempt.
         *
         * So the status and the slot are settled here, and the operator owes the buyer their
         * money directly. The 2 hour minimum age above still applies, and the reason is
         * permanent and public.
         */
        if (o.drawn) {
            o.status = OrderStatus.REFUNDED;
            _releaseSlot(o.buyer);
            emit ForceRefunded(orderId, o.buyer, o.price, reason);
            return;
        }

        _settleRefund(o);
        emit ForceRefunded(orderId, o.buyer, o.price, reason);
    }

    // ---------------------------------------------------------------- internal

    /// @dev Single refund path shared by `refund` and `forceRefund`, so both land in the
    ///      same terminal state and neither can follow the other.
    /**
     * Close an order's slot, globally and for its buyer, together.
     *
     * The two counters MUST move as one. There are four paths that close an order —
     * markFulfilled, closeDrawnOrder, forceRefund's drawn branch, and _settleRefund — and a
     * per-buyer counter that missed any one of them would leak a slot the buyer never gets
     * back, locking them out of the store permanently. That is a worse bug than the griefing
     * this cap exists to stop, so there is exactly one place that decrements.
     *
     * Guarded rather than trusting: a buyer whose count is somehow already zero must not
     * underflow into 4 billion slots.
     */
    function _releaseSlot(address buyer) private {
        openOrderCount -= 1;
        uint32 open = openOrdersOf[buyer];
        if (open > 0) openOrdersOf[buyer] = open - 1;
    }

    function _settleRefund(Order storage o) private {
        uint256 price = o.price;
        address buyer = o.buyer;

        o.status = OrderStatus.REFUNDED;
        _releaseSlot(buyer);
        escrowedUsdg -= price;

        usdg.safeTransfer(buyer, price);
    }

    // ---------------------------------------------------------------- views

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    function packsLeftToday() external view returns (uint256) {
        uint32 used = dailyCount[block.timestamp / 1 days];
        return used >= dailyPackCap ? 0 : dailyPackCap - used;
    }

    // ---------------------------------------------------------------- admin

    function setMachine(bytes32 machineId, uint96 priceUsdg, bool enabled) external onlyOwner {
        if (enabled && priceUsdg > maxPackPrice) revert PriceAboveMax(priceUsdg, maxPackPrice);
        machines[machineId] = Machine({priceUsdg: priceUsdg, enabled: enabled});
        emit MachineUpdated(machineId, priceUsdg, enabled);
    }

    function setCaps(uint32 dailyCap, uint96 maxPrice, uint32 maxOpen) external onlyOwner {
        if (maxOpen == 0) revert InvalidCaps();
        dailyPackCap = dailyCap;
        maxPackPrice = maxPrice;
        maxOpenOrders = maxOpen;
        emit CapsUpdated(dailyCap, maxPrice, maxOpen);
    }


    /// @notice Set the per-buyer open-order cap. 0 disables it, leaving only `maxOpenOrders`.
    /// @dev    Separate from setCaps so it can be tuned without touching the systemic limits,
    ///         and so raising it is never a side effect of adjusting daily volume.
    function setMaxOpenOrdersPerBuyer(uint32 perBuyer) external onlyOwner {
        emit PerBuyerCapUpdated(maxOpenOrdersPerBuyer, perBuyer);
        maxOpenOrdersPerBuyer = perBuyer;
    }

    function setTimeout(uint64 seconds_) external onlyOwner {
        // Bounded: too short strands fulfilments in refunds, too long strands user funds.
        if (seconds_ < 1 minutes || seconds_ > 1 hours) revert InvalidTimeout();
        emit TimeoutUpdated(orderTimeout, seconds_);
        orderTimeout = seconds_;
    }

    /// @notice Set the hot EOA that may draw order payments to fund pack purchases.
    /// @dev    Zero disables drawing entirely, which puts the contract back to pure escrow.
    function setDrawer(address drawer_) external onlyOwner {
        emit DrawerUpdated(drawer, drawer_);
        drawer = drawer_;
    }

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        emit OperatorUpdated(operator, operator_);
        operator = operator_;
    }

    function setGuardian(address guardian_) external onlyOwner {
        if (guardian_ == address(0)) revert ZeroAddress();
        emit GuardianUpdated(guardian, guardian_);
        guardian = guardian_;
    }

    function setRevenueRecipient(address revenueRecipient_) external onlyOwner {
        if (revenueRecipient_ == address(0)) revert ZeroAddress();
        emit RevenueRecipientUpdated(revenueRecipient, revenueRecipient_);
        revenueRecipient = revenueRecipient_;
    }

    /// @notice Guardian (the automated health monitor) can ONLY pause, never unpause.
    function pause() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardianOrOwner();
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recover tokens sent here by mistake. Cannot touch user escrow: only the
    ///         balance above `escrowedUsdg` is ever movable.
    function sweepSurplus(address token, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 movable = token == address(usdg) ? balance - escrowedUsdg : balance;
        IERC20(token).safeTransfer(to, movable);
    }
}
