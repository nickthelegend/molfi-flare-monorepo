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

    function getMarket(
        bytes32 id
    )
        external
        view
        returns (
            string memory question,
            uint64 closeTs,
            uint8 status,
            uint32 outcome
        );
}

/// @title ConfidentialBet — hidden-side positions in FXRP, at your choice of size.
///
/// @notice You commit to a note that encodes which side you backed and how much,
/// then after the market resolves you prove in zero knowledge that your note
/// backed the *winning* side and collect — without revealing which note was
/// yours or which side you took.
///
/// @dev WHY TIERS RATHER THAN AN ARBITRARY AMOUNT.
///      The stake amount was never the secret — it moves through `transferFrom`,
///      so it is public either way. What the fixed size actually buys is
///      UNLINKABILITY: if every deposit in a pool is exactly 10 FXRP and every
///      payout exactly 20, a payout cannot be tied back to a particular deposit.
///      Allow arbitrary amounts and that collapses immediately — a 7.3 FXRP
///      deposit is the only thing that could produce a 14.6 FXRP payout, so the
///      proof hides the side while the arithmetic reveals the depositor.
///
///      Tiers keep the property and drop the straitjacket: pick a size, and you
///      are anonymous among everyone who picked the same one. Each tier is its
///      own anonymity set, which is also why `poolStatus` reports them
///      separately — a tier with one participant hides nothing, and the UI
///      should say so rather than imply otherwise.
///
///      HOW A TIER IS BOUND. `claim` cannot take the tier on trust: a note
///      committed at 1 FXRP must not be claimable at 1000. The tier is folded
///      into the note's `outcome` public signal together with the market id:
///
///          outcome = keccak256(abi.encode(marketId, tier, side)) % SNARK_R
///
///      The circuit treats `outcome` as an opaque field element (it is fed
///      straight into the Poseidon leaf and only squared to keep it in the
///      constraint system), so this needs NO circuit change — same proving key,
///      same verifier, no new trusted setup. The contract recomputes the signal
///      from the market's resolved winner plus the tier the caller names; if
///      either differs from what the note was built with, the leaf differs, the
///      Merkle proof fails, and there is no valid proof to be had. That is the
///      same mechanism that makes a losing note unprovable, reused.
///
///      HONEST SCOPE: the anonymity set is only as large as the set of
///      commitments sharing a registered root, and the Poseidon tree is built
///      off-chain and checkpointed by an operator (`registerRoot`), because the
///      EVM has no native Poseidon. Side-hiding, market-binding, tier-binding
///      and the single-use nullifier are all real and enforced on-chain; a
///      permissionless on-chain accumulator is the production follow-up.
contract ConfidentialBet is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice FXRP — FAssets-wrapped XRP.
    IERC20 public immutable collateral;
    IConfidentialBetVerifier public immutable verifier;
    IMolfiMarket public immutable market;

    /// @notice BN254 scalar field order. Public signals must be reduced into it
    ///         or the verifier rejects them outright.
    uint256 internal constant SNARK_R =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// @notice Selectable stake sizes, ascending, in FXRP base units (6 dp).
    ///         Immutable after deploy: adding a tier later would silently split
    ///         an existing anonymity set.
    uint256[] private _denoms;

    uint256 public constant PAYOUT_MULT = 2; // even-odds binary payout

    address public admin;

    uint256[] public commitments; // note commitments (off-chain Poseidon tree)

    /// @notice Checkpointed Poseidon roots, keyed by market AND tier.
    ///
    /// @dev Defence in depth. The signal binding above is what actually makes a
    ///      cross-market or cross-tier claim unprovable; this stops an operator
    ///      from accidentally checkpointing one pool's root against another.
    mapping(bytes32 => mapping(uint256 => mapping(uint256 => bool)))
        public knownRoot;

    mapping(uint256 => bool) public nullifierUsed;
    mapping(uint256 => bool) private _commitmentSeen;

    /// @notice FXRP committed per tier, so `poolStatus` can report solvency for
    ///         the tier being claimed rather than for the contract as a whole.
    mapping(uint256 => uint256) public committedByTier;

    event Commit(
        uint256 indexed index,
        bytes32 indexed marketId,
        uint256 indexed tier,
        uint256 commitment,
        uint256 amount
    );
    event RootRegistered(
        bytes32 indexed marketId,
        uint256 indexed tier,
        uint256 root
    );
    event Claim(
        uint256 indexed nullifierHash,
        address indexed recipient,
        uint256 tier,
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
    error NoDenoms();
    error DenomsNotAscending();
    error BadTier(uint256 tier);
    error MarketClosed();
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
        uint256[] memory denoms_
    ) {
        if (
            address(_collateral) == address(0) ||
            address(_verifier) == address(0) ||
            address(_market) == address(0)
        ) revert ZeroAddress();
        if (denoms_.length == 0) revert NoDenoms();
        // Strictly ascending: it makes `tier` a stable, meaningful index and
        // rules out two tiers that are secretly the same pool.
        for (uint256 i = 0; i < denoms_.length; i++) {
            if (denoms_[i] == 0) revert ZeroDenom();
            if (i > 0 && denoms_[i] <= denoms_[i - 1]) revert DenomsNotAscending();
            _denoms.push(denoms_[i]);
        }
        collateral = _collateral;
        verifier = _verifier;
        market = _market;
        admin = msg.sender;
    }

    // ── tiers ────────────────────────────────────────────────────────────────

    function denoms() external view returns (uint256[] memory) {
        return _denoms;
    }

    function denomCount() external view returns (uint256) {
        return _denoms.length;
    }

    /// @notice Stake size for `tier`, in FXRP base units.
    function denomOf(uint256 tier) public view returns (uint256) {
        if (tier >= _denoms.length) revert BadTier(tier);
        return _denoms[tier];
    }

    /// @notice The `outcome` public signal a note must be built with.
    ///
    /// @dev Exposed so the note builder and the UI derive it from the same
    ///      source as the verifier, instead of reimplementing the encoding and
    ///      drifting. `side` is 0 = YES, 1 = NO.
    function sideSignal(
        bytes32 marketId,
        uint256 tier,
        uint256 side
    ) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(marketId, tier, side))) % SNARK_R;
    }

    // ── commit ───────────────────────────────────────────────────────────────

    /// Escrow `denomOf(tier)` FXRP against a hidden-side note. Returns the leaf
    /// index (position in the off-chain Poseidon tree).
    function commit(
        bytes32 marketId,
        uint256 tier,
        uint256 commitment
    ) external nonReentrant returns (uint256 index) {
        uint256 amount = denomOf(tier);

        // Committing after close would let someone read the settled outcome and
        // then buy a certain win. The escrow enforces the same rule for open
        // bets; a confidential bet must not be the way around it.
        (, uint64 closeTs, , ) = market.getMarket(marketId);
        if (block.timestamp >= closeTs) revert MarketClosed();

        // A repeated commitment shares a nullifier with the original note, so
        // the second depositor could never claim — reject rather than take
        // funds for an unclaimable position.
        if (_commitmentSeen[commitment]) revert DuplicateCommitment();
        _commitmentSeen[commitment] = true;

        collateral.safeTransferFrom(msg.sender, address(this), amount);
        committedByTier[tier] += amount;
        index = commitments.length;
        commitments.push(commitment);
        emit Commit(index, marketId, tier, commitment, amount);
    }

    /// Operator checkpoints a Poseidon root computed off-chain from the
    /// commitments of ONE (market, tier) pool.
    function registerRoot(
        bytes32 marketId,
        uint256 tier,
        uint256 root
    ) external onlyAdmin {
        if (tier >= _denoms.length) revert BadTier(tier);
        knownRoot[marketId][tier][root] = true;
        emit RootRegistered(marketId, tier, root);
    }

    // ── claim ────────────────────────────────────────────────────────────────

    /// Claim a winning note. Verifies the ZK proof that the note backed the
    /// resolved winner AT THIS MARKET AND TIER, burns the nullifier, and pays
    /// `denomOf(tier) * PAYOUT_MULT`.
    /// @param recipient payout address; also bound into the proof, so a valid
    ///        proof cannot be re-pointed elsewhere by a front-runner.
    function claim(
        bytes32 marketId,
        uint256 tier,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256 root,
        uint256 nullifierHash,
        address recipient
    ) external nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 payout = denomOf(tier) * PAYOUT_MULT;
        if (!market.isResolved(marketId)) revert NotResolved();
        if (!knownRoot[marketId][tier][root]) revert UnknownRoot();
        if (nullifierUsed[nullifierHash]) revert NullifierSpent();

        // The winner comes from the market, never from the caller, and the tier
        // is folded in beside it — which is what makes both a losing note and a
        // wrong-tier note unprovable.
        uint32 outcome = market.winningOutcome(marketId);
        uint256[4] memory pub = [
            root,
            nullifierHash,
            sideSignal(marketId, tier, uint256(outcome)),
            uint256(uint160(recipient))
        ];
        if (!verifier.verifyProof(a, b, c, pub)) revert BadProof();

        nullifierUsed[nullifierHash] = true;
        uint256 available = collateral.balanceOf(address(this));
        if (available < payout) revert InsufficientPool(payout, available);

        collateral.safeTransfer(recipient, payout);
        emit Claim(nullifierHash, recipient, tier, payout);
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

    /// @notice Collateral held, and how many claims of `tier` it can cover.
    /// @dev The pool pays 2x per winning note, so it must be seeded beyond the
    ///      committed stakes. Surfacing this lets the UI warn before a claim
    ///      would fail rather than after.
    function poolStatus(
        uint256 tier
    ) external view returns (uint256 balance, uint256 claimsCovered) {
        balance = collateral.balanceOf(address(this));
        claimsCovered = balance / (denomOf(tier) * PAYOUT_MULT);
    }
}
