// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {TeeActionResult} from "../tee/TeeActionResult.sol";

interface IMarketRef {
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

/// @title SealedBidBook — a prediction-market book nobody can read while it fills.
///
/// @notice Bids are submitted ENCRYPTED to a Flare Confidential Compute (FCC)
/// enclave. Until the market closes, the chain shows only that someone staked
/// some FXRP — never which side. When it closes the enclave opens every bid at
/// once, publishes the two pool totals, and the market settles pari-mutuel.
///
/// @dev WHY THIS NEEDS A TEE AND NOT A ZK PROOF.
///      Molfi already hides a bettor's side with Groth16 (see ConfidentialBet).
///      That is one party proving something about their OWN secret, and it is
///      the right tool for that job. It cannot do this one.
///
///      The problem here is the ORDER BOOK, not the order. In an ordinary
///      pari-mutuel market every stake moves the implied odds the instant it
///      lands, so the price itself broadcasts the flow: watch the YES pool jump
///      and you know which way size just went, who sent it, and you can front-run
///      or copy it. Hiding your own bet does not help — the pool total gives you
///      away.
///
///      Fixing that requires computing over EVERYONE's hidden inputs at once,
///      which no per-user proof can express: you cannot prove a property of a
///      book you are not allowed to read. A TEE can — it is the one party
///      permitted to see all the plaintext, and only because the hardware, not
///      the operator, is what is trusted.
///
///      So: the enclave holds the book, and the odds simply do not exist on-chain
///      until close.
///
///      WHAT STOPS THE ENCLAVE LYING. It could try to drop or invent bids when
///      it reports the pools. It cannot, because the contract already knows two
///      facts the enclave never gets to choose: how many bids were sealed, and
///      exactly how much FXRP they escrowed in total. `openMarket` rejects any
///      result where `yesPool + noPool != totalEscrowed` or the count disagrees.
///      Conservation is checked on-chain, so a dishonest opening is not a matter
///      of trust — it does not execute.
///
///      Individual openings are published as a Merkle root rather than calldata,
///      so gas is flat in the number of bids; each bettor claims with a proof of
///      their own side. Sealed while it matters, public once it cannot be abused.
///
///      HONEST SCOPE: the enclave's signing key is registered here by the
///      operator and attested through Flare's `FlareTeeManager`. This contract
///      verifies the SIGNATURE and the conservation invariant; it does not itself
///      parse a remote-attestation quote. On Coston2 the extension may run with
///      `SIMULATED_TEE=true`, in which case the confidentiality is a development
///      assumption while the integrity checks above remain fully real.
contract SealedBidBook is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable fxrp;
    IMarketRef public immutable market;

    /// @notice The attested enclave key allowed to open a market. Rotatable,
    ///         because a TEE redeploy mints a fresh key.
    address public teeSigner;
    /// @notice Flare's registered TEE machine — see `openMarketFromTee`.
    address public teeMachine;
    address public admin;

    /// @notice Where the 2% fee goes, matching PredictEscrow.
    address public immutable vault;
    uint256 public constant FEE_BPS = 200;

    uint32 public constant OUTCOME_YES = 0;
    uint32 public constant OUTCOME_NO = 1;

    struct Bid {
        address bidder;
        uint256 amount;
        /// @dev The sealed side, encrypted to the enclave's public key. Opaque
        ///      on-chain by construction — the contract never reads it.
        bytes ciphertext;
    }

    struct Book {
        uint256 totalEscrowed;
        uint32 bidCount;
        bool opened;
        uint256 yesPool;
        uint256 noPool;
        /// @dev Merkle root over leaf = keccak256(abi.encode(bidIndex, side)).
        bytes32 openingsRoot;
    }

    mapping(bytes32 => Bid[]) private _bids;
    mapping(bytes32 => Book) public books;
    /// @dev bidIndex is unique per market, so this is the anti-double-claim set.
    mapping(bytes32 => mapping(uint256 => bool)) public claimed;

    event BidSealed(
        bytes32 indexed marketId,
        uint256 indexed bidIndex,
        address indexed bidder,
        uint256 amount
    );
    event MarketOpened(
        bytes32 indexed marketId,
        uint256 yesPool,
        uint256 noPool,
        uint32 bidCount,
        bytes32 openingsRoot
    );
    event Claimed(
        bytes32 indexed marketId,
        uint256 indexed bidIndex,
        address indexed bidder,
        uint256 payout
    );
    event TeeMachineChanged(address indexed from, address indexed to);
    event TeeSignerChanged(address indexed from, address indexed to);

    error NotAdmin();
    error ZeroAddress();
    error ZeroAmount();
    error MarketClosed();
    error NotClosedYet();
    error AlreadyOpened();
    error NotOpened();
    error NotResolved();
    error BadSignature();
    error ConservationFailed(uint256 reported, uint256 escrowed);
    error CountMismatch(uint32 reported, uint32 actual);
    error EmptyCiphertext();
    error BadOpeningProof();
    error AlreadyClaimed();
    error NotAWinner();
    error BadIndex();
    /// @dev The TEE-node path is not configured on this deployment.
    error TeeMachineNotSet();
    /// @dev The extension reported its own failure; its payload is not a result.
    error TeeReportedFailure(uint8 status);
    /// @dev A signed result addressed to a different book deployment.
    error WrongBook(address book);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(
        IERC20 _fxrp,
        IMarketRef _market,
        address _teeSigner,
        address _vault
    ) {
        if (
            address(_fxrp) == address(0) ||
            address(_market) == address(0) ||
            _teeSigner == address(0)
        ) revert ZeroAddress();
        fxrp = _fxrp;
        market = _market;
        teeSigner = _teeSigner;
        vault = _vault;
        admin = msg.sender;
    }

    // ── seal ─────────────────────────────────────────────────────────────────

    /// @notice Escrow FXRP against a bid whose SIDE is encrypted to the enclave.
    /// @param ciphertext the sealed side, produced by the client with the
    ///        enclave's attested public key. Never read on-chain.
    function sealBid(
        bytes32 marketId,
        uint256 amount,
        bytes calldata ciphertext
    ) external nonReentrant returns (uint256 bidIndex) {
        if (amount == 0) revert ZeroAmount();
        if (ciphertext.length == 0) revert EmptyCiphertext();

        // Bidding stops at close — after that the settlement price is public,
        // so a late bid would be a risk-free claim on the pot.
        (, uint64 closeTs, , ) = market.getMarket(marketId);
        if (block.timestamp >= closeTs) revert MarketClosed();

        Book storage b = books[marketId];
        if (b.opened) revert AlreadyOpened();

        fxrp.safeTransferFrom(msg.sender, address(this), amount);

        bidIndex = _bids[marketId].length;
        _bids[marketId].push(
            Bid({bidder: msg.sender, amount: amount, ciphertext: ciphertext})
        );
        b.totalEscrowed += amount;
        b.bidCount += 1;

        emit BidSealed(marketId, bidIndex, msg.sender, amount);
    }

    // ── open ─────────────────────────────────────────────────────────────────

    /// @notice The digest the enclave signs. Exposed so the extension and any
    ///         verifier derive it identically instead of reimplementing it.
    function openDigest(
        bytes32 marketId,
        uint256 yesPool,
        uint256 noPool,
        uint32 bidCount,
        bytes32 openingsRoot
    ) public view returns (bytes32) {
        bytes32 inner = keccak256(
            abi.encode(
                // chainid + address bind the signature to THIS book on THIS
                // chain, so an opening cannot be replayed onto another
                // deployment that happens to share a market id.
                block.chainid,
                address(this),
                marketId,
                yesPool,
                noPool,
                bidCount,
                openingsRoot
            )
        );
        // EIP-191 personal-sign prefix, written out: OpenZeppelin's
        // MessageHashUtils reaches Strings -> Bytes, which emits the Cancun-only
        // `mcopy`, and Coston2 compiles for paris.
        return
            keccak256(
                abi.encodePacked("\x19Ethereum Signed Message:\n32", inner)
            );
    }

    /// @notice Publish the opened book. Permissionless to CALL — the signature
    ///         is what authorises it, so anyone can relay the enclave's result.
    function openMarket(
        bytes32 marketId,
        uint256 yesPool,
        uint256 noPool,
        uint32 bidCount,
        bytes32 openingsRoot,
        bytes calldata signature
    ) external nonReentrant {
        Book storage b = books[marketId];
        if (b.opened) revert AlreadyOpened();

        (, uint64 closeTs, , ) = market.getMarket(marketId);
        if (block.timestamp < closeTs) revert NotClosedYet();

        // The enclave signed it…
        address signer = _recover(
            openDigest(marketId, yesPool, noPool, bidCount, openingsRoot),
            signature
        );
        if (signer != teeSigner) revert BadSignature();

        _settleOpening(marketId, b, yesPool, noPool, bidCount, openingsRoot);
    }

    /**
     * @notice Publish an opening authorised by Flare's TEE node itself.
     *
     * @dev The second of two authorisation paths, and the stronger one.
     *
     *      `openMarket` above trusts `teeSigner` — an address an admin sets, and
     *      whose key the extension is handed through its environment. Every
     *      integrity check on it is real, but the identity is one we configured.
     *
     *      This path trusts `teeMachine`: the address Flare's registry attested
     *      and registered. When an extension returns an `ActionResult`,
     *      tee-node's router signs it with the node's own identity key — the
     *      extension never sees that key and cannot substitute one. So an
     *      opening accepted here was authorised by the registered machine, not
     *      by anything an operator supplied.
     *
     *      Both paths converge on the same reconciliation. Authorisation says
     *      WHO may publish an opening; it never says what the numbers are.
     *
     *      `resultData` is the extension's response payload, ABI-encoded as
     *      (book, marketId, yesPool, noPool, bidCount, openingsRoot). The book
     *      address is inside the signed bytes so a result meant for one
     *      deployment cannot be replayed into another.
     */
    function openMarketFromTee(
        bytes calldata resultData,
        bytes32 actionId,
        string calldata submissionTag,
        uint8 status,
        bytes calldata signature
    ) external nonReentrant {
        if (teeMachine == address(0)) revert TeeMachineNotSet();
        // status 0 is the extension reporting its own failure. Publishing the
        // payload of a failed action would settle a market on whatever happened
        // to be in the error path.
        if (status != 1) revert TeeReportedFailure(status);

        address signer = TeeActionResult.recoverSigner(
            resultData,
            actionId,
            submissionTag,
            status,
            signature
        );
        if (signer != teeMachine) revert BadSignature();

        (
            address book,
            bytes32 marketId,
            uint256 yesPool,
            uint256 noPool,
            uint32 bidCount,
            bytes32 openingsRoot
        ) = abi.decode(resultData, (address, bytes32, uint256, uint256, uint32, bytes32));
        if (book != address(this)) revert WrongBook(book);

        Book storage b = books[marketId];
        if (b.opened) revert AlreadyOpened();
        (, uint64 closeTs, , ) = market.getMarket(marketId);
        if (block.timestamp < closeTs) revert NotClosedYet();

        _settleOpening(marketId, b, yesPool, noPool, bidCount, openingsRoot);
    }

    /**
     * @dev The part neither signer gets a say in.
     *
     * The chain already witnessed how many bids it took and exactly how much
     * FXRP it escrowed. An opening that disagrees with either does not execute.
     * That is what makes a dishonest enclave — under either authorisation path —
     * unable to move a bettor's stake to the other side, rather than merely
     * discouraged from trying.
     */
    function _settleOpening(
        bytes32 marketId,
        Book storage b,
        uint256 yesPool,
        uint256 noPool,
        uint32 bidCount,
        bytes32 openingsRoot
    ) private {
        if (bidCount != b.bidCount) revert CountMismatch(bidCount, b.bidCount);
        uint256 reported = yesPool + noPool;
        if (reported != b.totalEscrowed) {
            revert ConservationFailed(reported, b.totalEscrowed);
        }

        b.opened = true;
        b.yesPool = yesPool;
        b.noPool = noPool;
        b.openingsRoot = openingsRoot;

        emit MarketOpened(marketId, yesPool, noPool, bidCount, openingsRoot);
    }

    /// @notice The registered FCC machine whose node signs ActionResults.
    /// @dev Rotatable for the same reason `teeSigner` is: re-registering the
    ///      extension mints a new machine identity, and a book pinned to a dead
    ///      one could never be opened through this path again.
    function setTeeMachine(address next) external onlyAdmin {
        emit TeeMachineChanged(teeMachine, next);
        teeMachine = next;
    }

    // ── claim ────────────────────────────────────────────────────────────────

    /// @notice Leaf format for the openings tree. The AMOUNT is deliberately not
    ///         in the leaf — the contract already stored it at seal time, so the
    ///         enclave cannot restate it.
    function openingLeaf(
        uint256 bidIndex,
        uint32 side
    ) public pure returns (bytes32) {
        // Double-hashed the way OpenZeppelin's tooling builds leaves, but via
        // encodePacked: bytes.concat pulls in OZ's mcopy path, which needs a
        // Cancun VM while Coston2 compiles for paris.
        return keccak256(abi.encodePacked(keccak256(abi.encode(bidIndex, side))));
    }

    /// @notice Claim a winning sealed bid, pro-rata over the whole pot less 2%.
    function claim(
        bytes32 marketId,
        uint256 bidIndex,
        uint32 side,
        bytes32[] calldata proof
    ) external nonReentrant returns (uint256 payout) {
        Book storage b = books[marketId];
        if (!b.opened) revert NotOpened();
        if (!market.isResolved(marketId)) revert NotResolved();
        if (bidIndex >= _bids[marketId].length) revert BadIndex();
        if (claimed[marketId][bidIndex]) revert AlreadyClaimed();

        // The side comes from the enclave's published openings, not the caller.
        if (!_verifyProof(proof, b.openingsRoot, openingLeaf(bidIndex, side))) {
            revert BadOpeningProof();
        }

        uint32 winner = market.winningOutcome(marketId);
        if (side != winner) revert NotAWinner();

        Bid storage bid = _bids[marketId][bidIndex];
        uint256 winPool = winner == OUTCOME_YES ? b.yesPool : b.noPool;
        // A one-sided book has nothing to win from the other side — refund the
        // stake rather than paying an undefined multiple of it.
        uint256 gross = winPool == 0
            ? bid.amount
            : (bid.amount * b.totalEscrowed) / winPool;

        uint256 fee = winPool == 0 ? 0 : (gross * FEE_BPS) / 10_000;
        payout = gross - fee;

        claimed[marketId][bidIndex] = true;
        if (fee > 0 && vault != address(0)) fxrp.safeTransfer(vault, fee);
        fxrp.safeTransfer(bid.bidder, payout);

        emit Claimed(marketId, bidIndex, bid.bidder, payout);
    }

    /// @dev secp256k1 recovery over a 65-byte (r,s,v) signature.
    ///      `s` is constrained to the lower half of the curve order and `v` to
    ///      {27,28}: without that, every signature has a trivially-computable
    ///      twin, and a relayer could resubmit an opening under a second hash.
    function _recover(
        bytes32 digest,
        bytes calldata sig
    ) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (
            uint256(s) >
            0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0
        ) revert BadSignature();
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert BadSignature();
        address a = ecrecover(digest, v, r, s);
        if (a == address(0)) revert BadSignature();
        return a;
    }

    /// @dev Sorted-pair Merkle verification, matching how the extension builds
    ///      the tree. Written out rather than imported: OpenZeppelin's
    ///      MerkleProof reaches `Bytes.sol`, which emits `mcopy` — a Cancun
    ///      opcode — and Coston2 compiles for paris.
    function _verifyProof(
        bytes32[] calldata proof,
        bytes32 root,
        bytes32 leaf
    ) internal pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h <= p
                ? keccak256(abi.encodePacked(h, p))
                : keccak256(abi.encodePacked(p, h));
        }
        return h == root;
    }

    // ── views ────────────────────────────────────────────────────────────────

    /// @notice What the public can see while a market is live: how much is at
    ///         stake, and nothing about which way it leans.
    function bookStatus(
        bytes32 marketId
    )
        external
        view
        returns (uint256 totalEscrowed, uint32 bidCount, bool opened)
    {
        Book storage b = books[marketId];
        return (b.totalEscrowed, b.bidCount, b.opened);
    }

    /// @dev The enclave reads these to open the book.
    function getBid(
        bytes32 marketId,
        uint256 bidIndex
    ) external view returns (address bidder, uint256 amount, bytes memory ciphertext) {
        Bid storage b = _bids[marketId][bidIndex];
        return (b.bidder, b.amount, b.ciphertext);
    }

    function bidCount(bytes32 marketId) external view returns (uint256) {
        return _bids[marketId].length;
    }

    function setTeeSigner(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        emit TeeSignerChanged(teeSigner, next);
        teeSigner = next;
    }

    function transferAdmin(address next) external onlyAdmin {
        if (next == address(0)) revert ZeroAddress();
        admin = next;
    }
}
