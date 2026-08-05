// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockFXRP
 * @notice Stand-in for FAssets FTestXRP in local unit tests.
 *
 * @dev SIX decimals, deliberately. XRP is denominated in drops (1 XRP = 1e6
 *      drops) and FXRP follows that, so a mock with the ERC-20 default of 18
 *      would let decimal bugs pass locally and only surface on Coston2 — where
 *      they present as a payout that is off by 10^12 rather than as an error.
 *
 *      This exists ONLY for the in-memory test suite. On Coston2 the contracts
 *      are pointed at the real FTestXRP resolved through Flare's registry; no
 *      deploy script wires this mock into a live network.
 */
contract MockFXRP is ERC20 {
    uint8 private constant DECIMALS = 6;

    constructor() ERC20("Mock FXRP", "mFXRP") {}

    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }

    /// @notice Open faucet — tests mint freely.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Convenience: mint whole FXRP units.
    function mintUnits(address to, uint256 units) external {
        _mint(to, units * 10 ** DECIMALS);
    }
}
