// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title FlareAddresses
 * @notice Canonical Flare network constants used across Molfi.
 *
 * @dev The FlareContractRegistry lives at the SAME address on every Flare
 *      network (Flare, Songbird, Coston, Coston2), which is why it is the one
 *      address Flare says you may hardcode — everything else must be resolved
 *      through it at runtime, because Flare upgrades contracts by re-pointing
 *      the registry.
 */
library FlareAddresses {
    /// @notice FlareContractRegistry — identical on all Flare networks.
    address internal constant CONTRACT_REGISTRY =
        0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019;

    // ── FTSOv2 feed IDs ──────────────────────────────────────────────────────
    // A feed ID is bytes21: [1 byte category][hex-encoded name][zero padding].
    // Category 0x01 = crypto. These are NOT addresses.

    /// @notice XRP/USD — the feed Molfi settles its XRP markets against.
    bytes21 internal constant FEED_XRP_USD =
        bytes21(0x015852502f55534400000000000000000000000000);

    /// @notice FLR/USD
    bytes21 internal constant FEED_FLR_USD =
        bytes21(0x01464c522f55534400000000000000000000000000);

    /// @notice BTC/USD
    bytes21 internal constant FEED_BTC_USD =
        bytes21(0x014254432f55534400000000000000000000000000);

    /// @notice ETH/USD
    bytes21 internal constant FEED_ETH_USD =
        bytes21(0x014554482f55534400000000000000000000000000);
}

/**
 * @title Coston2Addresses
 * @notice FAssets deployment addresses on Coston2 (chainId 114).
 *
 * @dev Flare's guidance is to never hardcode the AssetManager in production —
 *      resolve it via the registry. We keep these as deploy-time DEFAULTS only:
 *      every Molfi contract takes the FXRP token address as a constructor
 *      argument, so a registry-resolved address can be passed instead without
 *      touching the contracts. These constants exist so scripts and tests have
 *      a known-good starting point on Coston2.
 */
library Coston2Addresses {
    /// @notice FTestXRP — the FAsset-wrapped test XRP token (ERC-20).
    address internal constant FXRP =
        0x0b6A3645c240605887a5532109323A3E12273dc7;

    /// @notice AssetManager for testnet XRP — mints/burns FXRP, manages collateral.
    address internal constant ASSET_MANAGER_FXRP =
        0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA;

    /// @notice FAssets AssetManagerController.
    address internal constant ASSET_MANAGER_CONTROLLER =
        0x1C772F700308aF4c13897cc7b9c41EFfB82c50C0;
}
