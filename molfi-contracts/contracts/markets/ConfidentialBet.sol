// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IConfidentialBetVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[4] calldata pubSignals
    ) external view returns (bool);
}

interface IMolfiMarket {
    function isResolved(bytes32 id) external view returns (bool);

    function winningOutcome(bytes32 id) external view returns (uint32);
}

/// @title ConfidentialBet — hidden-side positions, collateralized in FXRP.
///
/// @notice You commit to a note that encodes which side you backed, staked in a
/// fixed FXRP denomination. After the market resolves you prove in zero
/// knowledge that your note backed the *winning* side, and collect — without
/// ever revealing which note was yours or which side you took.
///
/// @dev The soundness trick is that the CONTRACT injects the resolved winner as
///      a public input, so the prover cannot choose it. A note that backed the
///      losing side simply is not a member of the tree under that public input,
///      and no proof exists for it. The nullifier prevents double-claiming.
///
///      Ported to Flare unchanged in logic — the ZK layer is BN254 Groth16 and
///      Flare exposes the standard EVM pairing precompiles, so the verifier is
///      byte-identical to the Avalanche deployment and the same proving key
///      still works. What changed is the collateral: FXRP instead of a mock
///      token, so a hidden position is now denominated in real bridged XRP.
///
///      HONEST SCOPE: the anonymity set is only as large as the set of
///      commitments sharing a registered root, and the Poseidon tree is built
///      off-chain and checkpointed by an operator (`registerRoot`), because the
///      EVM has no native Poseidon. Side-hiding, outcome-binding and the
///      single-use nullifier are all real and enforced on-chain; a permissionless
///      on-chain accumulator is the production follow-up.
contract ConfidentialBet is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice FXRP — FAssets-wrapped XRP.
    IERC20 public immutable collateral;
    IConfidentialBetVerifier public immutable verifier;
    IMolfiMarket public immutable market;

    /// @notice Fixed stake per note. Uniform by design: a variable stake would
    ///         leak position size on-chain and shrink the anonymity set to one.
    ///         FXRP has 6 decimals, so 1 FXRP == 1_000_000.
    uint256 public immutable denom;

    uint256 public constant PAYOUT_MULT = 2; // even-odds binary payout

    address public admin;

    uint256[] public commitments; // note commitments (off-chain Poseidon tree)
    mapping(uint256 => bool) public knownRoot; // checkpointed off-chain roots
    mapping(uint256 => bool) public nullifierUsed;

    event Commit(uint256 indexed index, uint256 commitment, uint256 amount);
    event RootRegistered(uint256 root);
    event Claim(
        uint256 indexed nullifierHash,
        address indexed recipient,
        uint256 amount
    );
    event AdminTransferred(address indexed from, address indexed to);

    error NotAdmin();
    error NotResolved();
    error UnknownRoot();
    error NullifierSpent();
    error BadProof();
    error ZeroAddress();
    error ZeroDenom();
    error InsufficientPool(uint256 needed, uint256 available);
    error DuplicateCommitment();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(
        IERC20 _collateral,
        IConfidentialBetVerifier _verifier,
        IMolfiMarket _market,
        uint256 _denom
    ) {
        if (
            address(_collateral) == address(0) ||
            address(_verifier) == address(0) ||
            address(_market) == address(0)
        ) revert ZeroAddress();
        if (_denom == 0) revert ZeroDenom();
        collateral = _collateral;
        verifier = _verifier;
        market = _market;
        denom = _denom;
        admin = msg.sender;
    }

    /// Escrow `denom` FXRP and record a hidden-side note `commitment`. Returns
    /// the leaf index (position in the off-chain Poseidon tree).
    function commit(
        uint256 commitment
    ) external nonReentrant returns (uint256 index) {
        // A repeated commitment would share a nullifier with the original note,
        // so the second depositor could never claim — reject rather than take
        // funds for an unclaimable position.
        if (_commitmentSeen[commitment]) revert DuplicateCommitment();
        _commitmentSeen[commitment] = true;

        collateral.safeTransferFrom(msg.sender, address(this), denom);
        index = commitments.length;
        commitments.push(commitment);
        emit Commit(index, commitment, denom);
    }

    mapping(uint256 => bool) private _commitmentSeen;

    /// Operator checkpoints a Poseidon tree root computed off-chain from the
    /// commitments (the EVM has no native Poseidon, matching the original design).
    function registerRoot(uint256 root) external onlyAdmin {
        knownRoot[root] = true;
        emit RootRegistered(root);
    }

    /// Claim a winning note. Verifies the ZK proof that the note's side equals
    /// the resolved winner, burns the nullifier, and pays `denom * PAYOUT_MULT`.
    /// @param recipient payout address; also bound into the proof (public signal
    ///        `recipient` == uint160(recipient)) so a valid proof can't be
    ///        re-pointed to a different address by a front-runner.
    function claim(
        bytes32 marketId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256 root,
        uint256 nullifierHash,
        address recipient
    ) external nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        if (!market.isResolved(marketId)) revert NotResolved();
        if (!knownRoot[root]) revert UnknownRoot();
        if (nullifierUsed[nullifierHash]) revert NullifierSpent();

        // The winner comes from the market, never from the caller — this is what
        // makes a losing note unprovable.
        uint32 outcome = market.winningOutcome(marketId);
        uint256[4] memory pub = [
            root,
            nullifierHash,
            uint256(outcome),
            uint256(uint160(recipient))
        ];
        if (!verifier.verifyProof(a, b, c, pub)) revert BadProof();

        nullifierUsed[nullifierHash] = true;
        uint256 payout = denom * PAYOUT_MULT;
        uint256 available = collateral.balanceOf(address(this));
        if (available < payout) revert InsufficientPool(payout, available);

        collateral.safeTransfer(recipient, payout);
        emit Claim(nullifierHash, recipient, payout);
    }

    function transferAdmin(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, next);
        admin = next;
    }

    function commitmentCount() external view returns (uint256) {
        return commitments.length;
    }

    function allCommitments() external view returns (uint256[] memory) {
        return commitments;
    }

    /// @notice Collateral held, and how many outstanding claims it can cover.
    /// @dev The pool pays 2x per winning note, so it must be seeded beyond the
    ///      committed stakes. Surfacing this lets the UI warn before a claim
    ///      would fail rather than after.
    function poolStatus()
        external
        view
        returns (uint256 balance, uint256 claimsCovered)
    {
        balance = collateral.balanceOf(address(this));
        claimsCovered = balance / (denom * PAYOUT_MULT);
    }
}
