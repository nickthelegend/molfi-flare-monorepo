// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IMolfiOracle
 * @notice The settlement price source for Molfi markets.
 *
 * @dev Molfi's market contracts depend on this interface rather than calling
 *      Flare's ContractRegistry directly, for two reasons:
 *
 *      1. TESTABILITY. ContractRegistry is a library with a hardcoded address
 *         (0xaD67...6019). On a bare Hardhat network there is no code there, so
 *         any contract that calls it directly can only be tested against a
 *         Coston2 fork. Injecting the oracle lets the market logic — the part
 *         that actually holds user funds — be unit-tested in-memory, while the
 *         FTSO adapter is exercised separately against the live feed.
 *
 *      2. UPGRADE PATH. FTSOv2 is the right source today. Keeping the seam here
 *         means a market can later settle on an FDC-attested XRPL value, or a
 *         custom feed, without touching escrow or payout code.
 *
 *      All prices are 18-decimal, regardless of the feed's native decimals.
 */
interface IMolfiOracle {
    /**
     * @notice Current price for a feed.
     * @param feedId bytes21 FTSO feed id (category byte + name + zero padding).
     * @return price 18-decimal price.
     * @return timestamp Timestamp of the last oracle update.
     */
    function getPrice(
        bytes21 feedId
    ) external view returns (uint256 price, uint64 timestamp);

    /**
     * @notice Current price, reverting if the feed is older than `maxAge`.
     * @dev Settlement decides who gets paid, so a frozen feed must fail loudly
     *      rather than resolve every open position against a stale number.
     */
    function getFreshPrice(
        bytes21 feedId,
        uint64 maxAge
    ) external view returns (uint256 price, uint64 timestamp);
}
