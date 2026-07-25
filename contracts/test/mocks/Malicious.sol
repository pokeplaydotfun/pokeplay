// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PokePlayEscrow} from "../../src/PokePlayEscrow.sol";

/// @dev A participant whose `receive()` always reverts. Used to prove that such a
///      player cannot block the counterparty's settlement (the point of pull
///      payments) — it can only break its own `withdraw()`.
contract RevertingReceiver {
    PokePlayEscrow public immutable escrow;
    bool public acceptEth;

    constructor(PokePlayEscrow escrow_) payable {
        escrow = escrow_;
    }

    function setAcceptEth(bool v) external {
        acceptEth = v;
    }

    function create(uint256 stake, uint64 expiry) external payable returns (uint256) {
        return escrow.createWager{value: msg.value}(stake, expiry);
    }

    function accept(uint256 id) external payable {
        escrow.acceptWager{value: msg.value}(id);
    }

    function withdraw() external returns (uint256) {
        return escrow.withdraw();
    }

    receive() external payable {
        // Reject ETH from the escrow, but allow plain funding in tests.
        if (!acceptEth) revert("I refuse ETH");
    }
}

/// @dev Re-enters `withdraw()` from `receive()`. If the guard or the
///      zero-before-send ordering were wrong, this would drain the contract.
contract ReentrantWithdrawer {
    PokePlayEscrow public immutable escrow;
    uint256 public reentryAttempts;
    bool public reentryReverted;
    bool public armed = true;

    constructor(PokePlayEscrow escrow_) payable {
        escrow = escrow_;
    }

    function disarm() external {
        armed = false;
    }

    function create(uint256 stake, uint64 expiry) external payable returns (uint256) {
        return escrow.createWager{value: msg.value}(stake, expiry);
    }

    function accept(uint256 id) external payable {
        escrow.acceptWager{value: msg.value}(id);
    }

    function withdraw() external returns (uint256) {
        return escrow.withdraw();
    }

    receive() external payable {
        if (!armed) return;
        reentryAttempts++;
        armed = false; // one attempt, so the outer call can still succeed
        try escrow.withdraw() {
        // If this ever succeeds we have double-spent.
        }
        catch {
            reentryReverted = true;
        }
    }
}

/// @dev Re-enters `settle()` (with a stored, previously-valid signature) from
///      `receive()`, i.e. mid-withdrawal. Proves a settled wager cannot be settled
///      twice even under reentrancy.
contract ReentrantSettler {
    PokePlayEscrow public immutable escrow;
    uint256 public targetId;
    address public targetWinner;
    bytes public storedSig;
    uint256 public reentryAttempts;
    bool public reentryReverted;
    bool public armed;

    constructor(PokePlayEscrow escrow_) payable {
        escrow = escrow_;
    }

    function arm(uint256 id, address winner, bytes calldata sig) external {
        targetId = id;
        targetWinner = winner;
        storedSig = sig;
        armed = true;
    }

    function create(uint256 stake, uint64 expiry) external payable returns (uint256) {
        return escrow.createWager{value: msg.value}(stake, expiry);
    }

    function accept(uint256 id) external payable {
        escrow.acceptWager{value: msg.value}(id);
    }

    function withdraw() external returns (uint256) {
        return escrow.withdraw();
    }

    receive() external payable {
        if (!armed) return;
        armed = false;
        reentryAttempts++;
        try escrow.settle(targetId, targetWinner, storedSig) {
        // Should be impossible: status is already SETTLED.
        }
        catch {
            reentryReverted = true;
        }
    }
}
