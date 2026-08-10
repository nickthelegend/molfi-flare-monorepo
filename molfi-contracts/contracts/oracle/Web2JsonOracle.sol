// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMolfiOracle} from "../interfaces/IMolfiOracle.sol";
import {IWeb2Json} from "@flarenetwork/flare-periphery-contracts/coston2/IWeb2Json.sol";
import {ContractRegistry} from "@flarenetwork/flare-periphery-contracts/coston2/ContractRegistry.sol";

/// @notice Voting-epoch timing, which the periphery's IFlareSystemsManager does
///         not declare even though FlareSystemsManager implements it. Declared
///         locally, matching this repo's existing minimal-interface pattern.
interface IVotingEpochs {
    function firstVotingRoundStartTs() external view returns (uint64);

    function votingEpochDurationSeconds() external view returns (uint64);
}

/**
 * @title Web2JsonOracle — settlement values from any public JSON API, proved by the FDC.
 *
 * @notice FTSO carries a few dozen crypto pairs. Everything else a prediction
 *         market might want to ask about — an FX reference rate, a public
 *         statistic, a scoreline — has no feed, and Molfi's only answer today is
 *         `MolfiMarket.resolve()`, where an admin types in the outcome. That is
 *         the one place in the system where a human decides who gets paid.
 *
 *         This removes that. The Flare Data Connector's attestation providers
 *         independently fetch a URL, apply the same jq transform, agree on the
 *         result, and publish a Merkle root. Anyone holding a proof against that
 *         root can post the value here — permissionlessly. The contract then
 *         serves it through `IMolfiOracle`, the exact interface Molfi already
 *         settles against, so a Web2-backed market is settled by the same code
 *         path as an FTSO one.
 *
 * @dev WHAT MAKES THIS SAFE, AND WHERE THE REFERENCE IMPLEMENTATION IS NOT.
 *
 *      Verifying the Merkle proof only establishes "the FDC attested *something*".
 *      It says nothing about *what was asked*. A valid proof of a completely
 *      different URL — one the attacker chose, returning a number that suits
 *      them — verifies just as well. The reference this was ported from
 *      (`PredictionMarket.requestWeatherSettlement`) checks only that the
 *      returned coordinates match the market, which happens to catch the naive
 *      case for weather and catches nothing at all in general.
 *
 *      So a feed here is bound at registration to `keccak256(abi.encode(requestBody))`
 *      — the full request: url, method, headers, query params, body, the jq
 *      transform, and the ABI signature. `submitAttestation` recomputes that hash
 *      from the proof and rejects any mismatch. Changing so much as the jq filter
 *      produces a different feed, not a different answer to this one.
 *
 *      Freshness and ordering both come from the attestation's VOTING ROUND, not
 *      from `lowestUsedTimestamp`. The obvious-looking choice is that field, and
 *      the reference uses the analogous one — but Web2Json fills it with
 *      `type(uint64).max` when the source carries no timestamp of its own, which
 *      is what Coston2 actually returned here. Trusting it would have been two
 *      bugs at once: every reading would look infinitely fresh, and the
 *      monotonicity check would reject every subsequent update, freezing the
 *      feed permanently at its first value.
 *
 *      A round, by contrast, is strictly increasing by construction and its wall
 *      time is derivable from the protocol itself.
 */
contract Web2JsonOracle is IMolfiOracle {
    /// @notice Every value this contract returns carries 18 decimals, matching
    ///         IMolfiOracle and therefore FtsoOracle.
    uint8 public constant DECIMALS = 18;

    /// @notice The shape a feed's `postProcessJq` must produce. One signed
    ///         integer, scaled by the feed's registered `valueDecimals`.
    /// @dev Kept deliberately minimal: anything richer would have to be
    ///      interpreted, and interpretation is where a settlement oracle starts
    ///      making decisions. It reports one number.
    struct Web2Value {
        int256 value;
    }

    struct Feed {
        /// keccak256(abi.encode(IWeb2Json.RequestBody)) — the exact question.
        bytes32 requestHash;
        string label;
        uint8 valueDecimals;
        bool exists;
    }

    struct Observation {
        uint256 value; // normalized to 18 decimals
        uint64 observedAt; // the proof's lowestUsedTimestamp
        uint64 votingRound; // FDC round that carried it
        bool exists;
    }

    /**
     * @notice Where feeds this contract does not know about are served from.
     *
     * @dev Makes this a strict superset of the FTSO adapter rather than a
     *      competing one: a market venue pointed here settles FTSO feeds exactly
     *      as before and gains Web2 feeds, so adopting it can never regress an
     *      existing market. Zero is allowed — then unknown feeds simply revert.
     */
    IMolfiOracle public immutable fallbackOracle;

    address public admin;

    mapping(bytes21 => Feed) public feedOf;
    mapping(bytes21 => Observation) private _latest;
    bytes21[] public feedIds;

    event FeedRegistered(bytes21 indexed feedId, bytes32 requestHash, string label, uint8 valueDecimals);
    event AttestationSubmitted(
        bytes21 indexed feedId,
        uint256 value,
        uint64 observedAt,
        uint64 votingRound,
        address indexed submitter
    );
    event AdminTransferred(address indexed from, address indexed to);

    error NotAdmin();
    error ZeroAddress();
    error FeedExists();
    error UnknownFeed();
    error BadDecimals();
    error InvalidProof();
    /// @dev The proof is valid, but it answers a different question than this feed asks.
    error RequestMismatch(bytes32 expected, bytes32 got);
    error NegativeValue(int256 value);
    /// @dev Rounds, not timestamps — see the note on `lowestUsedTimestamp` above.
    error StaleObservation(uint64 haveRound, uint64 gotRound);
    error NoObservation();
    error TooStale(uint64 age, uint64 maxAge);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(IMolfiOracle _fallbackOracle) {
        // Deliberately allowed to be zero — see fallbackOracle.
        fallbackOracle = _fallbackOracle;
        admin = msg.sender;
    }

    // --- Registration ------------------------------------------------------

    /**
     * @notice Bind a feed id to one exact FDC attestation request.
     *
     * @param feedId Synthetic id, same bytes21 shape MolfiMarket already passes
     *               around. Category byte 0x02 is used for Web2 feeds by
     *               convention so they cannot collide with FTSO's 0x01 crypto ids.
     * @param requestHash keccak256(abi.encode(requestBody)) of the Web2Json request.
     * @param valueDecimals Decimals of the integer the jq transform emits.
     *
     * @dev Admin-gated and single-shot. Re-binding a live feed would let whoever
     *      holds the key silently change what a market settles against after
     *      people have staked on it — the exact discretion this contract exists
     *      to remove. Register a new id instead.
     */
    function registerFeed(
        bytes21 feedId,
        bytes32 requestHash,
        string calldata label,
        uint8 valueDecimals
    ) external onlyAdmin {
        if (feedId == bytes21(0)) revert UnknownFeed();
        if (requestHash == bytes32(0)) revert InvalidProof();
        if (feedOf[feedId].exists) revert FeedExists();
        if (valueDecimals > DECIMALS) revert BadDecimals();

        feedOf[feedId] = Feed({
            requestHash: requestHash,
            label: label,
            valueDecimals: valueDecimals,
            exists: true
        });
        feedIds.push(feedId);
        emit FeedRegistered(feedId, requestHash, label, valueDecimals);
    }

    // --- Attestation -------------------------------------------------------

    /**
     * @notice Post an FDC-proved reading for a registered feed. Permissionless.
     *
     * @dev Anyone may call this and nobody can influence the outcome: the value
     *      comes out of a Merkle proof the FDC's providers agreed on, and the
     *      request is pinned. The caller is only paying gas to relay it.
     */
    function submitAttestation(bytes21 feedId, IWeb2Json.Proof calldata proof) external {
        Feed memory f = feedOf[feedId];
        if (!f.exists) revert UnknownFeed();

        // 1. The FDC actually attested this.
        if (!ContractRegistry.getFdcVerification().verifyWeb2Json(proof)) {
            revert InvalidProof();
        }

        // 2. …and it attested THIS question. Without this, any valid Web2Json
        //    proof of any URL would settle this feed.
        bytes32 got = keccak256(abi.encode(proof.data.requestBody));
        if (got != f.requestHash) revert RequestMismatch(f.requestHash, got);

        Web2Value memory dto = abi.decode(proof.data.responseBody.abiEncodedData, (Web2Value));
        // IMolfiOracle is unsigned, and a negative settlement price is not a
        // thing a market can be resolved against. Reject rather than wrap.
        if (dto.value < 0) revert NegativeValue(dto.value);

        // Strictly increasing rounds. Re-posting the same proof, or an older one
        // held back to make a stale number look current, is rejected.
        Observation memory prev = _latest[feedId];
        if (prev.exists && proof.data.votingRound <= prev.votingRound) {
            revert StaleObservation(prev.votingRound, proof.data.votingRound);
        }

        uint256 scaled = uint256(dto.value) * (10 ** uint256(DECIMALS - f.valueDecimals));
        uint64 observedAt = roundEndTs(proof.data.votingRound);
        _latest[feedId] = Observation({
            value: scaled,
            observedAt: observedAt,
            votingRound: proof.data.votingRound,
            exists: true
        });
        emit AttestationSubmitted(feedId, scaled, observedAt, proof.data.votingRound, msg.sender);
    }

    /**
     * @notice When a voting round closed, in wall time, from the protocol itself.
     *
     * @dev This is the honest answer to "how old is this reading": the round is
     *      when the attestation providers went and looked. Using the block the
     *      proof happened to be relayed in would instead measure how recently
     *      someone paid gas, which a relayer sitting on an old proof could make
     *      say anything.
     */
    function roundEndTs(uint64 votingRound) public view returns (uint64) {
        IVotingEpochs epochs = IVotingEpochs(address(ContractRegistry.getFlareSystemsManager()));
        return epochs.firstVotingRoundStartTs() + (votingRound + 1) * epochs.votingEpochDurationSeconds();
    }

    // --- IMolfiOracle ------------------------------------------------------

    function getPrice(bytes21 feedId) external view returns (uint256 price, uint64 timestamp) {
        Observation memory o = _latest[feedId];
        if (!o.exists) return _fallback(feedId, 0, false);
        return (o.value, o.observedAt);
    }

    function getFreshPrice(
        bytes21 feedId,
        uint64 maxAge
    ) external view returns (uint256 price, uint64 timestamp) {
        Observation memory o = _latest[feedId];
        if (!o.exists) return _fallback(feedId, maxAge, true);

        // Same contract as FtsoOracle: settlement decides who gets paid, so an
        // unrefreshed feed must fail loudly rather than resolve every open
        // position against a number nobody has stood behind recently.
        uint64 age = block.timestamp > o.observedAt ? uint64(block.timestamp) - o.observedAt : 0;
        if (age > maxAge) revert TooStale(age, maxAge);
        return (o.value, o.observedAt);
    }

    function _fallback(
        bytes21 feedId,
        uint64 maxAge,
        bool fresh
    ) private view returns (uint256, uint64) {
        // A feed registered here but never attested is a different failure from
        // one this contract was never told about — the first is "not yet", the
        // second is "ask the FTSO adapter".
        if (feedOf[feedId].exists) revert NoObservation();
        if (address(fallbackOracle) == address(0)) revert UnknownFeed();
        return fresh ? fallbackOracle.getFreshPrice(feedId, maxAge) : fallbackOracle.getPrice(feedId);
    }

    // --- Views / admin -----------------------------------------------------

    function latestObservation(bytes21 feedId) external view returns (Observation memory) {
        return _latest[feedId];
    }

    function feedCount() external view returns (uint256) {
        return feedIds.length;
    }

    /// @notice The hash a feed must be registered with, computed from a request body.
    /// @dev Exposed so the off-chain pipeline derives the binding from the same
    ///      code the contract checks it against, instead of reimplementing the
    ///      encoding and discovering the mismatch at settlement time.
    function requestHashOf(IWeb2Json.RequestBody calldata requestBody) external pure returns (bytes32) {
        return keccak256(abi.encode(requestBody));
    }

    function transferAdmin(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, next);
        admin = next;
    }
}
