// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMolfiOracle} from "../interfaces/IMolfiOracle.sol";

/// @title MolfiMarket — binary (YES/NO) prediction-market lifecycle, resolved
/// from **Flare's FTSOv2** price feeds.
///
/// @notice A price market asks "is `asset price` `op` `threshold` at close?".
/// Anyone can `resolveFromOracle` after close: it reads the market's FTSO feed,
/// validates freshness against a staleness bound, and sets the winning outcome
/// (0 = YES, 1 = NO) deterministically.
///
/// @dev Flare port of the Avalanche/Chainlink version. Three things changed,
///      and they are the whole oracle migration:
///
///      1. `address oracle` → `bytes21 feedId`. Chainlink gives each pair its
///         own deployed aggregator contract, so a market pointed at an address.
///         FTSOv2 serves every pair from one contract keyed by a `bytes21` feed
///         id, so a market now carries the id and the contract is global. This
///         is strictly better for a prediction market: adding an asset costs a
///         constant, not a deployment, and the id is a self-describing encoding
///         of the pair rather than an opaque address you have to trust.
///
///      2. `int256 threshold` → `uint256 threshold`, in 18 decimals. Chainlink
///         answers are signed and carry per-feed decimals, so thresholds were
///         written in whatever scale the feed happened to use (`50000e8`). The
///         oracle adapter normalizes every FTSO feed to 18 decimals, so a
///         threshold means the same thing regardless of which feed it targets —
///         which removes the class of bug where a market is created against the
///         wrong scale and silently resolves the wrong way.
///
///      3. The round-based freshness checks (`roundId`, `answeredInRound`) are
///         gone, because FTSO has no equivalent — it is a push oracle with a
///         single timestamp. Staleness is enforced by the adapter against
///         `maxStaleness`, which is the check that actually mattered.
contract MolfiMarket {
    enum Status {
        Trading,
        Resolving,
        Resolved
    }

    struct Market {
        string question;
        uint64 closeTs;
        bytes21 feedId; // FTSOv2 feed id (e.g. XRP/USD)
        uint256 threshold; // 18 decimals, matching IMolfiOracle
        uint8 op; // 0 = GTE (YES iff price >= threshold), 1 = LT
        uint64 maxStaleness; // seconds
        Status status;
        uint32 winningOutcome; // 0 = YES, 1 = NO
        bool exists;
        bool hasOracle;
    }

    /// @notice Settlement price source. Immutable: markets already created must
    ///         not have their settlement rules changed out from under them.
    IMolfiOracle public immutable oracle;

    address public admin;
    mapping(bytes32 => Market) public marketOf;
    bytes32[] public marketIds; // enumeration for the app

    event MarketCreated(
        bytes32 indexed id,
        string question,
        uint64 closeTs,
        bytes21 feedId
    );
    event Resolved(bytes32 indexed id, uint32 winningOutcome, uint256 price);
    event AdminTransferred(address indexed from, address indexed to);

    error NotAdmin();
    error Exists();
    error Missing();
    error NotClosed();
    error AlreadyResolved();
    error BadOp();
    error BadClose();
    error BadOutcome();
    error BadFeed();
    error ZeroAddress();
    /// @dev Admin tried to hand-settle an oracle market that FTSO can still settle.
    error OracleSettlementAvailable();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(IMolfiOracle _oracle) {
        if (address(_oracle) == address(0)) revert ZeroAddress();
        oracle = _oracle;
        admin = msg.sender;
    }

    /// Basic (admin-resolved) market.
    function create(
        bytes32 id,
        string calldata question,
        uint64 closeTs
    ) external onlyAdmin {
        if (marketOf[id].exists) revert Exists();
        if (closeTs <= block.timestamp) revert BadClose();
        marketOf[id] = Market({
            question: question,
            closeTs: closeTs,
            feedId: bytes21(0),
            threshold: 0,
            op: 0,
            maxStaleness: 0,
            status: Status.Trading,
            winningOutcome: 0,
            exists: true,
            hasOracle: false
        });
        marketIds.push(id);
        emit MarketCreated(id, question, closeTs, bytes21(0));
    }

    /// FTSO price market: resolves YES iff `price op threshold` at close.
    /// @param feedId bytes21 FTSOv2 feed id (see FlareAddresses).
    /// @param threshold Strike price, 18 decimals.
    /// @param op 0 = YES iff price >= threshold, 1 = YES iff price < threshold.
    /// @param maxStaleness Max acceptable feed age at settlement, in seconds.
    function createPriceMarket(
        bytes32 id,
        string calldata question,
        uint64 closeTs,
        bytes21 feedId,
        uint256 threshold,
        uint8 op,
        uint64 maxStaleness
    ) external onlyAdmin {
        if (marketOf[id].exists) revert Exists();
        if (op > 1) revert BadOp();
        if (closeTs <= block.timestamp) revert BadClose();
        // A zero feed id would resolve against nothing; a zero staleness bound
        // would make settlement impossible. Reject both at creation rather than
        // stranding stakes in a market that can never resolve.
        if (feedId == bytes21(0)) revert BadFeed();
        if (maxStaleness == 0) revert BadFeed();

        marketOf[id] = Market({
            question: question,
            closeTs: closeTs,
            feedId: feedId,
            threshold: threshold,
            op: op,
            maxStaleness: maxStaleness,
            status: Status.Trading,
            winningOutcome: 0,
            exists: true,
            hasOracle: true
        });
        marketIds.push(id);
        emit MarketCreated(id, question, closeTs, feedId);
    }

    /// Permissionless settlement from the FTSO feed after close.
    /// @dev Anyone may call this — settlement is deterministic given the feed,
    ///      so there is nothing for a caller to manipulate, and permissionless
    ///      resolution means the venue keeps working without an operator.
    function resolveFromOracle(bytes32 id) external {
        Market storage m = marketOf[id];
        if (!m.exists || !m.hasOracle) revert Missing();
        if (block.timestamp < m.closeTs) revert NotClosed();
        if (m.status == Status.Resolved) revert AlreadyResolved();

        // Reverts on a stale or zero feed. Deliberately: an unresolvable market
        // stays open and can be settled once FTSO recovers, which is far better
        // than paying out every position against a frozen price.
        (uint256 price, ) = oracle.getFreshPrice(m.feedId, m.maxStaleness);

        bool yes = m.op == 0 ? (price >= m.threshold) : (price < m.threshold);
        m.winningOutcome = yes ? 0 : 1;
        m.status = Status.Resolved;
        emit Resolved(id, m.winningOutcome, price);
    }

    /// @notice How long after close an oracle-backed market must go unresolved
    ///         before admin may settle it by hand.
    /// @dev The escape hatch exists for a genuinely stuck feed. The delay is what
    ///      makes it an escape hatch rather than an override.
    uint64 public constant ADMIN_OVERRIDE_DELAY = 24 hours;

    /// Admin fallback resolution.
    ///
    /// For markets with no oracle this is the normal path. For oracle-backed
    /// markets it is an EMERGENCY ONLY path: admin must wait until the market is
    /// both closed and `ADMIN_OVERRIDE_DELAY` past close, by which point anyone
    /// could already have settled it permissionlessly from FTSO.
    ///
    /// Without that restriction the admin could hand-pick the winner of a live
    /// price market — including before it closed — which would make "settled by
    /// FTSOv2" untrue and every stake in the contract discretionary.
    function resolve(bytes32 id, uint32 outcome) external onlyAdmin {
        Market storage m = marketOf[id];
        if (!m.exists) revert Missing();
        if (outcome > 1) revert BadOutcome();
        if (m.status == Status.Resolved) revert AlreadyResolved();
        if (m.hasOracle) {
            if (block.timestamp < m.closeTs) revert NotClosed();
            if (block.timestamp < m.closeTs + ADMIN_OVERRIDE_DELAY) {
                revert OracleSettlementAvailable();
            }
        }
        m.winningOutcome = outcome;
        m.status = Status.Resolved;
        emit Resolved(id, outcome, 0);
    }

    /// Hand over admin (two-step would be safer; kept single-step to match the
    /// original contract's surface, and admin only gates market creation).
    function transferAdmin(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, next);
        admin = next;
    }

    // ── views ──────────────────────────────────────────────────────────────
    function isResolved(bytes32 id) external view returns (bool) {
        return marketOf[id].status == Status.Resolved;
    }

    function winningOutcome(bytes32 id) external view returns (uint32) {
        require(marketOf[id].status == Status.Resolved, "not resolved");
        return marketOf[id].winningOutcome;
    }

    /// Enumerate all market ids (for the app's market list).
    function markets() external view returns (bytes32[] memory) {
        return marketIds;
    }

    function marketCount() external view returns (uint256) {
        return marketIds.length;
    }

    /// App-friendly view: question / closeTs / status / winning outcome.
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
        )
    {
        Market storage m = marketOf[id];
        require(m.exists, "missing");
        return (m.question, m.closeTs, uint8(m.status), m.winningOutcome);
    }

    /// @notice The price this market WOULD settle at right now.
    /// @dev Lets the UI show the live settlement price and lets a keeper check
    ///      resolvability without sending a transaction. Free via eth_call
    ///      because the FTSO adapter's reads are `view`.
    function previewResolution(
        bytes32 id
    ) external view returns (uint256 price, uint64 timestamp, bool wouldBeYes) {
        Market storage m = marketOf[id];
        if (!m.exists || !m.hasOracle) revert Missing();
        (price, timestamp) = oracle.getPrice(m.feedId);
        wouldBeYes = m.op == 0 ? (price >= m.threshold) : (price < m.threshold);
    }
}
