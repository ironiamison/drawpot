// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {ReentrancyGuard} from "@openzeppelin/security/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";

/// @notice Pons V2 FeeEscrow. Creator fees are credited here (pull-based) and
///         claim() pays the accrued native balance to msg.sender.
interface IPonsFeeEscrow {
    function claim() external;
    function balanceOf(address recipient) external view returns (uint256);
}

/// @title DrawPotPonsVault
/// @notice On-chain lotto vault for a Pons V2 launch. Set this contract as the
///         `creatorFeeRecipient` at launch: every trade's creator tax is credited
///         to the Pons FeeEscrow for this address, and the vault claims it before
///         each draw. Keeper snapshots eligible holders and pays one winner each
///         interval — 80% to the winner, 20% to devWallet. No registration.
/// @dev Keeps the exact ABI surface of DrawPotHolderVault (executeDraw, views,
///      DrawExecuted event) so the existing site and keeper work unchanged.
contract DrawPotPonsVault is ReentrancyGuard {
    uint256 public constant MAX_SNAPSHOT_AGE = 100;
    uint256 public constant DEV_FEE_BPS = 2000; // 20%

    IPonsFeeEscrow public immutable escrow;
    address public immutable owner;

    address public taxToken;
    address public keeper;
    address public devWallet;
    uint256 public drawInterval;
    uint256 public minHold;

    uint256 public lastDrawTime;
    uint256 public drawCount;
    uint256 public totalPaidOut;
    uint256 public totalDevPaid;

    address public lastWinner;
    uint256 public lastPrize;
    uint256 public lastDevPrize;
    bytes32 public lastSnapshotHash;
    uint256 public lastEligibleCount;
    uint256 public lastSnapshotBlock;

    event DrawExecuted(
        uint256 indexed drawId,
        address indexed winner,
        bytes32 snapshotHash,
        uint256 winnerPrize,
        uint256 devPrize,
        uint256 timestamp,
        uint256 eligibleCount,
        uint256 snapshotBlock
    );

    event FeesClaimed(uint256 amount);
    event TokenSet(address token);

    constructor(
        address _escrow,
        uint256 _drawInterval,
        uint256 _minHold,
        address _keeper,
        address _devWallet
    ) {
        require(_escrow != address(0), "Escrow required");
        require(_drawInterval >= 60, "Interval too short");
        require(_minHold > 0, "Min hold required");
        require(_keeper != address(0), "Keeper required");
        require(_devWallet != address(0), "Dev wallet required");

        escrow = IPonsFeeEscrow(_escrow);
        owner = msg.sender;
        drawInterval = _drawInterval;
        minHold = _minHold;
        keeper = _keeper;
        devWallet = _devWallet;
        lastDrawTime = block.timestamp;
    }

    receive() external payable {}

    /// @notice One-time token binding. The vault must exist before the Pons launch
    ///         (it is the creatorFeeRecipient), so the token address is set right after.
    function setToken(address _taxToken) external {
        require(msg.sender == owner, "Not owner");
        require(taxToken == address(0), "Token already set");
        require(_taxToken != address(0), "Token required");
        taxToken = _taxToken;
        emit TokenSet(_taxToken);
    }

    /// @notice Pull accrued creator fees from the Pons escrow into the pot.
    ///         Permissionless — anyone may top up the pot.
    function claimFees() public nonReentrant returns (uint256 claimed) {
        claimed = escrow.balanceOf(address(this));
        if (claimed > 0) {
            escrow.claim();
            emit FeesClaimed(claimed);
        }
    }

    /// @notice Keeper submits a winner from the published eligible-holder snapshot.
    ///         Claims any escrow balance first so the full accrued pot is paid.
    function executeDraw(
        address winner,
        bytes32 snapshotHash,
        uint256 eligibleCount,
        uint256 snapshotBlock
    ) external nonReentrant {
        require(msg.sender == keeper, "Not keeper");
        require(taxToken != address(0), "Token not set");
        require(block.timestamp >= lastDrawTime + drawInterval, "Draw not ready");
        require(winner != address(0), "No winner");
        require(eligibleCount > 0, "No eligible");
        require(snapshotBlock <= block.number, "Future snapshot");
        require(block.number - snapshotBlock <= MAX_SNAPSHOT_AGE, "Stale snapshot");
        require(IERC20(taxToken).balanceOf(winner) >= minHold, "Winner below min");

        uint256 pending = escrow.balanceOf(address(this));
        if (pending > 0) {
            escrow.claim();
            emit FeesClaimed(pending);
        }

        uint256 pot = address(this).balance;
        require(pot > 0, "Empty pot");

        uint256 devPrize = (pot * DEV_FEE_BPS) / 10_000;
        uint256 winnerPrize = pot - devPrize;

        lastDrawTime = block.timestamp;
        drawCount++;
        lastWinner = winner;
        lastPrize = winnerPrize;
        lastDevPrize = devPrize;
        lastSnapshotHash = snapshotHash;
        lastEligibleCount = eligibleCount;
        lastSnapshotBlock = snapshotBlock;
        totalPaidOut += pot;
        totalDevPaid += devPrize;

        emit DrawExecuted(
            drawCount, winner, snapshotHash, winnerPrize, devPrize, block.timestamp, eligibleCount, snapshotBlock
        );

        (bool devOk,) = devWallet.call{value: devPrize}("");
        require(devOk, "Dev payout failed");

        (bool winnerOk,) = winner.call{value: winnerPrize}("");
        require(winnerOk, "Winner payout failed");
    }

    function nextDrawTime() external view returns (uint256) {
        return lastDrawTime + drawInterval;
    }

    /// @notice Full pot: ETH already held plus creator fees still sitting in the
    ///         Pons escrow (claimed automatically at draw time).
    function potBalance() external view returns (uint256) {
        return address(this).balance + escrow.balanceOf(address(this));
    }

    /// @notice Creator fees accrued in the Pons escrow, not yet claimed.
    function pendingEscrow() external view returns (uint256) {
        return escrow.balanceOf(address(this));
    }
}
