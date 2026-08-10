// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal views of Flare's TEE registries — the same local-interface
///         pattern the rest of this repo uses rather than pulling in the whole
///         flare-smart-contracts-v2 tree.
interface ITeeExtensionRegistry {
    struct TeeInstructionParams {
        bytes32 opType;
        bytes32 opCommand;
        bytes message;
        address[] cosigners;
        uint64 cosignersThreshold;
        address claimBackAddress;
    }

    function sendInstructions(
        address[] calldata _teeIds,
        TeeInstructionParams calldata _instructionParams
    ) external payable returns (bytes32 _instructionId);

    function nextPublicExtensionId() external view returns (uint256);

    function getTeeExtensionInstructionsSender(uint256 _extensionId) external view returns (address);
}

interface ITeeMachineRegistry {
    function getRandomTeeIds(
        uint256 _extensionId,
        uint256 _numberOfTeeIds
    ) external view returns (address[] memory);
}

/**
 * @title MolfiInstructionSender — the on-chain door to Molfi's enclave.
 *
 * @notice Everything Molfi's TEE has done so far was asked of it over HTTP. That
 *         works, and it is how the settlement keeper will keep working, but it
 *         leaves the interesting property on the table: a request made this way
 *         is a TRANSACTION. Flare's data providers pick it up, relay it to a TEE
 *         machine chosen by the registry, and the enclave's answer comes back
 *         signed by the node's attested identity.
 *
 *         That means the whole settlement of a sealed market — who asked, when,
 *         which machine answered, and what it said — is on the public record,
 *         and no part of it depends on our infrastructure being honest or even
 *         running.
 *
 * @dev The registry enforces this at the protocol level: `sendInstructions`
 *      reverts unless `msg.sender` is the InstructionSender registered for the
 *      extension. So this contract is not a convenience wrapper — it is the only
 *      address on Earth that can route a MOLFI instruction, and the extension id
 *      binds it to Molfi's registered extension specifically.
 *
 *      `setExtensionId()` is copied verbatim from the Flare scaffold, including
 *      its linear scan. It is single-shot and permissionless: there is nothing to
 *      grief, since it can only ever find the id whose registered sender is this
 *      contract.
 */
contract MolfiInstructionSender {
    // Must match molfi-fcc/extension/src/app/config.ts exactly, or instructions
    // arrive at the extension and fall through to "unsupported op type".
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_TYPE_MOLFI = bytes32("MOLFI");
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_SEAL_KEY = bytes32("SEAL_KEY");
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_OPEN_BOOK = bytes32("OPEN_BOOK");

    ITeeExtensionRegistry public immutable TEE_EXTENSION_REGISTRY;
    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;

    /// @notice The registry reserves ids below this for system extensions.
    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000;

    uint256 private _extensionId;

    event OpenBookRequested(bytes32 indexed instructionId, bytes32 indexed marketId, address indexed requester);
    event SealKeyRequested(bytes32 indexed instructionId, address indexed requester);

    error ZeroAddress();
    error NoCode();
    error ExtensionIdAlreadySet();
    error ExtensionIdNotFound();
    error ExtensionIdNotSet();

    constructor(ITeeExtensionRegistry _extensionRegistry, ITeeMachineRegistry _machineRegistry) {
        if (address(_extensionRegistry) == address(0) || address(_machineRegistry) == address(0)) {
            revert ZeroAddress();
        }
        if (address(_extensionRegistry).code.length == 0 || address(_machineRegistry).code.length == 0) {
            revert NoCode();
        }
        TEE_EXTENSION_REGISTRY = _extensionRegistry;
        TEE_MACHINE_REGISTRY = _machineRegistry;
    }

    /// @notice Find and cache this contract's extension id. Single-shot.
    /// @dev DO NOT MODIFY — copied from the Flare scaffold.
    function setExtensionId() external {
        if (_extensionId != 0) revert ExtensionIdAlreadySet();
        uint256 c = TEE_EXTENSION_REGISTRY.nextPublicExtensionId();
        for (uint256 i = FIRST_PUBLIC_EXTENSION_ID; i < c; ++i) {
            if (TEE_EXTENSION_REGISTRY.getTeeExtensionInstructionsSender(i) == address(this)) {
                _extensionId = i;
                return;
            }
        }
        revert ExtensionIdNotFound();
    }

    function extensionId() external view returns (uint256) {
        return _getExtensionId();
    }

    /**
     * @notice Ask the enclave to open a closed sealed book.
     *
     * @dev Permissionless, and deliberately so. The enclave refuses to open a
     *      market that has not closed, and `SealedBidBook` refuses an opening
     *      that does not reconcile with the escrow it holds — so the worst a
     *      spammer achieves is paying the registry fee for an answer that says
     *      no. Gating it would instead make settlement depend on one operator
     *      still being around, which is the failure this whole path removes.
     *
     * @param marketId The market to open. Sent as the raw 32-byte word, which is
     *        what `abi.encode(bytes32)` is — the extension accepts exactly that.
     */
    function sendOpenBook(bytes32 marketId) external payable returns (bytes32 instructionId) {
        instructionId = _send(OP_COMMAND_OPEN_BOOK, abi.encode(marketId));
        emit OpenBookRequested(instructionId, marketId, msg.sender);
    }

    /// @notice Ask the enclave to publish its sealing key, on the record.
    /// @dev The key is public by design; routing the request through the chain
    ///      makes the ANSWER attributable to the registered machine, which a
    ///      plain HTTP fetch from our own server is not.
    function sendSealKey() external payable returns (bytes32 instructionId) {
        instructionId = _send(OP_COMMAND_SEAL_KEY, "");
        emit SealKeyRequested(instructionId, msg.sender);
    }

    function _send(bytes32 opCommand, bytes memory message) private returns (bytes32) {
        // One machine per instruction. The registry picks which — we do not get
        // to choose a friendly one.
        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
        address[] memory cosigners = new address[](0);

        return
            TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(
                teeIds,
                ITeeExtensionRegistry.TeeInstructionParams({
                    opType: OP_TYPE_MOLFI,
                    opCommand: opCommand,
                    message: message,
                    cosigners: cosigners,
                    cosignersThreshold: 0,
                    // Unspent fee returns to the caller, not to this contract —
                    // otherwise dust accumulates here with no way out.
                    claimBackAddress: msg.sender
                })
            );
    }

    function _getExtensionId() private view returns (uint256) {
        if (_extensionId == 0) revert ExtensionIdNotSet();
        return _extensionId;
    }
}
