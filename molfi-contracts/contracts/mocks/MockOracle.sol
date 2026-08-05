// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMolfiOracle} from "../interfaces/IMolfiOracle.sol";

/**
 * @title MockOracle
 * @notice Test double for FTSOv2, so market logic can be unit-tested in-memory.
 *
 * @dev Molfi's escrow and payout math is the part that holds user funds, and it
 *      needs to be tested against prices that a live feed will never produce on
 *      demand: exactly-at-strike, zero, and stale. This mock makes those cases
 *      reachable. The real FTSO path is covered separately against Coston2.
 */
contract MockOracle is IMolfiOracle {
    struct Feed {
        uint256 price; // 18 decimals
        uint64 timestamp;
        bool set;
    }

    mapping(bytes21 => Feed) private _feeds;

    error ZeroPrice(bytes21 feedId);
    error StalePrice(bytes21 feedId, uint64 timestamp, uint64 maxAge);
    error FeedNotSet(bytes21 feedId);

    /// @notice Set a feed's price, stamped at the current block time.
    function setPrice(bytes21 feedId, uint256 price18) external {
        _feeds[feedId] = Feed(price18, uint64(block.timestamp), true);
    }

    /// @notice Set a feed's price with an explicit timestamp (to test staleness).
    function setPriceAt(
        bytes21 feedId,
        uint256 price18,
        uint64 timestamp
    ) external {
        _feeds[feedId] = Feed(price18, timestamp, true);
    }

    /// @inheritdoc IMolfiOracle
    function getPrice(
        bytes21 feedId
    ) public view returns (uint256 price, uint64 timestamp) {
        Feed memory f = _feeds[feedId];
        if (!f.set) revert FeedNotSet(feedId);
        if (f.price == 0) revert ZeroPrice(feedId);
        return (f.price, f.timestamp);
    }

    /// @inheritdoc IMolfiOracle
    function getFreshPrice(
        bytes21 feedId,
        uint64 maxAge
    ) external view returns (uint256 price, uint64 timestamp) {
        (price, timestamp) = getPrice(feedId);
        if (timestamp < block.timestamp) {
            unchecked {
                if (uint64(block.timestamp) - timestamp > maxAge) {
                    revert StalePrice(feedId, timestamp, maxAge);
                }
            }
        }
    }
}
