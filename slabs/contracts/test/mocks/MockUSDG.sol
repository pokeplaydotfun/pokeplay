// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Stand-in for USDG until doc 01 T5 confirms the real address and behaviour.
///         6 decimals, matching Paxos' USDG.
contract MockUSDG is ERC20 {
    constructor() ERC20("Mock USDG", "USDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice USDG-shaped token that skims a fee on transfer. Not expected in production —
///         exists so the balance-diff accounting in PackSale.buy is actually exercised
///         rather than merely asserted (doc 03 §4.6).
contract FeeOnTransferUSDG is ERC20 {
    uint256 public feeBps;

    constructor(uint256 feeBps_) ERC20("Fee USDG", "fUSDG") {
        feeBps = feeBps_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, to, value - fee);
        if (fee > 0) super._update(from, address(0xdead), fee);
    }
}
