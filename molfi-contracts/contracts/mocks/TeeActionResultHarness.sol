// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TeeActionResult} from "../tee/TeeActionResult.sol";

/// @notice Exposes the library so its scheme can be pinned directly against a
///         signature produced by real off-chain code, instead of only being
///         observed through SealedBidBook's accept/reject.
contract TeeActionResultHarness {
    function resultHash(
        bytes calldata data,
        bytes32 actionId,
        string calldata submissionTag,
        uint8 status
    ) external pure returns (bytes32) {
        return TeeActionResult.resultHash(data, actionId, submissionTag, status);
    }

    function digest(bytes32 hash, uint256 chainId) external pure returns (bytes32) {
        return TeeActionResult.digest(hash, chainId);
    }

    function recoverSigner(
        bytes calldata data,
        bytes32 actionId,
        string calldata submissionTag,
        uint8 status,
        bytes calldata signature
    ) external view returns (address) {
        return TeeActionResult.recoverSigner(data, actionId, submissionTag, status, signature);
    }
}
