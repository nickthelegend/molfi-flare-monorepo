// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title MockVerifier
 * @notice Toggleable Groth16 verifier stand-in.
 *
 * @dev Lets the escrow/claim state machine be tested — nullifier replay, payout
 *      sizing, outcome binding — without generating a real proof for every
 *      case. The real ConfidentialBetVerifier is exercised separately against
 *      genuine BN254 proofs; this exists so a bug in, say, double-claim
 *      protection surfaces as a failing unit test rather than being hidden
 *      behind proof-generation time.
 *
 *      `verifyProof` MUST stay `view`: the consuming interfaces declare it view,
 *      so Solidity dispatches with STATICCALL and any state write here would
 *      revert the caller. That rules out recording call history, so instead the
 *      mock can be armed with an expected public signal — which is enough to
 *      prove the contract injects the resolved winner rather than trusting the
 *      caller's claim.
 */
contract MockVerifier {
    bool public result = true;

    /// @notice When set, verification only passes if pubSignals[2] matches.
    bool public checkOutcome;
    uint256 public expectedOutcome;

    /// @notice When set, verification only passes if pubSignals[3] matches.
    bool public checkRecipient;
    uint256 public expectedRecipient;

    function setResult(bool r) external {
        result = r;
    }

    /// @notice Arm an assertion that the caller passes this outcome signal.
    function expectOutcome(uint256 outcome) external {
        checkOutcome = true;
        expectedOutcome = outcome;
    }

    /// @notice Arm an assertion that the caller passes this recipient signal.
    function expectRecipient(address recipient) external {
        checkRecipient = true;
        expectedRecipient = uint256(uint160(recipient));
    }

    function clearExpectations() external {
        checkOutcome = false;
        checkRecipient = false;
    }

    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[4] calldata pubSignals
    ) external view returns (bool) {
        if (!result) return false;
        if (checkOutcome && pubSignals[2] != expectedOutcome) return false;
        if (checkRecipient && pubSignals[3] != expectedRecipient) return false;
        return true;
    }
}
