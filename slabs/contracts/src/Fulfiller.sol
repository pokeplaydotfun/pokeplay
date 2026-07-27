// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PackSale} from "./PackSale.sol";
import {MirrorNFT} from "./MirrorNFT.sol";

/// @title Fulfiller
/// @notice Holds the operator role on both PackSale and MirrorNFT so that minting the
///         mirror and releasing the escrow happen in one transaction or not at all.
/// @dev    Doc 03 §1. Without this, a worker crash between the two calls leaves either a
///         minted card with escrow still locked, or released escrow with no card. Both are
///         recoverable by hand, but "recoverable by hand" is exactly what the escape hatch
///         exists to avoid needing.
///
///         Roles: the worker's hot key is this contract's `caller`. The owner key can swap
///         the caller on rotation. This contract holds no funds and has no withdraw path.
contract Fulfiller is Ownable {
    PackSale public immutable packSale;
    MirrorNFT public immutable mirror;

    address public caller;

    /**
     * Deposit mirrors are minted against SYNTHETIC order ids starting here.
     *
     * `MirrorNFT.mint` keys on an order id and refuses a second mint for the same one, which is
     * the guarantee that one pack can never mint twice. A deposit has no PackSale order, so it
     * borrows that mapping — and borrowing it safely means never colliding with a REAL order
     * id, because a collision would make some future buyer's pack permanently unmintable.
     *
     * PackSale is at order 5 after a day of live trading. One million is roughly six centuries
     * of headroom at that rate, and `mintForDeposit` asserts the invariant on every call rather
     * than trusting the arithmetic to stay true.
     */
    uint256 public constant DEPOSIT_ID_BASE = 1_000_000;

    /// @notice Deposit ids already used, so the same Solana card cannot mint two mirrors.
    mapping(bytes32 => uint256) public mintedForDeposit;

    event CallerUpdated(address indexed previous, address indexed current);
    event Fulfilled(uint256 indexed orderId, uint256 indexed tokenId, address indexed buyer);
    event DepositMinted(bytes32 indexed solanaMintHash, uint256 indexed tokenId, address indexed to);

    error NotCaller();
    error ZeroAddress();
    error BuyerMismatch(address expected, address actual);
    error DepositIdTooLow(uint256 depositId);
    error DepositIdWouldCollide(uint256 depositId, uint256 nextOrderId);
    error DepositAlreadyMinted(bytes32 solanaMintHash, uint256 tokenId);

    modifier onlyCaller() {
        if (msg.sender != caller) revert NotCaller();
        _;
    }

    constructor(address packSale_, address mirror_, address owner_, address caller_) Ownable(owner_) {
        if (packSale_ == address(0) || mirror_ == address(0)) revert ZeroAddress();
        if (owner_ == address(0) || caller_ == address(0)) revert ZeroAddress();
        packSale = PackSale(packSale_);
        mirror = MirrorNFT(mirror_);
        caller = caller_;
    }

    /// @notice Mint the mirror to the order's buyer and release escrow, atomically.
    /// @param expectedBuyer The buyer the worker believes owns this order. Checked against
    ///        on-chain state so a worker-side mix-up mints to nobody rather than to the
    ///        wrong person — a mis-minted card cannot be clawed back.
    function fulfill(
        uint256 orderId,
        address expectedBuyer,
        MirrorNFT.CardMeta calldata meta,
        string calldata uri,
        bytes32 ccTxSigHash
    ) external onlyCaller returns (uint256 tokenId) {
        PackSale.Order memory o = packSale.getOrder(orderId);
        if (o.buyer != expectedBuyer) revert BuyerMismatch(expectedBuyer, o.buyer);

        tokenId = mirror.mint(o.buyer, orderId, meta, uri);
        packSale.markFulfilled(orderId, tokenId, ccTxSigHash);

        emit Fulfilled(orderId, tokenId, o.buyer);
    }

    /**
     * @notice Mint a mirror for a card DEPOSITED into Solana custody, which has no PackSale
     *         order and no escrow to release.
     *
     * @dev The whole reason this contract is being redeployed. `MirrorNFT.mint` is
     *      `onlyOperator` and the only route through the old Fulfiller was `fulfill`, which
     *      reads a PackSale order — so a deposited card could not be mirrored at all.
     *
     *      Three guards, none of them decorative:
     *
     *      - `depositId` must sit above DEPOSIT_ID_BASE, and PackSale's next real order id must
     *        still be below it. Together those make a collision with a real order impossible
     *        rather than merely unlikely. The second check reads live state, so it keeps
     *        holding as PackSale grows.
     *      - `solanaMintHash` is recorded, so one physical card cannot mint two mirrors even if
     *        the worker retries with a different deposit id. The Solana asset is the thing
     *        being mirrored; it, not our own bookkeeping, is the identity that must be unique.
     *      - No escrow is touched and `packSale.markFulfilled` is NOT called. There is no order
     *        to mark, and calling it would corrupt an unrelated one.
     *
     * @param solanaMintHash keccak256 of the deposited card's Solana mint address.
     */
    function mintForDeposit(
        address to,
        uint256 depositId,
        bytes32 solanaMintHash,
        MirrorNFT.CardMeta calldata meta,
        string calldata uri
    ) external onlyCaller returns (uint256 tokenId) {
        if (to == address(0)) revert ZeroAddress();
        if (depositId < DEPOSIT_ID_BASE) revert DepositIdTooLow(depositId);

        uint256 nextReal = packSale.nextOrderId();
        if (nextReal >= DEPOSIT_ID_BASE) revert DepositIdWouldCollide(depositId, nextReal);

        uint256 existing = mintedForDeposit[solanaMintHash];
        if (existing != 0) revert DepositAlreadyMinted(solanaMintHash, existing);

        tokenId = mirror.mint(to, depositId, meta, uri);
        mintedForDeposit[solanaMintHash] = tokenId;

        emit DepositMinted(solanaMintHash, tokenId, to);
    }

    /// @notice Burn a mirror after a sell-back payout has landed (doc 02 §4).
    /// @dev    Lives here so the worker needs exactly one operator identity, not two.
    function burnAfterSell(uint256 tokenId) external onlyCaller {
        mirror.burnForSell(tokenId);
    }

    function setCaller(address caller_) external onlyOwner {
        if (caller_ == address(0)) revert ZeroAddress();
        emit CallerUpdated(caller, caller_);
        caller = caller_;
    }
}
