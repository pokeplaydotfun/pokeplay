// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title Marketplace
/// @notice Peer-to-peer sales of mirror cards, priced in USDG.
/// @dev    Approval-based rather than escrow: the seller keeps the NFT in their own wallet
///         and only grants this contract permission to move it. Listing therefore costs one
///         approval instead of a transfer, a delisting is free, and a seller is never
///         exposed to a bug in this contract holding their asset.
///
///         The trade-off is that a listing can go stale — the seller may transfer or burn
///         the card, or revoke approval, while it is still listed. Every such case is
///         detected at purchase time and reverts with a specific error rather than moving
///         anyone's money.
contract Marketplace is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Listing {
        address seller;
        uint96 priceUsdg; // USDG is 6dp; uint96 covers ~7.9e22 units. Packs with seller.
    }

    /// @notice A standing bid on a card, whether or not it is listed.
    /// @dev    Allowance-based for the same reason listings are approval-based: the offeror
    ///         keeps their USDG and only grants permission to move it. An offer therefore
    ///         costs no capital lockup and can be withdrawn by simply revoking allowance.
    ///         The trade-off is identical too: an offer can go stale, and every way it can
    ///         is checked at accept time rather than being allowed to move funds.
    struct Offer {
        uint96 amountUsdg;
        uint64 expiry; // 0 means it never expires.
    }

    /// @notice Ceiling on the marketplace fee, fixed at deploy so it can never become
    ///         punitive after people have listed. 5% is the same spread we take on buybacks.
    uint16 public constant MAX_FEE_BPS = 500;
    uint16 public constant BPS_DENOMINATOR = 10_000;

    IERC20 public immutable usdg;
    IERC721 public immutable mirror;

    address public feeRecipient;
    uint16 public feeBps;

    /// @notice Ceiling on standing offers per card. Offers are enumerable on chain so the
    ///         UI works without an indexer, and an unbounded array would make that view
    ///         un-callable. Each offer costs its maker gas, so this only bounds griefing.
    uint256 public constant MAX_OFFERS_PER_TOKEN = 100;

    /// @notice tokenId => listing. A zero seller means "not listed".
    mapping(uint256 tokenId => Listing) public listings;

    /// @notice tokenId => offeror => offer. A zero amount means "no offer".
    mapping(uint256 tokenId => mapping(address offeror => Offer)) public offers;

    /// @dev Enumeration support. `_offerorIndex` is 1-based so zero reads as "absent".
    mapping(uint256 tokenId => address[]) private _offerors;
    mapping(uint256 tokenId => mapping(address offeror => uint256)) private _offerorIndex;

    event Listed(uint256 indexed tokenId, address indexed seller, uint256 priceUsdg);
    event PriceUpdated(uint256 indexed tokenId, address indexed seller, uint256 priceUsdg);
    event Cancelled(uint256 indexed tokenId, address indexed seller);
    event Sold(
        uint256 indexed tokenId,
        address indexed seller,
        address indexed buyer,
        uint256 priceUsdg,
        uint256 feeUsdg
    );
    event OfferMade(uint256 indexed tokenId, address indexed offeror, uint256 amountUsdg, uint64 expiry);
    event OfferWithdrawn(uint256 indexed tokenId, address indexed offeror);
    /// @notice Unfillable offers were cleared from a card's book.
    event OffersPruned(uint256 indexed tokenId, uint256 count, address indexed by);
    event OfferAccepted(
        uint256 indexed tokenId,
        address indexed seller,
        address indexed offeror,
        uint256 amountUsdg,
        uint256 feeUsdg
    );
    event FeeUpdated(uint16 previousBps, uint16 currentBps);
    event FeeRecipientUpdated(address indexed previous, address indexed current);

    error ZeroAddress();
    error NotOwner(uint256 tokenId, address caller);
    error NotApproved(uint256 tokenId);
    error NotListed(uint256 tokenId);
    error AlreadyListed(uint256 tokenId);
    error NotSeller(uint256 tokenId, address caller);
    error PriceZero();
    error SellerNoLongerOwns(uint256 tokenId, address seller);
    error ApprovalRevoked(uint256 tokenId);
    error CannotBuyOwnListing(uint256 tokenId);
    error PriceChanged(uint256 expected, uint256 actual);
    error FeeAboveMax(uint16 bps);
    error AmountZero();
    error CannotOfferOnOwnCard(uint256 tokenId);
    error NoOffer(uint256 tokenId, address offeror);
    /// @notice Nothing in this card's offer book is prunable right now.
    error NothingToPrune(uint256 tokenId);
    error OfferExpired(uint256 tokenId, address offeror, uint64 expiry);
    error OfferChanged(uint256 expected, uint256 actual);
    error ExpiryInPast(uint64 expiry);
    error OfferorCannotPay(address offeror, uint256 amountUsdg);
    error TooManyOffers(uint256 tokenId);

    constructor(
        address usdg_,
        address mirror_,
        address owner_,
        address feeRecipient_,
        uint16 feeBps_
    ) Ownable(owner_) {
        if (usdg_ == address(0) || mirror_ == address(0)) revert ZeroAddress();
        if (owner_ == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeAboveMax(feeBps_);

        usdg = IERC20(usdg_);
        mirror = IERC721(mirror_);
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
    }

    // ---------------------------------------------------------------- seller

    /// @notice List a card you own. Requires this contract to be approved for it first,
    ///         either per-token (`approve`) or for all (`setApprovalForAll`).
    function list(uint256 tokenId, uint96 priceUsdg) external whenNotPaused {
        if (priceUsdg == 0) revert PriceZero();
        if (mirror.ownerOf(tokenId) != msg.sender) revert NotOwner(tokenId, msg.sender);
        if (!_approved(tokenId)) revert NotApproved(tokenId);
        if (listings[tokenId].seller != address(0)) revert AlreadyListed(tokenId);

        listings[tokenId] = Listing({seller: msg.sender, priceUsdg: priceUsdg});
        emit Listed(tokenId, msg.sender, priceUsdg);
    }

    /// @notice Change the asking price without delisting and relisting.
    function updatePrice(uint256 tokenId, uint96 priceUsdg) external whenNotPaused {
        if (priceUsdg == 0) revert PriceZero();
        Listing storage l = listings[tokenId];
        if (l.seller == address(0)) revert NotListed(tokenId);
        if (l.seller != msg.sender) revert NotSeller(tokenId, msg.sender);

        l.priceUsdg = priceUsdg;
        emit PriceUpdated(tokenId, msg.sender, priceUsdg);
    }

    /// @notice Remove a listing. Always available, including while paused: a seller must
    ///         never be prevented from withdrawing their own offer to sell.
    function cancel(uint256 tokenId) external {
        Listing memory l = listings[tokenId];
        if (l.seller == address(0)) revert NotListed(tokenId);

        // The current owner may cancel too. If the card was transferred while listed, the
        // new owner needs a way to clear the stale listing without the old seller's help.
        if (l.seller != msg.sender && mirror.ownerOf(tokenId) != msg.sender) {
            revert NotSeller(tokenId, msg.sender);
        }

        delete listings[tokenId];
        emit Cancelled(tokenId, l.seller);
    }

    // ---------------------------------------------------------------- buyer

    /// @notice Buy a listed card.
    /// @param expectedPriceUsdg The price the buyer agreed to. Reverts if the seller moved
    ///        it in the meantime, so a front-run price rise can never be paid silently.
    function buy(uint256 tokenId, uint96 expectedPriceUsdg) external whenNotPaused nonReentrant {
        Listing memory l = listings[tokenId];
        if (l.seller == address(0)) revert NotListed(tokenId);
        if (l.seller == msg.sender) revert CannotBuyOwnListing(tokenId);
        if (l.priceUsdg != expectedPriceUsdg) revert PriceChanged(expectedPriceUsdg, l.priceUsdg);

        // A listing is only a promise; the seller keeps custody, so both of these can drift
        // after listing. Checked here so the buyer's money never moves against a card that
        // cannot be delivered.
        if (mirror.ownerOf(tokenId) != l.seller) revert SellerNoLongerOwns(tokenId, l.seller);
        if (!_approvedFor(tokenId, l.seller)) revert ApprovalRevoked(tokenId);

        uint256 fee = (uint256(l.priceUsdg) * feeBps) / BPS_DENOMINATOR;
        uint256 proceeds = uint256(l.priceUsdg) - fee;

        // Effects before interactions.
        delete listings[tokenId];

        // Buyer pays seller and fee directly; this contract never holds funds, so there is
        // no balance here for a bug to strand or drain.
        usdg.safeTransferFrom(msg.sender, l.seller, proceeds);
        if (fee > 0) usdg.safeTransferFrom(msg.sender, feeRecipient, fee);

        mirror.safeTransferFrom(l.seller, msg.sender, tokenId);

        emit Sold(tokenId, l.seller, msg.sender, l.priceUsdg, fee);
    }

    // ---------------------------------------------------------------- offers

    /// @notice Place or replace a standing offer on a card, listed or not. Requires a USDG
    ///         allowance to this contract of at least `amountUsdg`.
    /// @param expiry Unix seconds after which the offer can no longer be accepted, or 0 for
    ///        an offer that stands until withdrawn.
    /// @dev    Calling again overwrites the previous offer, so raising or lowering a bid is
    ///         one transaction rather than a withdraw plus a re-offer.
    function makeOffer(uint256 tokenId, uint96 amountUsdg, uint64 expiry) external whenNotPaused {
        if (amountUsdg == 0) revert AmountZero();
        if (expiry != 0 && expiry <= block.timestamp) revert ExpiryInPast(expiry);
        // ownerOf reverts for a token that was never minted, which is the check we want:
        // an offer on a nonexistent card can never be accepted.
        if (mirror.ownerOf(tokenId) == msg.sender) revert CannotOfferOnOwnCard(tokenId);

        if (offers[tokenId][msg.sender].amountUsdg == 0) {
            if (_offerors[tokenId].length >= MAX_OFFERS_PER_TOKEN && !_evictOneDeadOffer(tokenId)) {
                revert TooManyOffers(tokenId);
            }
            _offerors[tokenId].push(msg.sender);
            _offerorIndex[tokenId][msg.sender] = _offerors[tokenId].length;
        }

        offers[tokenId][msg.sender] = Offer({amountUsdg: amountUsdg, expiry: expiry});
        emit OfferMade(tokenId, msg.sender, amountUsdg, expiry);
    }

    /// @notice Withdraw your offer. Available while paused: an offeror must never be trapped
    ///         in a standing bid, for the same reason a seller may always cancel.

    /// @notice Clear offers that can never be filled: expired, or the offeror can no longer
    ///         pay. Callable by ANYONE, deliberately.
    ///
    /// @dev    The stuffing attack: 100 offers of 1 unit each, from wallets holding no USDG
    ///         and granting no allowance, with a one-second expiry. They cost the attacker
    ///         nothing but gas, they permanently occupy every slot, and before this NOBODY
    ///         could remove them — not the card's owner, not the operator, not after expiry.
    ///         A real buyer was then locked out of offering at all.
    ///
    ///         Permissionless because the alternative is worse. Owner-gated pruning would make
    ///         a card's offer book depend on us doing maintenance, and an owner-only sweep is
    ///         itself a lever we would rather not hold over someone's listing.
    ///
    ///         Bounded by `limit` so a full book can always be pruned within a sane gas
    ///         budget, and iterates BACKWARDS because _removeOffer swap-and-pops: walking
    ///         forwards would skip the element swapped into the slot just vacated.
    function pruneOffers(uint256 tokenId, uint256 limit) external returns (uint256 pruned) {
        address[] storage list_ = _offerors[tokenId];
        uint256 n = list_.length;
        if (limit == 0 || limit > n) limit = n;

        for (uint256 i = n; i > 0 && pruned < limit; i--) {
            address offeror = list_[i - 1];
            if (!_offerFillable(offeror, offers[tokenId][offeror])) {
                _removeOffer(tokenId, offeror);
                unchecked {
                    ++pruned;
                }
            }
        }

        if (pruned == 0) revert NothingToPrune(tokenId);
        emit OffersPruned(tokenId, pruned, msg.sender);
    }

    /// @dev Evict ONE dead offer to make room, so a legitimate offer is never blocked by a
    ///      full book of unfillable ones. Returns false when every slot holds a live offer,
    ///      which is a real "too many offers" rather than a stuffed book.
    function _evictOneDeadOffer(uint256 tokenId) private returns (bool) {
        address[] storage list_ = _offerors[tokenId];
        for (uint256 i = list_.length; i > 0; i--) {
            address offeror = list_[i - 1];
            if (!_offerFillable(offeror, offers[tokenId][offeror])) {
                _removeOffer(tokenId, offeror);
                return true;
            }
        }
        return false;
    }

    function withdrawOffer(uint256 tokenId) external {
        if (offers[tokenId][msg.sender].amountUsdg == 0) revert NoOffer(tokenId, msg.sender);
        _removeOffer(tokenId, msg.sender);
        emit OfferWithdrawn(tokenId, msg.sender);
    }

    /// @notice Accept a standing offer on a card you own.
    /// @param expectedAmountUsdg The amount the seller agreed to. Reverts if the offeror
    ///        lowered it in the meantime, mirroring the front-run guard on `buy`.
    function acceptOffer(uint256 tokenId, address offeror, uint96 expectedAmountUsdg)
        external
        whenNotPaused
        nonReentrant
    {
        if (mirror.ownerOf(tokenId) != msg.sender) revert NotOwner(tokenId, msg.sender);
        if (!_approved(tokenId)) revert NotApproved(tokenId);

        Offer memory o = offers[tokenId][offeror];
        if (o.amountUsdg == 0) revert NoOffer(tokenId, offeror);
        if (o.amountUsdg != expectedAmountUsdg) revert OfferChanged(expectedAmountUsdg, o.amountUsdg);
        if (o.expiry != 0 && o.expiry <= block.timestamp) revert OfferExpired(tokenId, offeror, o.expiry);

        // The offeror keeps custody of their USDG, so both of these can drift after the
        // offer was made. Checked here so the card never leaves against a bid that cannot
        // actually pay.
        if (usdg.allowance(offeror, address(this)) < o.amountUsdg || usdg.balanceOf(offeror) < o.amountUsdg) {
            revert OfferorCannotPay(offeror, o.amountUsdg);
        }

        uint256 fee = (uint256(o.amountUsdg) * feeBps) / BPS_DENOMINATOR;
        uint256 proceeds = uint256(o.amountUsdg) - fee;

        // Effects before interactions. The listing goes too: the card is being sold, so any
        // standing ask on it is now meaningless and must not outlive the transfer.
        _removeOffer(tokenId, offeror);
        if (listings[tokenId].seller != address(0)) {
            address seller = listings[tokenId].seller;
            delete listings[tokenId];
            emit Cancelled(tokenId, seller);
        }

        usdg.safeTransferFrom(offeror, msg.sender, proceeds);
        if (fee > 0) usdg.safeTransferFrom(offeror, feeRecipient, fee);

        mirror.safeTransferFrom(msg.sender, offeror, tokenId);

        emit OfferAccepted(tokenId, msg.sender, offeror, o.amountUsdg, fee);
    }

    // ---------------------------------------------------------------- views

    function getListing(uint256 tokenId) external view returns (Listing memory) {
        return listings[tokenId];
    }

    /// @notice Every standing offer on a card, newest last, with the fillability of each
    ///         already resolved so the UI can render the table in one call.
    function getOffers(uint256 tokenId)
        external
        view
        returns (address[] memory offerors, uint96[] memory amounts, uint64[] memory expiries, bool[] memory fillable)
    {
        address[] memory list_ = _offerors[tokenId];
        offerors = list_;
        amounts = new uint96[](list_.length);
        expiries = new uint64[](list_.length);
        fillable = new bool[](list_.length);

        for (uint256 i = 0; i < list_.length; ++i) {
            Offer memory o = offers[tokenId][list_[i]];
            amounts[i] = o.amountUsdg;
            expiries[i] = o.expiry;
            fillable[i] = _offerFillable(list_[i], o);
        }
    }

    function offerCount(uint256 tokenId) external view returns (uint256) {
        return _offerors[tokenId].length;
    }

    /// @notice Whether an offer could actually be accepted right now.
    function isOfferFillable(uint256 tokenId, address offeror) external view returns (bool) {
        return _offerFillable(offeror, offers[tokenId][offeror]);
    }

    /// @notice Whether a listing could actually be filled right now. The frontend uses this
    ///         to grey out stale listings rather than letting a buyer discover the problem
    ///         by having a transaction revert.
    function isFillable(uint256 tokenId) external view returns (bool) {
        Listing memory l = listings[tokenId];
        if (l.seller == address(0)) return false;
        if (mirror.ownerOf(tokenId) != l.seller) return false;
        return _approvedFor(tokenId, l.seller);
    }

    function priceBreakdown(uint256 tokenId)
        external
        view
        returns (uint256 price, uint256 fee, uint256 sellerReceives)
    {
        price = listings[tokenId].priceUsdg;
        fee = (price * feeBps) / BPS_DENOMINATOR;
        sellerReceives = price - fee;
    }

    // ---------------------------------------------------------------- internal

    function _approved(uint256 tokenId) private view returns (bool) {
        return _approvedFor(tokenId, msg.sender);
    }

    function _approvedFor(uint256 tokenId, address owner_) private view returns (bool) {
        return mirror.getApproved(tokenId) == address(this) || mirror.isApprovedForAll(owner_, address(this));
    }

    function _offerFillable(address offeror, Offer memory o) private view returns (bool) {
        if (o.amountUsdg == 0) return false;
        if (o.expiry != 0 && o.expiry <= block.timestamp) return false;
        if (usdg.allowance(offeror, address(this)) < o.amountUsdg) return false;
        return usdg.balanceOf(offeror) >= o.amountUsdg;
    }

    /// @dev Swap-and-pop so removal stays O(1) regardless of how many offers a card has.
    function _removeOffer(uint256 tokenId, address offeror) private {
        uint256 oneBased = _offerorIndex[tokenId][offeror];
        if (oneBased != 0) {
            address[] storage list_ = _offerors[tokenId];
            uint256 i = oneBased - 1;
            address last = list_[list_.length - 1];
            if (last != offeror) {
                list_[i] = last;
                _offerorIndex[tokenId][last] = oneBased;
            }
            list_.pop();
            delete _offerorIndex[tokenId][offeror];
        }
        delete offers[tokenId][offeror];
    }

    // ---------------------------------------------------------------- admin

    function setFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeAboveMax(bps);
        emit FeeUpdated(feeBps, bps);
        feeBps = bps;
    }

    function setFeeRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        emit FeeRecipientUpdated(feeRecipient, recipient);
        feeRecipient = recipient;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
