// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MirrorNFT
/// @notice ERC-721 mirror of a Collector Crypt card held in our Solana custody wallet.
///         One mirror <-> one custodied Solana NFT, always. Minting is operator-gated and
///         one-per-order; burning happens on sell-back (operator, after payout) or on
///         unwrap (token owner, redeeming the real Solana NFT).
/// @dev    Doc 03 §2. Transfers are deliberately ENABLED — mirrors are tradeable and the
///         buyback right follows the current owner. Windows do NOT reset on transfer.
contract MirrorNFT is ERC721, Ownable, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @param solanaMintHash    keccak256 of the base58 mint address (full string in tokenURI)
    /// @param ccOpenTxHash      keccak256 of the CC pack-open Solana signature (order binding)
    /// @param revealAt          block time of reveal; starts both windows
    /// @param userWindowEndsAt  reveal + 66h. Sell-backs allowed until here (enforced
    ///                          off-chain; recorded on-chain for transparency).
    /// @param ccWindowEndsAt    reveal + 72h. CC's own buyback window — this, NOT the 66h
    ///                          user window, is the boundary the unwrap fee keys off.
    struct CardMeta {
        bytes32 solanaMintHash;
        bytes32 ccOpenTxHash;
        uint64 revealAt;
        uint64 userWindowEndsAt;
        uint64 ccWindowEndsAt;
    }

    /// @notice EIP-712 payload: an operator-signed snapshot of a card's insured value.
    /// @dev    Insured value is a moving, off-chain number (doc 01 T2). We never store it
    ///         on-chain as truth; the unwrap fee is computed from a fresh signed quote.
    struct UnwrapQuote {
        uint256 tokenId;
        uint256 insuredValueUsdg;
        uint256 expiry;
    }

    bytes32 private constant UNWRAP_QUOTE_TYPEHASH =
        keccak256("UnwrapQuote(uint256 tokenId,uint256 insuredValueUsdg,uint256 expiry)");

    uint16 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Ceiling on the unwrap fee, hard-coded so no future config change can make
    ///         unwrapping punitive. 5% is the spread we would otherwise lose (doc 00 §2).
    uint16 public constant MAX_UNWRAP_FEE_BPS = 500;

    IERC20 public immutable usdg;

    address public operator;
    address public quoteSigner;
    /// @notice The wallet that holds mirrors surrendered for sell-back. Only a mirror sitting
    ///         here can be burned, so a token in a user's own wallet is never destroyable.
    address public custodian;
    address public feeRecipient;

    /// @notice 0 = unwraps are always free and need no signed quote. Stays 0 unless doc 01
    ///         T3 shows the CC buyback right travels with the NFT (the "bypass open" case).
    uint16 public unwrapFeeBps;

    uint256 public nextTokenId = 1;

    mapping(uint256 orderId => uint256 tokenId) public mintedForOrder;
    mapping(uint256 tokenId => uint256 orderId) public orderOfToken;
    mapping(uint256 tokenId => CardMeta) private _cardMeta;
    mapping(uint256 tokenId => string) private _tokenURIs;

    event Minted(uint256 indexed tokenId, uint256 indexed orderId, address indexed to, CardMeta meta);
    event BurnedForSell(uint256 indexed tokenId, uint256 indexed orderId, address indexed formerOwner);
    event UnwrapRequested(uint256 indexed tokenId, address indexed owner, bytes solanaAddress, uint256 feePaidUsdg);
    event OperatorUpdated(address indexed previous, address indexed current);
    event QuoteSignerUpdated(address indexed previous, address indexed current);
    event CustodianUpdated(address indexed previous, address indexed current);
    event FeeRecipientUpdated(address indexed previous, address indexed current);
    event UnwrapFeeUpdated(uint16 previousBps, uint16 currentBps);

    error NotOperator();
    error ZeroAddress();
    error OrderAlreadyMinted(uint256 orderId);
    error TokenDoesNotExist(uint256 tokenId);
    error NotTokenOwner();
    error FeeAboveMax(uint16 bps);
    error QuoteExpired(uint256 expiry);
    error BadQuoteSigner(address recovered);
    /// @notice The mirror is not in custody, so it was never surrendered for a sell-back.
    error NotInCustody(uint256 tokenId, address holder);
    error CustodianNotSet();
    error QuoteTokenMismatch();
    error InvalidSolanaAddress();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address usdg_, address owner_, address operator_, address feeRecipient_)
        ERC721("Slabs", "SLABS")
        Ownable(owner_)
        // EIP712 domain is PROTOCOL, not branding — the backend re-derives "MirrorNFT"/"1"
        // to verify quote/unwrap signatures. Leave it unchanged across rebrands/redeploys.
        EIP712("MirrorNFT", "1")
    {
        if (usdg_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (operator_ == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        usdg = IERC20(usdg_);
        operator = operator_;
        feeRecipient = feeRecipient_;
        // quoteSigner defaults to the operator; unwrapFeeBps defaults to 0, so no quote is
        // required until T3 says otherwise.
        quoteSigner = operator_;
    }

    // ---------------------------------------------------------------- operator

    /// @notice Mint the mirror for a revealed pack. One per orderId, forever.
    /// @dev    `mintedForOrder` is the on-chain source of truth that PackSale.forceRefund
    ///         checks — it must be written here and never cleared, including on burn, so a
    ///         burned-then-force-refunded order is impossible.
    function mint(address to, uint256 orderId, CardMeta calldata meta, string calldata uri)
        external
        onlyOperator
        returns (uint256 tokenId)
    {
        if (to == address(0)) revert ZeroAddress();
        if (mintedForOrder[orderId] != 0) revert OrderAlreadyMinted(orderId);

        tokenId = nextTokenId++;
        mintedForOrder[orderId] = tokenId;
        orderOfToken[tokenId] = orderId;
        _cardMeta[tokenId] = meta;
        _tokenURIs[tokenId] = uri;

        _safeMint(to, tokenId);
        emit Minted(tokenId, orderId, to, meta);
    }

    /// @notice Burn after a sell-back payout has landed. Settle-then-pay means the USDG is
    ///         already with the user by the time this runs (doc 02 §4).
    function burnForSell(uint256 tokenId) external onlyOperator {
        address holder = _requireOwned(tokenId);
        /**
         * Only ever burn a mirror that is ACTUALLY IN CUSTODY.
         *
         * Without this, `burnForSell` took nothing but a tokenId and would destroy any
         * holder's mirror on the operator's say-so. A compromised worker key — a hot key, the
         * same one that signs fulfilments — could burn EVERY mirror in existence while the
         * underlying Solana cards stayed in custody: total loss of every user's claim, with
         * no USDG paid and no consent given. It was the largest single-key blast radius in
         * the system.
         *
         * No signature scheme is needed to fix it, because consent already exists in the
         * design: a sell-back BEGINS with the holder transferring their mirror to custody.
         * That transfer is the consent. Requiring custody here simply encodes on chain what
         * the buyback pipeline already refuses to proceed without off chain
         * (`buyback.ts` re-reads ownership and declines to burn if we are not the holder).
         *
         * A mirror still in a user's wallet is now unburnable, by anyone, always.
         */
        if (custodian == address(0)) revert CustodianNotSet();
        if (holder != custodian) revert NotInCustody(tokenId, holder);

        uint256 orderId = orderOfToken[tokenId];
        _burn(tokenId);
        emit BurnedForSell(tokenId, orderId, holder);
    }

    // ---------------------------------------------------------------- token owner

    /// @notice Burn the mirror to claim the underlying Solana NFT. The relayer watches for
    ///         UnwrapRequested and transfers from custody (doc 02 §5).
    /// @param solanaAddress Raw 32-byte Solana pubkey. Validated for length here and for
    ///                      base58/curve validity in the frontend and worker.
    /// @dev   When `unwrapFeeBps` is 0, or the CC window has already closed, the quote
    ///        arguments are ignored entirely — pass zeroes and an empty signature.
    function burnForUnwrap(
        uint256 tokenId,
        bytes calldata solanaAddress,
        UnwrapQuote calldata quote,
        bytes calldata signature
    ) external nonReentrant {
        address holder = _requireOwned(tokenId);
        if (msg.sender != holder) revert NotTokenOwner();
        if (solanaAddress.length != 32) revert InvalidSolanaAddress();

        uint256 fee = 0;
        if (unwrapFeeBps > 0 && block.timestamp < _cardMeta[tokenId].ccWindowEndsAt) {
            fee = _verifyAndPriceQuote(tokenId, quote, signature);
        }

        // Effects before interactions: burn first, then pull the fee.
        _burn(tokenId);

        if (fee > 0) {
            usdg.safeTransferFrom(msg.sender, feeRecipient, fee);
        }

        emit UnwrapRequested(tokenId, holder, solanaAddress, fee);
    }

    /// @notice What `burnForUnwrap` would charge for this quote right now. View-only helper
    ///         for the frontend; the authoritative check happens in the burn.
    function previewUnwrapFee(uint256 tokenId, uint256 insuredValueUsdg) external view returns (uint256) {
        _requireOwned(tokenId);
        if (unwrapFeeBps == 0 || block.timestamp >= _cardMeta[tokenId].ccWindowEndsAt) return 0;
        return (insuredValueUsdg * unwrapFeeBps) / BPS_DENOMINATOR;
    }

    function _verifyAndPriceQuote(uint256 tokenId, UnwrapQuote calldata quote, bytes calldata signature)
        private
        view
        returns (uint256)
    {
        if (quote.tokenId != tokenId) revert QuoteTokenMismatch();
        if (block.timestamp > quote.expiry) revert QuoteExpired(quote.expiry);

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(UNWRAP_QUOTE_TYPEHASH, quote.tokenId, quote.insuredValueUsdg, quote.expiry))
        );
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != quoteSigner) revert BadQuoteSigner(recovered);

        return (quote.insuredValueUsdg * unwrapFeeBps) / BPS_DENOMINATOR;
    }

    // ---------------------------------------------------------------- views

    function cardMeta(uint256 tokenId) external view returns (CardMeta memory) {
        _requireOwned(tokenId);
        return _cardMeta[tokenId];
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _tokenURIs[tokenId];
    }

    // ---------------------------------------------------------------- admin

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        emit OperatorUpdated(operator, operator_);
        operator = operator_;
    }

    /// @notice Set the custody wallet whose mirrors may be burned on sell-back.
    function setCustodian(address custodian_) external onlyOwner {
        emit CustodianUpdated(custodian, custodian_);
        custodian = custodian_;
    }

    function setQuoteSigner(address quoteSigner_) external onlyOwner {
        if (quoteSigner_ == address(0)) revert ZeroAddress();
        emit QuoteSignerUpdated(quoteSigner, quoteSigner_);
        quoteSigner = quoteSigner_;
    }

    function setFeeRecipient(address feeRecipient_) external onlyOwner {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        emit FeeRecipientUpdated(feeRecipient, feeRecipient_);
        feeRecipient = feeRecipient_;
    }

    /// @notice Set the in-window unwrap fee. Launch default is 0; only doc 01 T3's
    ///         "bypass open" outcome justifies raising it, and never above 5%.
    function setUnwrapFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_UNWRAP_FEE_BPS) revert FeeAboveMax(bps);
        emit UnwrapFeeUpdated(unwrapFeeBps, bps);
        unwrapFeeBps = bps;
    }
}
