// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPredictVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[4] calldata pubSignals
    ) external view returns (bool);
}

interface IMarketRef {
    function isResolved(bytes32 id) external view returns (bool);

    function winningOutcome(bytes32 id) external view returns (uint32);

    /// @dev Reverts for a market that does not exist — which is exactly what we
    ///      want when someone tries to escrow into a made-up id.
    function getMarket(
        bytes32 id
    )
        external
        view
        returns (string memory question, uint64 closeTs, uint8 status, uint32 outcome);
}

/// @title PredictEscrow — pari-mutuel stake escrow, collateralized in **FXRP**.
///
/// @notice Stakes are escrowed in FXRP, the FAssets representation of XRP on
/// Flare. Winners split the entire pot pro-rata to their stake on the winning
/// side, minus a 2% fee.
///
/// @dev THIS IS THE POINT OF THE FLARE PORT. On Avalanche the collateral was
///      `mUSDC`, a mock ERC-20 with an open `mint()` faucet — play money that
///      represented nothing. Here the collateral is FXRP: a real, 1:1,
///      over-collateralized claim on XRP held by FAssets agents, redeemable
///      back to native XRP on the XRP Ledger at any time.
///
///      That changes what the product IS. An XRP holder can take a position on
///      a price outcome denominated in their own asset, settle it against
///      Flare's native oracle, and redeem the proceeds back to XRPL — without
///      the asset ever leaving Flare's custody model, and without touching a
///      centralized bridge or an exchange. The escrow logic below is the same
///      pari-mutuel math as the Avalanche version; what it holds is not.
///
///      DECIMALS: FXRP carries 6 decimals (XRP is denominated in drops, 1 XRP =
///      1e6 drops), where the old mUSDC used 7. This contract is decimal-
///      agnostic — it moves whatever units the token uses — but every caller
///      (scripts, backend, SDK, UI) must use 6.
contract PredictEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice FXRP — the FAssets-wrapped XRP used as collateral.
    IERC20 public immutable fxrp;
    IPredictVerifier public immutable verifier;
    IMarketRef public immutable market;

    /// @notice Fee recipient. Immutable: the original declared this mutable but
    ///         shipped no setter, so it was already frozen at deploy — making
    ///         that explicit removes the misleading surface.
    address public immutable vault;

    uint256 public constant FEE_BPS = 200; // 2%

    mapping(bytes32 => mapping(uint32 => uint256)) public pool; // market → outcome → staked
    mapping(bytes32 => uint256) public total; // market → total staked
    mapping(bytes32 => mapping(uint32 => mapping(address => uint256)))
        public position;
    mapping(bytes32 => mapping(address => bool)) public redeemed;
    mapping(uint256 => bool) public nullifierUsed;

    event Bet(
        bytes32 indexed marketId,
        address indexed bettor,
        uint32 outcome,
        uint256 amount
    );
    event Redeem(
        bytes32 indexed marketId,
        address indexed bettor,
        uint256 payout
    );

    error ZeroAmount();
    error NotResolved();
    error AlreadyRedeemed();
    error NoWinningPosition();
    error NullifierSpent();
    error BadProof();
    error MarketClosed();
    error BadOutcome();
    error ZeroAddress();

    constructor(
        IERC20 _fxrp,
        IPredictVerifier _verifier,
        IMarketRef _market,
        address _vault
    ) {
        if (
            address(_fxrp) == address(0) ||
            address(_verifier) == address(0) ||
            address(_market) == address(0)
        ) revert ZeroAddress();
        fxrp = _fxrp;
        verifier = _verifier;
        market = _market;
        vault = _vault; // address(0) is allowed — fee is then retained
    }

    // ── betting ────────────────────────────────────────────────────────────

    function _escrow(
        bytes32 marketId,
        uint32 outcome,
        uint256 amount
    ) internal {
        if (amount == 0) revert ZeroAmount();
        // Binary market: only YES(0) and NO(1) are stakeable. Staking outcome 2+
        // would create a pool that can never win and never be refunded by the
        // pro-rata path.
        if (outcome > 1) revert BadOutcome();
        // No new stake once the market has resolved — a late bet could never be
        // redeemed fairly (it isn't part of the pool the winners split).
        if (market.isResolved(marketId)) revert MarketClosed();

        // CRITICAL: betting must stop at close, not at resolution.
        //
        // Settlement reads the FTSO price at close, and that price is public the
        // instant close passes. Resolution is permissionless, so there is always
        // a window — seconds or hours — between close and someone calling
        // resolve. Allowing bets in that window lets anyone read the settled
        // outcome and then stake on the winning side risk-free, taking the pot
        // from everyone who bet before they knew.
        //
        // getMarket also reverts on an unknown id, so this simultaneously stops
        // FXRP being escrowed into a market that does not exist — funds that
        // could never be redeemed because the market can never resolve.
        (, uint64 closeTs, , ) = market.getMarket(marketId);
        if (block.timestamp >= closeTs) revert MarketClosed();

        // FXRP is a real FAssets token; use SafeERC20 rather than assuming a
        // bool return, and measure the delta so any future fee-on-transfer
        // behaviour credits what actually arrived instead of what was asked for.
        uint256 before = fxrp.balanceOf(address(this));
        fxrp.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = fxrp.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();

        pool[marketId][outcome] += received;
        total[marketId] += received;
        position[marketId][outcome][msg.sender] += received;
        emit Bet(marketId, msg.sender, outcome, received);
    }

    /// Plain pari-mutuel bet.
    function bet(
        bytes32 marketId,
        uint32 outcome,
        uint256 amount
    ) external nonReentrant {
        _escrow(marketId, outcome, amount);
    }

    /// ZK-gated bet: every live bet carries a fresh single-use proof, checked
    /// on-chain before escrow (public signals `[root, nullifierHash, outcome,
    /// recipient]`).
    ///
    /// @dev The ZK gate here is an anti-replay/single-use nullifier check over a
    ///      throwaway note — the stake is escrowed TRANSPARENTLY to `outcome`
    ///      and the bettor pays their own funds, so there is no hidden position
    ///      to bind. Binding `pubSignals[2] == outcome` would break NO-side bets
    ///      (proofs are minted with outcome=0) without adding security. The
    ///      genuinely side-hiding path is ConfidentialBet, not this one.
    function betZk(
        bytes32 marketId,
        uint32 outcome,
        uint256 amount,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[4] calldata pubSignals
    ) external nonReentrant {
        uint256 nullifier = pubSignals[1];
        if (nullifierUsed[nullifier]) revert NullifierSpent();
        if (!verifier.verifyProof(a, b, c, pubSignals)) revert BadProof();
        nullifierUsed[nullifier] = true;
        _escrow(marketId, outcome, amount);
    }

    // ── settlement ─────────────────────────────────────────────────────────

    /// Redeem the winning pro-rata share after resolution (2% fee → vault).
    /// @dev Callable by anyone on behalf of `bettor`; the payout always goes to
    ///      `bettor`, so a third party (or a keeper) can settle for a user
    ///      without being able to redirect funds.
    function redeem(
        bytes32 marketId,
        address bettor
    ) external nonReentrant returns (uint256 net) {
        if (!market.isResolved(marketId)) revert NotResolved();
        if (redeemed[marketId][bettor]) revert AlreadyRedeemed();
        redeemed[marketId][bettor] = true;

        uint32 win = market.winningOutcome(marketId);
        uint256 winPool = pool[marketId][win];

        // Degenerate market: nobody staked the winning side, so there is no
        // pro-rata pool to split. Refund each caller their own stake (no fee)
        // instead of locking the losing side's funds forever.
        if (winPool == 0) {
            net =
                position[marketId][0][bettor] +
                position[marketId][1][bettor];
            if (net == 0) revert NoWinningPosition();
            fxrp.safeTransfer(bettor, net);
            emit Redeem(marketId, bettor, net);
            return net;
        }

        uint256 stake = position[marketId][win][bettor];
        if (stake == 0) revert NoWinningPosition();

        uint256 gross = (stake * total[marketId]) / winPool;
        uint256 fee = (gross * FEE_BPS) / 10_000;
        net = gross - fee;

        if (vault != address(0) && fee > 0) {
            fxrp.safeTransfer(vault, fee);
        }
        fxrp.safeTransfer(bettor, net);
        emit Redeem(marketId, bettor, net);
    }

    // ── views ──────────────────────────────────────────────────────────────

    /// @notice What `bettor` would receive if the market resolved to `outcome`.
    /// @dev Lets the UI show a live "if this resolves YES you get X" figure
    ///      using the exact math settlement will use.
    function previewPayout(
        bytes32 marketId,
        address bettor,
        uint32 outcome
    ) external view returns (uint256 net, uint256 fee) {
        uint256 winPool = pool[marketId][outcome];
        if (winPool == 0) return (0, 0);
        uint256 stake = position[marketId][outcome][bettor];
        if (stake == 0) return (0, 0);
        uint256 gross = (stake * total[marketId]) / winPool;
        fee = (gross * FEE_BPS) / 10_000;
        net = gross - fee;
    }

    function pools(
        bytes32 marketId
    ) external view returns (uint256 yesPool, uint256 noPool, uint256 totalPool) {
        return (pool[marketId][0], pool[marketId][1], total[marketId]);
    }
}
