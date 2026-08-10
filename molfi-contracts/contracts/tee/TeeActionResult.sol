// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title TeeActionResult — verifying a result signed by Flare's TEE node itself.
 *
 * @notice Molfi's own opening signature is produced by a key the extension holds
 *         and that we hand it through the environment. That is the honest weak
 *         point of the sealed book: the integrity checks on-chain are real, but
 *         the *identity* doing the signing is one we configured, not one the
 *         network attested.
 *
 *         Flare already solves this and we were not using it. When an extension
 *         returns an `ActionResult` from `POST /action`, tee-node's router signs
 *         it with the node's OWN identity key — the key that was attested and
 *         registered as the TEE machine. Nothing in the extension touches it.
 *         A contract that verifies under this scheme is therefore trusting the
 *         registered machine, not an operator-supplied address.
 *
 * @dev THE SCHEME, in the order the bytes are built:
 *
 *        resultHash  = keccak256( keccak256(data)
 *                               ‖ actionId
 *                               ‖ keccak256(submissionTag)
 *                               ‖ status )                    -- packed
 *
 *        payload     = keccak256( abi.encode(
 *                          bytes32("TEE_ACTION_RESULT"),
 *                          block.chainid,
 *                          resultHash ) )                      -- NOT packed
 *
 *        signature over EIP-191 personal-sign of `payload`.
 *
 *      Note the deliberate mix of `encodePacked` and `encode`: the inner hash is
 *      packed (fixed-width fields, no ambiguity) while the outer one is not.
 *      Getting either wrong produces a valid-looking signature over the wrong
 *      bytes, which fails as an unrecognised signer rather than as anything that
 *      points at the real cause.
 *
 *      Ported from _references/flare-prediction-market, whose Solidity and
 *      TypeScript state the scheme independently and agree. Rather than take
 *      that on faith, `TeeActionResult.test.ts` pins it against a signature
 *      produced by this repo's own extension code, and the deployed contract is
 *      exercised against one live.
 *
 *      CHAIN ID IS IN THE PAYLOAD. A result signed for Coston2 cannot be
 *      replayed on another chain where the same machine is registered.
 */
library TeeActionResult {
    /// @dev Must match go-flare-common's `signing.TEEActionResult`.
    bytes32 internal constant PREFIX = bytes32("TEE_ACTION_RESULT");

    error BadSignatureLength(uint256 length);
    error MalleableSignature();

    /// @notice `ActionResult.Hash()` as tee-node computes it.
    function resultHash(
        bytes calldata data,
        bytes32 actionId,
        string calldata submissionTag,
        uint8 status
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    keccak256(data),
                    actionId,
                    keccak256(bytes(submissionTag)),
                    status
                )
            );
    }

    /// @notice The EIP-191 digest the node actually signs, bound to this chain.
    function digest(bytes32 hash, uint256 chainId) internal pure returns (bytes32) {
        bytes32 payload = keccak256(abi.encode(PREFIX, chainId, hash));
        return
            keccak256(
                abi.encodePacked("\x19Ethereum Signed Message:\n32", payload)
            );
    }

    /// @notice Recover the TEE node address that signed this result.
    function recoverSigner(
        bytes calldata data,
        bytes32 actionId,
        string calldata submissionTag,
        uint8 status,
        bytes calldata signature
    ) internal view returns (address) {
        return
            _recover(
                digest(resultHash(data, actionId, submissionTag, status), block.chainid),
                signature
            );
    }

    function _recover(bytes32 hash, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) revert BadSignatureLength(signature.length);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        // go-ethereum emits the raw recovery id (0/1); ecrecover wants 27/28.
        // tee-node normalises one way and ethers the other, so both arrive here.
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert MalleableSignature();
        // Reject the mirrored s. Without this every authorisation has a second
        // valid encoding, which breaks any "seen this signature" bookkeeping
        // built on top.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert MalleableSignature();
        }
        return ecrecover(hash, v, r, s);
    }
}
