// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title PokePlayEscrow
 * @notice Escrow for 1v1 PvP wagers settled by an off-chain trusted arbiter (the game server).
 *
 * ============================ TRUST MODEL — READ THIS ============================
 *
 * This contract is NOT trustless. The `arbiter` key decides the outcome of every
 * match. Whoever controls that key can sign a `BattleResult` naming EITHER
 * participant as the winner, for ANY active wager, at any time. The contract only
 * checks that the signature is well-formed and comes from the configured arbiter —
 * it has no idea what happened in the game. If the arbiter key is stolen, every
 * currently-ACTIVE wager can be drained to an attacker-chosen participant.
 *
 * Two things bound that power, and they are the only two:
 *
 *   1. The arbiter can only ever move a pot to one of the two participants of that
 *      specific wager (or split it via a draw). It cannot name a third-party
 *      address, cannot touch OPEN (unaccepted) wagers, and cannot touch funds
 *      already credited to a user's withdrawable balance.
 *
 *   2. `claimTimeout` — if the arbiter never signs anything, either participant can
 *      unwind the wager after `settleTimeout` and both sides get their exact stake
 *      back with no fee. This is the liveness escape hatch: a dead or censoring
 *      server can stall you, but it cannot keep your money.
 *
 * The `owner` is a separate role and is strictly weaker: it can rotate the arbiter,
 * the treasury, the fee (hard-capped at 5%) and the timeout, and it can pause NEW
 * wagers. It can never move a stake.
 *
 * ---- Honest disclosure: arbiter rotation is retroactive ----
 * `setArbiter` takes effect immediately and therefore applies to wagers that are
 * ALREADY ACTIVE. The owner can, in one transaction, point the arbiter at a key it
 * controls and then settle every in-flight wager however it likes. This is
 * inherent: the alternative (snapshotting the arbiter per-wager at creation time)
 * would mean a compromised or lost arbiter key could never be rotated out from
 * under wagers already in flight, which is a worse failure mode — those wagers
 * would be stuck until timeout with a known-bad key still able to settle them.
 *
 * We chose immediate rotation and are documenting it rather than hiding it. The
 * practical mitigations are operational, not cryptographic: put the owner behind a
 * timelock and/or a multisig, and keep `settleTimeout` short so the window of
 * in-flight value is small. DO NOT deploy this with a hot EOA as owner.
 *
 * ================================ MONEY HANDLING ================================
 *
 * Pull payments only. Settlement credits an internal balance; nobody is paid inside
 * settle/refund. A participant that is a contract with a reverting `receive()`
 * therefore cannot brick the counterparty's settlement — it can only make its own
 * `withdraw()` fail, which is its own problem. All external ETH movement happens in
 * exactly one place: `withdraw()`.
 *
 * Structural guarantee that the owner cannot touch stakes: fees are credited to
 * `balances[treasury]` at settlement time and are withdrawn through the same
 * `withdraw()` path as everyone else. There is no admin sweep function, no
 * `selfdestruct`, and no path from any `onlyOwner` function to a value transfer.
 */
contract PokePlayEscrow is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using ECDSA for bytes32;

    // ------------------------------------------------------------------ types

    enum Status {
        NONE, // never created
        OPEN, // created, awaiting an opponent
        ACTIVE, // both stakes escrowed, battle in progress
        SETTLED, // arbiter declared a winner, paid out
        REFUNDED, // draw or timeout — both sides refunded
        CANCELLED // cancelled while OPEN — creator refunded
    }

    struct Wager {
        address creator; //  160 bits ─┐
        uint64 expiry; //     64 bits  │ slot 0
        Status status; //      8 bits ─┘
        address opponent; //  160 bits ─┐ slot 1
        uint64 acceptedAt; //  64 bits ─┘
        uint256 stake; //               slot 2
        uint256 nonce; //               slot 3
    }

    // ------------------------------------------------------------- constants

    /// @notice Hard ceiling on the house fee. Enforced in the constructor AND the
    ///         setter. There is no code path that can raise the fee above this.
    uint16 public constant MAX_FEE_BPS = 500; // 5.00%
    uint16 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Hard ceiling on how long a stake can be held hostage by a silent
    ///         arbiter. The owner cannot set a timeout longer than this.
    uint64 public constant MAX_SETTLE_TIMEOUT = 7 days;
    uint64 public constant MIN_SETTLE_TIMEOUT = 5 minutes;

    bytes32 public constant BATTLE_RESULT_TYPEHASH =
        keccak256("BattleResult(uint256 wagerId,address winner,uint256 nonce)");
    bytes32 public constant DRAW_RESULT_TYPEHASH = keccak256("DrawResult(uint256 wagerId,uint256 nonce)");

    // ----------------------------------------------------------------- state

    /// @notice Key authorised to sign match results. See the trust model above.
    address public arbiter;

    /// @notice Destination for house fees. Fees are *credited*, not pushed.
    address public treasury;

    /// @notice House fee in basis points, applied to the pot on a decisive result.
    ///         Draws and timeouts are always fee-free.
    uint16 public feeBps;

    /// @notice How long after acceptance either participant may unwind the wager.
    uint64 public settleTimeout;

    uint256 public wagerCount;

    /// @dev Monotonic counter stamped into each wager and bound into the signed
    ///      payload. With monotonic ids this is redundant today, but it decouples
    ///      signature uniqueness from id allocation: if ids ever become reusable or
    ///      caller-supplied, a stale signature still cannot be replayed.
    uint256 public nonceCounter;

    mapping(uint256 id => Wager) private _wagers;

    /// @notice Withdrawable ETH per address (pull payments).
    mapping(address account => uint256 amount) public balances;

    /// @dev Accounting mirrors, used to state the solvency invariant:
    ///      address(this).balance >= totalEscrowed + totalCredited, always.
    uint256 public totalEscrowed; // ETH locked in OPEN/ACTIVE wagers
    uint256 public totalCredited; // ETH owed to addresses via `balances`

    // ---------------------------------------------------------------- events

    event WagerCreated(uint256 indexed id, address indexed creator, uint256 stake, uint64 expiry, uint256 nonce);
    event WagerAccepted(uint256 indexed id, address indexed opponent, uint64 acceptedAt);
    event WagerCancelled(uint256 indexed id, address indexed by, uint256 refund);
    event WagerSettled(uint256 indexed id, address indexed winner, address indexed loser, uint256 payout, uint256 fee);
    event WagerDrawn(uint256 indexed id, uint256 refundEach);
    event WagerTimedOut(uint256 indexed id, address indexed by, uint256 refundEach);
    event Withdrawal(address indexed account, uint256 amount);

    event ArbiterUpdated(address indexed previous, address indexed current);
    event TreasuryUpdated(address indexed previous, address indexed current);
    event FeeBpsUpdated(uint16 previous, uint16 current);
    event SettleTimeoutUpdated(uint64 previous, uint64 current);

    // ---------------------------------------------------------------- errors

    error ZeroAddress();
    error FeeTooHigh(uint16 provided, uint16 max);
    error TimeoutOutOfRange(uint64 provided, uint64 min, uint64 max);
    error StakeMismatch(uint256 expected, uint256 provided);
    error ExpiryInPast(uint64 provided, uint256 nowTs);
    error WagerNotOpen(uint256 id, Status status);
    error WagerNotActive(uint256 id, Status status);
    error WagerExpired(uint256 id, uint64 expiry);
    error CannotAcceptOwnWager(uint256 id);
    error NotCreator(uint256 id, address caller);
    error NotYetExpired(uint256 id, uint64 expiry);
    error NotParticipant(uint256 id, address caller);
    error WinnerNotParticipant(uint256 id, address winner);
    error InvalidArbiterSignature(uint256 id, address recovered);
    error TimeoutNotReached(uint256 id, uint64 claimableAt);
    error NothingToWithdraw(address account);
    error TransferFailed(address to, uint256 amount);
    error DirectPaymentRejected();

    // ----------------------------------------------------------- constructor

    /**
     * @param owner_    Contract owner. Use a multisig/timelock, not a hot EOA.
     * @param arbiter_  Result-signing key (the game server).
     * @param treasury_ Fee recipient.
     * @param feeBps_   House fee in bps, must be <= MAX_FEE_BPS.
     */
    constructor(address owner_, address arbiter_, address treasury_, uint16 feeBps_)
        Ownable(owner_)
        EIP712("PokePlayEscrow", "1")
    {
        // A zero `owner_` is already rejected by Ownable's constructor above
        // (OwnableInvalidOwner), so checking it again here would be dead code.
        if (arbiter_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        // Cap enforced at construction as well as in the setter, so there is no
        // deployment configuration that can exceed it.
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_, MAX_FEE_BPS);

        arbiter = arbiter_;
        treasury = treasury_;
        feeBps = feeBps_;
        settleTimeout = 1 hours;

        emit ArbiterUpdated(address(0), arbiter_);
        emit TreasuryUpdated(address(0), treasury_);
        emit FeeBpsUpdated(0, feeBps_);
        emit SettleTimeoutUpdated(0, 1 hours);
    }

    // ------------------------------------------------------- wager lifecycle

    /**
     * @notice Escrow `stakeWei` and open a wager for anyone to accept.
     * @dev Blocked while paused — pausing stops new risk being taken on, it never
     *      stops money leaving.
     * @param stakeWei Amount each side must stake. May be 0 (free/practice match).
     * @param expiry   Unix timestamp after which an unaccepted wager can be
     *                 cancelled by anyone.
     * @return id The new wager id (ids start at 1; 0 is never a valid wager).
     */
    function createWager(uint256 stakeWei, uint64 expiry)
        external
        payable
        whenNotPaused
        nonReentrant
        returns (uint256 id)
    {
        if (msg.value != stakeWei) revert StakeMismatch(stakeWei, msg.value);
        if (expiry <= block.timestamp) revert ExpiryInPast(expiry, block.timestamp);

        unchecked {
            // Bounded by the number of transactions ever mined; cannot realistically
            // reach 2^256. Overflow here would require ~1e77 wager creations.
            id = ++wagerCount;
            nonceCounter = nonceCounter + 1;
        }
        uint256 n = nonceCounter;

        _wagers[id] = Wager({
            creator: msg.sender,
            expiry: expiry,
            status: Status.OPEN,
            opponent: address(0),
            acceptedAt: 0,
            stake: stakeWei,
            nonce: n
        });

        // Checked add: totalEscrowed can never exceed the ETH supply, but we do not
        // rely on that assumption — let the compiler enforce it.
        totalEscrowed += stakeWei;

        emit WagerCreated(id, msg.sender, stakeWei, expiry, n);
    }

    /**
     * @notice Match the creator's stake exactly and start the battle.
     * @dev `msg.value == w.stake` is an equality, never `>=`: an over-payment would
     *      otherwise become unrecoverable dust, and an under-payment would let one
     *      side play for less than the other.
     */
    function acceptWager(uint256 id) external payable whenNotPaused nonReentrant {
        Wager storage w = _wagers[id];

        if (w.status != Status.OPEN) revert WagerNotOpen(id, w.status);
        if (block.timestamp > w.expiry) revert WagerExpired(id, w.expiry);
        if (msg.sender == w.creator) revert CannotAcceptOwnWager(id);
        if (msg.value != w.stake) revert StakeMismatch(w.stake, msg.value);

        w.opponent = msg.sender;
        w.acceptedAt = uint64(block.timestamp);
        w.status = Status.ACTIVE;

        totalEscrowed += msg.value;

        emit WagerAccepted(id, msg.sender, uint64(block.timestamp));
    }

    /**
     * @notice Cancel an OPEN wager and refund the creator.
     * @dev The creator may cancel at any time while OPEN. Anyone may cancel once
     *      `expiry` has passed, so a creator who loses their key or goes offline
     *      still has a path for the funds to be released (to the creator, always).
     *      Deliberately NOT gated on `whenNotPaused`.
     */
    function cancelWager(uint256 id) external nonReentrant {
        Wager storage w = _wagers[id];

        if (w.status != Status.OPEN) revert WagerNotOpen(id, w.status);

        bool byCreator = msg.sender == w.creator;
        if (!byCreator) {
            if (block.timestamp <= w.expiry) revert NotYetExpired(id, w.expiry);
        }

        uint256 stake = w.stake;
        address creator = w.creator;

        // EFFECTS before any credit.
        w.status = Status.CANCELLED;
        _releaseEscrow(stake);
        _credit(creator, stake);

        emit WagerCancelled(id, msg.sender, stake);
    }

    /**
     * @notice Settle an ACTIVE wager using an arbiter signature naming the winner.
     * @dev Callable by ANYONE — the signature is the authorisation, not the caller.
     *      This lets the winner self-submit if the server goes down after signing.
     *      Deliberately NOT gated on `whenNotPaused`.
     * @param id        Wager id.
     * @param winner    Must be the creator or the opponent of THIS wager.
     * @param signature EIP-712 signature by `arbiter` over
     *                  BattleResult(wagerId, winner, nonce).
     */
    function settle(uint256 id, address winner, bytes calldata signature) external nonReentrant {
        Wager storage w = _wagers[id];

        if (w.status != Status.ACTIVE) revert WagerNotActive(id, w.status);

        address creator = w.creator;
        address opponent = w.opponent;
        if (winner != creator && winner != opponent) revert WinnerNotParticipant(id, winner);

        // The wager id AND its nonce are inside the signed struct, and the EIP-712
        // domain binds chainId + verifyingContract. A signature is therefore usable
        // on exactly one wager, on one chain, on one deployment. Status flipping to
        // SETTLED below makes it single-use.
        _requireArbiterSignature(id, keccak256(abi.encode(BATTLE_RESULT_TYPEHASH, id, winner, w.nonce)), signature);

        uint256 stake = w.stake;
        uint256 pot = stake * 2; // checked; stake is bounded by msg.value
        uint256 fee = (pot * feeBps) / BPS_DENOMINATOR;
        uint256 payout;
        unchecked {
            // Safe: feeBps <= MAX_FEE_BPS (500) < BPS_DENOMINATOR, so fee <= pot/20.
            payout = pot - fee;
        }

        address loser = winner == creator ? opponent : creator;

        // EFFECTS: mark terminal before crediting anything.
        w.status = Status.SETTLED;
        _releaseEscrow(pot);
        _credit(winner, payout);
        _credit(treasury, fee);

        emit WagerSettled(id, winner, loser, payout, fee);
    }

    /**
     * @notice Settle an ACTIVE wager as a draw. Both sides refunded in full, NO fee.
     * @dev Uses a distinct typehash from `settle`, so a decisive-result signature
     *      can never be reinterpreted as a draw or vice versa.
     */
    function settleDraw(uint256 id, bytes calldata signature) external nonReentrant {
        Wager storage w = _wagers[id];

        if (w.status != Status.ACTIVE) revert WagerNotActive(id, w.status);

        _requireArbiterSignature(id, keccak256(abi.encode(DRAW_RESULT_TYPEHASH, id, w.nonce)), signature);

        uint256 stake = w.stake;
        address creator = w.creator;
        address opponent = w.opponent;

        w.status = Status.REFUNDED;
        _releaseEscrow(stake * 2);
        _credit(creator, stake);
        _credit(opponent, stake);

        emit WagerDrawn(id, stake);
    }

    /**
     * @notice Liveness escape hatch. If the arbiter never settled an ACTIVE wager
     *         within `settleTimeout`, either participant unwinds it and both sides
     *         get exactly their own stake back, fee-free.
     * @dev Deliberately NOT gated on `whenNotPaused` and requires no signature —
     *      this is precisely the path that must work when the server is gone.
     */
    function claimTimeout(uint256 id) external nonReentrant {
        Wager storage w = _wagers[id];

        if (w.status != Status.ACTIVE) revert WagerNotActive(id, w.status);

        address creator = w.creator;
        address opponent = w.opponent;
        if (msg.sender != creator && msg.sender != opponent) revert NotParticipant(id, msg.sender);

        uint64 claimableAt = w.acceptedAt + settleTimeout; // both uint64, sum fits
        if (block.timestamp <= claimableAt) revert TimeoutNotReached(id, claimableAt);

        uint256 stake = w.stake;

        w.status = Status.REFUNDED;
        _releaseEscrow(stake * 2);
        _credit(creator, stake);
        _credit(opponent, stake);

        emit WagerTimedOut(id, msg.sender, stake);
    }

    // ------------------------------------------------------------- withdrawal

    /**
     * @notice Withdraw everything credited to the caller.
     * @dev The ONLY function in this contract that sends ETH out. Zeroes the balance
     *      before the call, is nonReentrant, and checks the call's success. A
     *      re-entrant call would find a zero balance and revert with
     *      NothingToWithdraw even if the guard were absent. Never blocked by pause.
     */
    function withdraw() external nonReentrant returns (uint256 amount) {
        amount = balances[msg.sender];
        if (amount == 0) revert NothingToWithdraw(msg.sender);

        // EFFECTS
        balances[msg.sender] = 0;
        unchecked {
            // Safe: totalCredited is the sum of all balances, so it is >= amount.
            totalCredited -= amount;
        }

        // INTERACTION
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed(msg.sender, amount);

        emit Withdrawal(msg.sender, amount);
    }

    // ------------------------------------------------------------------ admin

    /**
     * @dev See the retroactivity disclosure in the contract-level docs: this applies
     *      to already-ACTIVE wagers. Intentional, so a compromised key can be
     *      rotated out; mitigate by owning this contract with a timelock/multisig.
     */
    function setArbiter(address newArbiter) external onlyOwner {
        if (newArbiter == address(0)) revert ZeroAddress();
        emit ArbiterUpdated(arbiter, newArbiter);
        arbiter = newArbiter;
    }

    /// @dev Only affects fees credited AFTER this call. Already-credited fees stay
    ///      withdrawable by the previous treasury address.
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @dev Applies to wagers settled after this call, including already-ACTIVE
    ///      ones. Bounded by MAX_FEE_BPS so the worst case is knowable up front.
    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh(newFeeBps, MAX_FEE_BPS);
        emit FeeBpsUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    function setSettleTimeout(uint64 newTimeout) external onlyOwner {
        if (newTimeout < MIN_SETTLE_TIMEOUT || newTimeout > MAX_SETTLE_TIMEOUT) {
            revert TimeoutOutOfRange(newTimeout, MIN_SETTLE_TIMEOUT, MAX_SETTLE_TIMEOUT);
        }
        emit SettleTimeoutUpdated(settleTimeout, newTimeout);
        settleTimeout = newTimeout;
    }

    /// @notice Blocks createWager and acceptWager ONLY. settle, settleDraw,
    ///         claimTimeout, cancelWager and withdraw all keep working.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------- view/util

    function getWager(uint256 id) external view returns (Wager memory) {
        return _wagers[id];
    }

    function statusOf(uint256 id) external view returns (Status) {
        return _wagers[id].status;
    }

    /// @notice Timestamp after which `claimTimeout` becomes callable. 0 if not ACTIVE.
    function timeoutAt(uint256 id) external view returns (uint64) {
        Wager storage w = _wagers[id];
        if (w.status != Status.ACTIVE) return 0;
        return w.acceptedAt + settleTimeout;
    }

    /// @notice The EIP-712 digest the arbiter must sign for a decisive result.
    ///         Exposed so the server can cross-check what it is signing.
    function battleResultDigest(uint256 id, address winner) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(BATTLE_RESULT_TYPEHASH, id, winner, _wagers[id].nonce)));
    }

    function drawResultDigest(uint256 id) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(DRAW_RESULT_TYPEHASH, id, _wagers[id].nonce)));
    }

    /**
     * @notice The EIP-712 domain separator currently in force.
     * @dev OpenZeppelin's EIP712 caches this and RECOMPUTES it automatically if
     *      `block.chainid` or `address(this)` differ from the cached values, which
     *      is what makes signatures safe across a chain fork: post-fork, the domain
     *      separator changes and pre-fork signatures stop verifying.
     */
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // --------------------------------------------------------------- internal

    function _requireArbiterSignature(uint256 id, bytes32 structHash, bytes calldata signature) private view {
        bytes32 digest = _hashTypedDataV4(structHash);
        // OZ's ECDSA.recover rejects malleable (high-s) signatures, bad v values and
        // never returns address(0) — it reverts instead. tryRecover lets us surface
        // our own error uniformly for every rejection reason.
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != arbiter || recovered == address(0)) {
            revert InvalidArbiterSignature(id, recovered);
        }
    }

    function _credit(address to, uint256 amount) private {
        if (amount == 0) return; // zero-stake wagers: nothing to credit
        balances[to] += amount;
        totalCredited += amount;
    }

    function _releaseEscrow(uint256 amount) private {
        unchecked {
            // Safe: every release is matched to escrow booked by create/accept for
            // that same wager, and each wager can reach a terminal state once only
            // (enforced by the Status enum), so totalEscrowed >= amount here.
            totalEscrowed -= amount;
        }
    }

    /// @dev No plain ETH. Every wei that enters must be attached to a stake, or the
    ///      solvency invariant becomes untestable and funds could be stranded.
    receive() external payable {
        revert DirectPaymentRejected();
    }
}
