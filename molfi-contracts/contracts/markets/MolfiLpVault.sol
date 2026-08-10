// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MolfiLpVault — the LP side of the venue, in FXRP.
///
/// @notice Deposit FXRP, receive shares. Shares are a claim on a growing pot:
/// trading fees are paid in by transferring FXRP to this contract and calling
/// `collectFees`, which lifts every share's redemption value without minting
/// anything. Withdraw burns shares and pays out the current value.
///
/// @dev WHY THIS CONTRACT EXISTS. The vault used to have no contract at all.
///      The UI's "deposit" resolved its vault address to **PredictEscrow** and
///      issued a bare `FXRP.transfer` into it — a contract with no crediting
///      path and no way out. Escrow accounts stakes in `pool`/`total`, so a
///      loose transfer belonged to nobody: it was not the depositor's, it was
///      not claimable by any winner, and no function could return it. Every
///      deposit silently destroyed the user's FXRP, while an off-chain Mongo
///      row told them they owned 100% of a vault. Shares here are real, and
///      `withdraw` is the path back out that never existed.
///
///      Accounting is share-based rather than balance-based so that fees can
///      arrive at any time without diluting anyone: `totalAssets` is the FXRP
///      this contract holds, and a share is worth `totalAssets / totalShares`.
contract MolfiLpVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset;

    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    /// Cumulative fees ever paid in, for display. Not used in pricing — the
    /// share price comes from the live balance, which is the honest number.
    uint256 public lifetimeFees;

    /// The first deposit sets the price at 1.0 by minting 1 share per unit.
    /// Seeding a minimum kills the classic ERC-4626 inflation attack, where a
    /// tiny first deposit plus a large donation rounds everyone else to zero.
    uint256 public constant MIN_INITIAL_SHARES = 1e3;

    event Deposit(address indexed who, uint256 assets, uint256 shares);
    event Withdraw(address indexed who, uint256 assets, uint256 shares);
    event FeesCollected(address indexed from, uint256 amount);

    error ZeroAmount();
    error ZeroAddress();
    error InsufficientShares(uint256 have, uint256 want);
    error DepositTooSmall();
    error NothingToWithdraw();

    constructor(IERC20 _asset) {
        if (address(_asset) == address(0)) revert ZeroAddress();
        asset = _asset;
    }

    /// FXRP under management — deposits plus every fee collected, minus exits.
    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    /// Value of one whole share, scaled by 1e18. 1e18 == parity.
    /// @dev Reported at parity before there are any shares, because there is no
    ///      holder for a different answer to be true for.
    function sharePrice() external view returns (uint256) {
        if (totalShares == 0) return 1e18;
        return (totalAssets() * 1e18) / totalShares;
    }

    function assetsOf(address who) external view returns (uint256) {
        if (totalShares == 0) return 0;
        return (sharesOf[who] * totalAssets()) / totalShares;
    }

    /// Deposit `amount` FXRP and mint shares at the current price.
    function deposit(uint256 amount) external nonReentrant returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();

        // Measure what actually arrived rather than what was asked for, so a
        // fee-on-transfer collateral can never mint shares against FXRP the
        // vault did not receive.
        uint256 before = totalAssets();
        asset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = totalAssets() - before;
        if (received == 0) revert ZeroAmount();

        if (totalShares == 0) {
            shares = received;
            if (shares < MIN_INITIAL_SHARES) revert DepositTooSmall();
        } else {
            // `before` is the pot the existing shares are a claim on. Pricing
            // against it — not against the post-transfer balance — is what
            // stops a depositor buying into their own deposit.
            shares = (received * totalShares) / before;
            if (shares == 0) revert DepositTooSmall();
        }

        totalShares += shares;
        sharesOf[msg.sender] += shares;
        emit Deposit(msg.sender, received, shares);
    }

    /// Burn `shares` and take the FXRP they are worth.
    function withdraw(uint256 shares) external nonReentrant returns (uint256 assets) {
        return _withdraw(msg.sender, shares);
    }

    /// Exit the whole position.
    function withdrawAll() external nonReentrant returns (uint256) {
        return _withdraw(msg.sender, sharesOf[msg.sender]);
    }

    /// @dev Shared by both exits, and internal for a reason: calling
    ///      `this.withdraw(...)` from `withdrawAll` would make the VAULT the
    ///      `msg.sender` of the inner call, which holds no shares — every
    ///      full exit reverted `InsufficientShares(0, n)`. An owner passed
    ///      explicitly cannot drift like that.
    function _withdraw(address owner, uint256 shares) internal returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        uint256 held = sharesOf[owner];
        if (held < shares) revert InsufficientShares(held, shares);

        assets = (shares * totalAssets()) / totalShares;
        if (assets == 0) revert NothingToWithdraw();

        // Burn before paying — the reentrancy guard already covers this, but
        // the ordering should not depend on it.
        sharesOf[owner] = held - shares;
        totalShares -= shares;

        asset.safeTransfer(owner, assets);
        emit Withdraw(owner, assets, shares);
    }

    /// Pay trading fees in. Mints nothing, so the entire amount accrues to
    /// existing shares — which is what makes the yield real rather than a
    /// number a server decided.
    /// @dev Permissionless on purpose: anyone may top the pot up, and there is
    ///      no way to use that to extract more than your own shares are worth.
    function collectFees(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 before = totalAssets();
        asset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = totalAssets() - before;
        lifetimeFees += received;
        emit FeesCollected(msg.sender, received);
    }
}
