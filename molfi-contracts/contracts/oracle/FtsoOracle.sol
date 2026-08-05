// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ContractRegistry} from "@flarenetwork/flare-periphery-contracts/coston2/ContractRegistry.sol";
import {TestFtsoV2Interface} from "@flarenetwork/flare-periphery-contracts/coston2/TestFtsoV2Interface.sol";
import {IMolfiOracle} from "../interfaces/IMolfiOracle.sol";

/**
 * @title FtsoOracle
 * @notice Molfi's settlement price source, backed by Flare's FTSOv2.
 *
 * @dev This is what replaces Chainlink from the Avalanche build. The question
 *      is the same — "what is XRP worth at settlement" — but the answer now
 *      comes from Flare's first-party oracle: FTSOv2 feeds are produced by the
 *      same validator set that secures the chain, so a Molfi market settles
 *      without trusting an oracle network layered on top.
 *
 *      Two deliberate choices worth calling out:
 *
 *      TestFtsoV2Interface, not FtsoV2Interface. The `Test` variant exposes
 *      `getFeedById` as `view`. That matters far more than the name suggests:
 *      a `view` price read composes into `view` getters, so the frontend can
 *      quote the exact price the contract will settle on via a free `eth_call`,
 *      and settlement itself needs no fee plumbing. The production interface
 *      makes the same call payable, which would force every read through
 *      `simulateContract` and put a fee on the settlement path.
 *
 *      Resolve on every call, never cache. Flare upgrades protocol contracts by
 *      re-pointing the registry. Caching the FTSOv2 address in storage is the
 *      standard way integrators silently break on upgrade day — the read is
 *      cheap, so we pay it every time and stay correct forever.
 */
contract FtsoOracle is IMolfiOracle {
    /// @notice All prices this contract returns carry 18 decimals.
    uint8 public constant PRICE_DECIMALS = 18;

    error ZeroPrice(bytes21 feedId);
    error StalePrice(bytes21 feedId, uint64 timestamp, uint64 maxAge);

    /// @inheritdoc IMolfiOracle
    function getPrice(
        bytes21 feedId
    ) public view returns (uint256 price, uint64 timestamp) {
        TestFtsoV2Interface ftso = ContractRegistry.getTestFtsoV2();
        // `InWei` returns the value pre-scaled to 18 decimals. Feeds carry
        // their own decimals, which differ per feed and can change; letting the
        // protocol normalize removes a whole class of silent mispricing that
        // would otherwise appear the day a feed's decimals move.
        (price, timestamp) = ftso.getFeedByIdInWei(feedId);
        if (price == 0) revert ZeroPrice(feedId);
    }

    /// @inheritdoc IMolfiOracle
    function getFreshPrice(
        bytes21 feedId,
        uint64 maxAge
    ) external view returns (uint256 price, uint64 timestamp) {
        (price, timestamp) = getPrice(feedId);
        // A timestamp ahead of block.timestamp means clock skew, not staleness —
        // treat it as fresh rather than underflowing the subtraction.
        if (timestamp < block.timestamp) {
            unchecked {
                if (uint64(block.timestamp) - timestamp > maxAge) {
                    revert StalePrice(feedId, timestamp, maxAge);
                }
            }
        }
    }

    /**
     * @notice Raw feed read, exposing the feed's native decimals.
     * @dev Not used for settlement — provided so the UI and the market-engine
     *      backend can display exactly what FTSO reports without the 18-decimal
     *      normalization applied above.
     */
    function getRawFeed(
        bytes21 feedId
    ) external view returns (uint256 value, int8 decimals, uint64 timestamp) {
        return ContractRegistry.getTestFtsoV2().getFeedById(feedId);
    }
}
