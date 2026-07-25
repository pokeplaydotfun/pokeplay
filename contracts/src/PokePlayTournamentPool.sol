// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title PokePlayTournamentPool
 * @notice Pools N equal entry fees for a single-elimination tournament and pays the
 *         winner, settled by the same off-chain trusted arbiter (the game server)
 *         that settles 1v1 wagers. Sibling to PokePlayEscrow; deliberately built in
 *         its image so the two share a trust model and a review surface.
 *
 * The 1v1 escrow cannot express a tournament: it matches exactly two equal stakes and
 * pays one of those two. A tournament pools 3..64 equal fees and pays ONE of the many.
 * That is the only thing this contract adds.
 *
 * ============================ TRUST MODEL — READ THIS ============================
 *
 * This contract is NOT trustless. The `arbiter` key decides the winner of every
 * tournament. Whoever controls that key can sign a `TournamentResult` naming ANY
 * entrant of an OPEN tournament as the winner, and that entrant takes the whole pot
 * (minus the fee). The contract only checks that the signature is well-formed, comes
 * from the configured arbiter, and names someone who actually paid in. It has no idea
 * who won the games.
 *
 * Three things bound that power, and they are the only three:
 *
 *   1. The arbiter can only pay the pot to an ENTRANT of that specific tournament. It
 *      cannot name a non-entrant, cannot touch a tournament that is not OPEN, and
 *      cannot touch funds already credited to a withdrawable balance.
 *
 *   2. Winner-take-all is computed by the CONTRACT (pot - fee), not chosen by the
 *      arbiter. The arbiter names the winner; it cannot name the amount, cannot split
 *      the pot to an address of its choosing, and cannot skim beyond the capped fee.
 *
 *   3. `claimRefund` after `settleTimeout` — if the arbiter never settles, ANY entrant
 *      can unwind the whole tournament and then everyone reclaims their exact entry
 *      fee, fee-free. A dead or censoring server can stall a payout but can never keep
 *      the pooled money.
 *
 * The `owner` is a separate, strictly weaker role: it can rotate the arbiter, the
 * treasury, the fee (hard-capped at 5%) and the timeout, and it can pause NEW
 * tournaments and joins. It can never move a pooled fee. As with the escrow,
 * `setArbiter` is retroactive (see that contract's disclosure); own this with a
 * timelock/multisig, not a hot EOA.
 *
 * ================================ MONEY HANDLING ================================
 *
 * Pull payments only, exactly as in PokePlayEscrow. Settlement and the refund trigger
 * credit internal balances; nobody is paid inside settle/cancel/claimRefund. The only
 * function that sends ETH out is `withdraw()`. A winner or entrant that is a contract
 * with a reverting `receive()` can only brick its own withdraw, never anyone else's.
 *
 * The solvency invariant is identical:
 *      address(this).balance >= totalEscrowed + totalCredited, always.
 */
contract PokePlayTournamentPool is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using ECDSA for bytes32;

    // ------------------------------------------------------------------ types

    enum Status {
        NONE, // never created
        OPEN, // accepting entrants, awaiting a signed winner
        SETTLED, // arbiter named a winner, pot paid out
        REFUNDING // cancelled or timed out — entrants reclaim their own fee
    }

    struct Tournament {
        address organizer; //          160 bits ─┐
        uint64 registrationDeadline; //  64 bits │ slot 0
        Status status; //                 8 bits ─┘
        uint32 maxPlayers; //             32 bits ─┐
        uint32 playerCount; //            32 bits  │ slot 1
        uint64 createdAt; //              64 bits ─┘
        uint256 entryFee; //                        slot 2
        uint256 nonce; //                           slot 3
    }

    // ------------------------------------------------------------- constants

    /// @notice Smallest and largest field. A tournament of one cannot have a winner,
    ///         and the bracket the server runs tops out at 64.
    uint32 public constant MIN_PLAYERS = 2;
    uint32 public constant MAX_PLAYERS = 64;

    /// @notice Hard ceiling on the house fee. Enforced in the constructor AND the
    ///         setter. No code path can raise the fee above this.
    uint16 public constant MAX_FEE_BPS = 500; // 5.00%
    uint16 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Bounds on how long a pot can be held before the refund hatch opens.
    ///         A tournament can run for a while, so the default leans generous.
    uint64 public constant MAX_SETTLE_TIMEOUT = 7 days;
    uint64 public constant MIN_SETTLE_TIMEOUT = 5 minutes;
    uint64 public constant DEFAULT_SETTLE_TIMEOUT = 24 hours;

    /// @notice How far into the future the organizer may push a registration
    ///         deadline with `extendDeadline`. Bounds how long entrants' fees can
    ///         sit before the tournament must run or refund.
    uint64 public constant MAX_REGISTRATION_EXTENSION = 30 days;

    bytes32 public constant TOURNAMENT_RESULT_TYPEHASH =
        keccak256("TournamentResult(uint256 tournamentId,address winner,uint256 nonce)");

    // ----------------------------------------------------------------- state

    /// @notice Key authorised to sign tournament results. See the trust model above.
    address public arbiter;

    /// @notice Destination for house fees. Fees are *credited*, not pushed.
    address public treasury;

    /// @notice House fee in basis points, applied to the pot on a decisive result.
    ///         A refund (cancel or timeout) is always fee-free.
    uint16 public feeBps;

    /// @notice How long after `registrationDeadline` an unsettled pot can be unwound.
    uint64 public settleTimeout;

    uint256 public tournamentCount;

    /// @dev Monotonic counter bound into every signed payload, decoupling signature
    ///      uniqueness from id allocation. Mirrors the escrow.
    uint256 public nonceCounter;

    mapping(uint256 id => Tournament) private _tournaments;

    /// @notice True while an address is an entrant that has NOT been refunded. Doubles
    ///         as the "already refunded?" guard: `claimRefund` flips it to false.
    mapping(uint256 id => mapping(address player => bool)) public joined;

    /// @notice Withdrawable ETH per address (pull payments).
    mapping(address account => uint256 amount) public balances;

    /// @dev Accounting mirrors for the solvency invariant.
    uint256 public totalEscrowed; // ETH pooled in OPEN/REFUNDING tournaments
    uint256 public totalCredited; // ETH owed to addresses via `balances`

    // ---------------------------------------------------------------- events

    event TournamentCreated(
        uint256 indexed id,
        address indexed organizer,
        uint256 entryFee,
        uint32 maxPlayers,
        uint64 registrationDeadline,
        uint256 nonce
    );
    event PlayerJoined(uint256 indexed id, address indexed player, uint32 playerCount);
    event PlayerLeft(uint256 indexed id, address indexed player, uint256 refund, uint32 playerCount);
    event DeadlineExtended(uint256 indexed id, uint64 previous, uint64 current);
    event TournamentSettled(uint256 indexed id, address indexed winner, uint256 pot, uint256 payout, uint256 fee);
    event TournamentRefunding(uint256 indexed id, address indexed by, bool timedOut);
    event RefundClaimed(uint256 indexed id, address indexed player, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);

    event ArbiterUpdated(address indexed previous, address indexed current);
    event TreasuryUpdated(address indexed previous, address indexed current);
    event FeeBpsUpdated(uint16 previous, uint16 current);
    event SettleTimeoutUpdated(uint64 previous, uint64 current);

    // ---------------------------------------------------------------- errors

    error ZeroAddress();
    error ZeroEntryFee();
    error FeeTooHigh(uint16 provided, uint16 max);
    error TimeoutOutOfRange(uint64 provided, uint64 min, uint64 max);
    error MaxPlayersOutOfRange(uint32 provided, uint32 min, uint32 max);
    error DeadlineInPast(uint64 provided, uint256 nowTs);
    error EntryFeeMismatch(uint256 expected, uint256 provided);
    error RegistrationClosed(uint256 id, uint64 deadline);
    error TournamentFull(uint256 id, uint32 maxPlayers);
    error AlreadyJoined(uint256 id, address player);
    error TournamentNotOpen(uint256 id, Status status);
    error NotOrganizer(uint256 id, address caller);
    error DeadlineNotLater(uint64 current, uint64 provided);
    error DeadlineTooFar(uint64 provided, uint64 max);
    error NotEnoughPlayers(uint256 id, uint32 playerCount);
    error WinnerNotEntrant(uint256 id, address winner);
    error InvalidArbiterSignature(uint256 id, address recovered);
    error NotEntrantOrAlreadyRefunded(uint256 id, address caller);
    error NotRefundable(uint256 id, Status status);
    error TimeoutNotReached(uint256 id, uint64 claimableAt);
    error CannotCancel(uint256 id);
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
        EIP712("PokePlayTournamentPool", "1")
    {
        if (arbiter_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_, MAX_FEE_BPS);

        arbiter = arbiter_;
        treasury = treasury_;
        feeBps = feeBps_;
        settleTimeout = DEFAULT_SETTLE_TIMEOUT;

        emit ArbiterUpdated(address(0), arbiter_);
        emit TreasuryUpdated(address(0), treasury_);
        emit FeeBpsUpdated(0, feeBps_);
        emit SettleTimeoutUpdated(0, DEFAULT_SETTLE_TIMEOUT);
    }

    // -------------------------------------------------- tournament lifecycle

    /**
     * @notice Open a tournament that entrants can pay `entryFee` to join.
     * @dev The organizer does not stake anything here and is not auto-entered — an
     *      admin can run a tournament without playing in it. Blocked while paused.
     * @param entryFee              What each entrant must pay to join. Must be > 0;
     *                              a free tournament needs no on-chain pool.
     * @param maxPlayers            Cap on entrants, in [MIN_PLAYERS, MAX_PLAYERS].
     * @param registrationDeadline  Unix time after which no one may join and, once
     *                              `settleTimeout` further elapses, refunds open. Set
     *                              this to when sign-ups close, so a running
     *                              tournament cannot be cancelled out from under it.
     * @return id The new tournament id (ids start at 1; 0 is never valid).
     */
    function createTournament(uint256 entryFee, uint32 maxPlayers, uint64 registrationDeadline)
        external
        whenNotPaused
        returns (uint256 id)
    {
        if (entryFee == 0) revert ZeroEntryFee();
        if (maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) {
            revert MaxPlayersOutOfRange(maxPlayers, MIN_PLAYERS, MAX_PLAYERS);
        }
        if (registrationDeadline <= block.timestamp) revert DeadlineInPast(registrationDeadline, block.timestamp);

        unchecked {
            // Bounded by transactions ever mined; cannot realistically reach 2^256.
            id = ++tournamentCount;
            nonceCounter = nonceCounter + 1;
        }
        uint256 n = nonceCounter;

        _tournaments[id] = Tournament({
            organizer: msg.sender,
            registrationDeadline: registrationDeadline,
            status: Status.OPEN,
            maxPlayers: maxPlayers,
            playerCount: 0,
            createdAt: uint64(block.timestamp),
            entryFee: entryFee,
            nonce: n
        });

        emit TournamentCreated(id, msg.sender, entryFee, maxPlayers, registrationDeadline, n);
    }

    /**
     * @notice Pay the entry fee and join an OPEN tournament.
     * @dev `msg.value == entryFee` is an equality, never `>=`: an over-payment would
     *      become unrecoverable pool dust and an under-payment would let one entrant
     *      buy in cheaper than the rest.
     */
    function joinTournament(uint256 id) external payable whenNotPaused nonReentrant {
        Tournament storage t = _tournaments[id];

        if (t.status != Status.OPEN) revert TournamentNotOpen(id, t.status);
        if (block.timestamp > t.registrationDeadline) revert RegistrationClosed(id, t.registrationDeadline);
        if (msg.value != t.entryFee) revert EntryFeeMismatch(t.entryFee, msg.value);
        if (joined[id][msg.sender]) revert AlreadyJoined(id, msg.sender);
        if (t.playerCount >= t.maxPlayers) revert TournamentFull(id, t.maxPlayers);

        joined[id][msg.sender] = true;
        unchecked {
            // Bounded by maxPlayers <= 64.
            t.playerCount += 1;
        }
        totalEscrowed += msg.value;

        emit PlayerJoined(id, msg.sender, t.playerCount);
    }

    /**
     * @notice Leave an OPEN tournament you joined and take your entry fee back.
     * @dev Only while registration is still open (up to `registrationDeadline`):
     *      once sign-ups close the roster is locked for the bracket, and after that
     *      an entrant's only exits are winning, a draw-free settle, or a full
     *      refund. Symmetric with joining. Never paused — this is an exit path.
     */
    function leaveTournament(uint256 id) external nonReentrant {
        Tournament storage t = _tournaments[id];

        if (t.status != Status.OPEN) revert TournamentNotOpen(id, t.status);
        if (block.timestamp > t.registrationDeadline) revert RegistrationClosed(id, t.registrationDeadline);
        if (!joined[id][msg.sender]) revert NotEntrantOrAlreadyRefunded(id, msg.sender);

        uint256 fee = t.entryFee;

        // EFFECTS: clear the entrant (also the guard against a double refund)
        // before crediting.
        joined[id][msg.sender] = false;
        unchecked {
            // joined was true, so playerCount >= 1.
            t.playerCount -= 1;
        }
        _releaseEscrow(fee);
        _credit(msg.sender, fee);

        emit PlayerLeft(id, msg.sender, fee, t.playerCount);
    }

    /**
     * @notice Settle an OPEN tournament: the named winner takes the pot minus the fee.
     * @dev Callable by ANYONE — the arbiter signature is the authorisation, not the
     *      caller, so a winner can self-submit if the server dies after signing.
     *      Deliberately NOT gated on `whenNotPaused`.
     * @param id        Tournament id.
     * @param winner    Must be an entrant of THIS tournament.
     * @param signature EIP-712 signature by `arbiter` over
     *                  TournamentResult(tournamentId, winner, nonce).
     */
    function settle(uint256 id, address winner, bytes calldata signature) external nonReentrant {
        Tournament storage t = _tournaments[id];

        if (t.status != Status.OPEN) revert TournamentNotOpen(id, t.status);
        // A pot of one has no meaningful winner; that pot belongs on the refund path.
        if (t.playerCount < MIN_PLAYERS) revert NotEnoughPlayers(id, t.playerCount);
        if (!joined[id][winner]) revert WinnerNotEntrant(id, winner);

        // id + nonce are inside the signed struct and the EIP-712 domain binds chainId
        // + verifyingContract, so a signature is good for exactly one tournament, on
        // one chain, on one deployment. Flipping to SETTLED makes it single-use.
        _requireArbiterSignature(
            id, keccak256(abi.encode(TOURNAMENT_RESULT_TYPEHASH, id, winner, t.nonce)), signature
        );

        // Pot is over ACTUAL entrants, not the cap — a half-full tournament pays out a
        // half-size pot.
        uint256 pot = uint256(t.entryFee) * t.playerCount; // checked; bounded by joins
        uint256 fee = (pot * feeBps) / BPS_DENOMINATOR;
        uint256 payout;
        unchecked {
            // Safe: feeBps <= MAX_FEE_BPS (500) < BPS_DENOMINATOR, so fee <= pot/20.
            payout = pot - fee;
        }

        // EFFECTS: terminal before crediting anything.
        t.status = Status.SETTLED;
        _releaseEscrow(pot);
        _credit(winner, payout);
        _credit(treasury, fee);

        emit TournamentSettled(id, winner, pot, payout, fee);
    }

    /**
     * @notice Call off an OPEN tournament so every entrant can reclaim their fee.
     * @dev Two ways in, and only two:
     *      - the ORGANIZER, at or before the registration deadline (calling the event
     *        off before it runs — e.g. too few sign-ups);
     *      - ANYONE, after the deadline, if fewer than MIN_PLAYERS joined and so it can
     *        never produce a winner.
     *      A tournament that is running (deadline passed, enough players) can only be
     *      unwound by the trustless timeout in `claimRefund` — the organizer cannot
     *      pull the rug once play has begun. Crediting is pull-based: this only flips
     *      the state; entrants call `claimRefund`.
     */
    function cancelTournament(uint256 id) external nonReentrant {
        Tournament storage t = _tournaments[id];
        if (t.status != Status.OPEN) revert TournamentNotOpen(id, t.status);

        bool organizerInTime = msg.sender == t.organizer && block.timestamp <= t.registrationDeadline;
        bool unrunnable = block.timestamp > t.registrationDeadline && t.playerCount < MIN_PLAYERS;
        if (!organizerInTime && !unrunnable) revert CannotCancel(id);

        t.status = Status.REFUNDING;
        emit TournamentRefunding(id, msg.sender, false);
    }

    /**
     * @notice Push an OPEN tournament's registration deadline further out, e.g. to
     *         give a half-full bracket more time to fill.
     * @dev Organizer only, forward only (never bring it earlier — that would shorten
     *      the refund window entrants are relying on), and bounded so fees cannot be
     *      parked indefinitely. Because the refund timeout is `deadline +
     *      settleTimeout`, extending the deadline also extends how long the pot may
     *      sit before `claimRefund` opens — which is the intended effect.
     */
    function extendDeadline(uint256 id, uint64 newDeadline) external {
        Tournament storage t = _tournaments[id];

        if (t.status != Status.OPEN) revert TournamentNotOpen(id, t.status);
        if (msg.sender != t.organizer) revert NotOrganizer(id, msg.sender);
        if (newDeadline <= t.registrationDeadline) revert DeadlineNotLater(t.registrationDeadline, newDeadline);
        uint64 max = uint64(block.timestamp) + MAX_REGISTRATION_EXTENSION;
        if (newDeadline > max) revert DeadlineTooFar(newDeadline, max);

        emit DeadlineExtended(id, t.registrationDeadline, newDeadline);
        t.registrationDeadline = newDeadline;
    }

    /**
     * @notice Reclaim your entry fee from a tournament that will not pay a winner.
     * @dev This is both the liveness escape hatch and the refund path:
     *      - if the tournament is still OPEN, the caller must be an entrant and the
     *        timeout (`registrationDeadline + settleTimeout`) must have passed; the
     *        first such call flips the tournament to REFUNDING for everyone;
     *      - if it is already REFUNDING (via timeout or `cancelTournament`), any
     *        entrant just claims.
     *      Each entrant can claim exactly once — `joined` is flipped to false, which is
     *      also the double-claim guard. Requires no signature and is never paused: this
     *      is precisely the path that must work when the server is gone.
     */
    function claimRefund(uint256 id) external nonReentrant {
        Tournament storage t = _tournaments[id];

        if (!joined[id][msg.sender]) revert NotEntrantOrAlreadyRefunded(id, msg.sender);

        if (t.status == Status.OPEN) {
            uint64 claimableAt = t.registrationDeadline + settleTimeout; // both uint64, sum fits
            if (block.timestamp <= claimableAt) revert TimeoutNotReached(id, claimableAt);
            t.status = Status.REFUNDING;
            emit TournamentRefunding(id, msg.sender, true);
        } else if (t.status != Status.REFUNDING) {
            // SETTLED (or NONE, though a non-entrant can't reach here) — no refund.
            revert NotRefundable(id, t.status);
        }

        uint256 fee = t.entryFee;

        // EFFECTS: clear the entrant flag (also the double-claim guard) before credit.
        joined[id][msg.sender] = false;
        _releaseEscrow(fee);
        _credit(msg.sender, fee);

        emit RefundClaimed(id, msg.sender, fee);
    }

    // ------------------------------------------------------------- withdrawal

    /**
     * @notice Withdraw everything credited to the caller.
     * @dev The ONLY function that sends ETH out. Zeroes the balance before the call,
     *      is nonReentrant, and checks success. Never blocked by pause.
     */
    function withdraw() external nonReentrant returns (uint256 amount) {
        amount = balances[msg.sender];
        if (amount == 0) revert NothingToWithdraw(msg.sender);

        balances[msg.sender] = 0;
        unchecked {
            // Safe: totalCredited is the sum of all balances, so it is >= amount.
            totalCredited -= amount;
        }

        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed(msg.sender, amount);

        emit Withdrawal(msg.sender, amount);
    }

    // ------------------------------------------------------------------ admin

    /// @dev Retroactive, exactly as in PokePlayEscrow — applies to already-OPEN
    ///      tournaments. Own this with a timelock/multisig.
    function setArbiter(address newArbiter) external onlyOwner {
        if (newArbiter == address(0)) revert ZeroAddress();
        emit ArbiterUpdated(arbiter, newArbiter);
        arbiter = newArbiter;
    }

    /// @dev Only affects fees credited AFTER this call.
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @dev Applies to tournaments settled after this call, including already-OPEN
    ///      ones. Bounded by MAX_FEE_BPS.
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

    /// @notice Blocks createTournament and joinTournament ONLY. settle, cancel,
    ///         claimRefund and withdraw all keep working.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------- view/util

    function getTournament(uint256 id) external view returns (Tournament memory) {
        return _tournaments[id];
    }

    function statusOf(uint256 id) external view returns (Status) {
        return _tournaments[id].status;
    }

    /// @notice Whether `player` is a current (unrefunded) entrant of tournament `id`.
    function isEntrant(uint256 id, address player) external view returns (bool) {
        return joined[id][player];
    }

    /// @notice The pot an OPEN/SETTLED tournament pools right now (entryFee * entrants).
    function potOf(uint256 id) external view returns (uint256) {
        Tournament storage t = _tournaments[id];
        return uint256(t.entryFee) * t.playerCount;
    }

    /// @notice Timestamp after which `claimRefund` can unwind an unsettled tournament.
    ///         0 if it is not OPEN.
    function timeoutAt(uint256 id) external view returns (uint64) {
        Tournament storage t = _tournaments[id];
        if (t.status != Status.OPEN) return 0;
        return t.registrationDeadline + settleTimeout;
    }

    /// @notice The EIP-712 digest the arbiter must sign to declare a winner. Exposed so
    ///         the server can cross-check what it is signing.
    function tournamentResultDigest(uint256 id, address winner) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(TOURNAMENT_RESULT_TYPEHASH, id, winner, _tournaments[id].nonce)));
    }

    /**
     * @notice The EIP-712 domain separator currently in force. OpenZeppelin recomputes
     *         it automatically across a chain fork, so pre-fork signatures stop
     *         verifying — the same protection the escrow relies on.
     */
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // --------------------------------------------------------------- internal

    function _requireArbiterSignature(uint256 id, bytes32 structHash, bytes calldata signature) private view {
        bytes32 digest = _hashTypedDataV4(structHash);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != arbiter || recovered == address(0)) {
            revert InvalidArbiterSignature(id, recovered);
        }
    }

    function _credit(address to, uint256 amount) private {
        if (amount == 0) return;
        balances[to] += amount;
        totalCredited += amount;
    }

    function _releaseEscrow(uint256 amount) private {
        unchecked {
            // Safe: every release is matched to escrow booked by a join for this same
            // tournament, and each fee can be released once only (settle releases the
            // whole pot and is terminal; claimRefund flips `joined` first), so
            // totalEscrowed >= amount here.
            totalEscrowed -= amount;
        }
    }

    /// @dev No plain ETH. Every wei that enters must be an entry fee, or the solvency
    ///      invariant becomes untestable and funds could be stranded.
    receive() external payable {
        revert DirectPaymentRejected();
    }
}
