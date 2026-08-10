// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Stands in for FlareTeeManager so MolfiInstructionSender's own logic —
///         extension-id resolution, op identifiers, fee forwarding — can be
///         tested in memory. The real registry is a diamond at a fixed Coston2
///         address with no code on a bare Hardhat network.
contract MockTeeRegistry {
    struct TeeInstructionParams {
        bytes32 opType;
        bytes32 opCommand;
        bytes message;
        address[] cosigners;
        uint64 cosignersThreshold;
        address claimBackAddress;
    }

    uint256 public nextPublicExtensionId = 0x10000;
    mapping(uint256 => address) public senderOf;
    address[] public machines;

    /// Last instruction seen, so tests can assert exactly what was routed.
    bytes32 public lastOpType;
    bytes32 public lastOpCommand;
    bytes public lastMessage;
    address public lastClaimBack;
    uint256 public lastValue;
    uint256 public lastTeeCount;
    uint256 public callCount;

    /// @notice Mimics the registry handing out ids from FIRST_PUBLIC_EXTENSION_ID up.
    function register(address sender) external returns (uint256 id) {
        id = nextPublicExtensionId;
        senderOf[id] = sender;
        nextPublicExtensionId = id + 1;
    }

    /// @dev Lets a test place a sender at a HIGH id, so the scan has to walk.
    function registerAt(uint256 id, address sender) external {
        senderOf[id] = sender;
        if (id >= nextPublicExtensionId) nextPublicExtensionId = id + 1;
    }

    function addMachine(address m) external {
        machines.push(m);
    }

    function getTeeExtensionInstructionsSender(uint256 id) external view returns (address) {
        return senderOf[id];
    }

    function getRandomTeeIds(uint256, uint256 n) external view returns (address[] memory out) {
        out = new address[](n);
        for (uint256 i = 0; i < n; i++) out[i] = machines[i % machines.length];
    }

    function sendInstructions(
        address[] calldata teeIds,
        TeeInstructionParams calldata p
    ) external payable returns (bytes32) {
        lastOpType = p.opType;
        lastOpCommand = p.opCommand;
        lastMessage = p.message;
        lastClaimBack = p.claimBackAddress;
        lastValue = msg.value;
        lastTeeCount = teeIds.length;
        callCount += 1;
        return keccak256(abi.encode(p.opType, p.opCommand, p.message, callCount));
    }
}
