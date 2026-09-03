// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {VaultBaseV2} from "./flap/VaultBaseV2.sol";
import {VaultFactoryBaseV2} from "./flap/VaultFactoryBaseV2.sol";
import {IVaultFactoryValidationV2} from "./flap/IVaultFactory.sol";
import {
    VaultUISchema,
    VaultMethodSchema,
    VaultDataSchema,
    FieldDescriptor,
    ApproveAction,
    FactoryPolicy
} from "./flap/IVaultSchemasV1.sol";
import {BeaconProxy} from "@openzeppelin/proxy/beacon/BeaconProxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/proxy/beacon/UpgradeableBeacon.sol";
import {Initializable} from "@openzeppelin-contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin-contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";

/// @title DrawPotHolderVault
/// @notice Flap tax vault — no registration. Keeper snapshots eligible holders and pays one winner each interval.
/// @dev Winner must still hold >= minHold at payout time. 20% of each pot goes to devWallet.
contract DrawPotHolderVault is Initializable, VaultBaseV2, ReentrancyGuardUpgradeable {
    uint256 public constant MAX_SNAPSHOT_AGE = 100;
    uint256 public constant DEV_FEE_BPS = 2000; // 20%

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

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _taxToken,
        uint256 _drawInterval,
        uint256 _minHold,
        address _keeper,
        address _devWallet
    ) external initializer {
        __ReentrancyGuard_init();
        require(_drawInterval >= 60, "Interval too short");
        require(_minHold > 0, "Min hold required");
        require(_keeper != address(0), "Keeper required");
        require(_devWallet != address(0), "Dev wallet required");

        taxToken = _taxToken;
        drawInterval = _drawInterval;
        minHold = _minHold;
        keeper = _keeper;
        devWallet = _devWallet;
        lastDrawTime = block.timestamp;
    }

    receive() external payable {}

    /// @notice Keeper submits a winner from the published eligible-holder snapshot.
    function executeDraw(
        address winner,
        bytes32 snapshotHash,
        uint256 eligibleCount,
        uint256 snapshotBlock
    ) external nonReentrant {
        require(msg.sender == keeper, "Not keeper");
        require(block.timestamp >= lastDrawTime + drawInterval, "Draw not ready");
        require(address(this).balance > 0, "Empty pot");
        require(winner != address(0), "No winner");
        require(eligibleCount > 0, "No eligible");
        require(snapshotBlock <= block.number, "Future snapshot");
        require(block.number - snapshotBlock <= MAX_SNAPSHOT_AGE, "Stale snapshot");
        require(IERC20(taxToken).balanceOf(winner) >= minHold, "Winner below min");

        uint256 pot = address(this).balance;
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

    function potBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function description() public view override returns (string memory) {
        return string(
            abi.encodePacked(
                "DrawPot Holder Vault: ",
                _uintToString(drawInterval),
                "s draws, min hold ",
                _uintToString(minHold / 1e18),
                " tokens. Pot ",
                _uintToString(address(this).balance / 1e15),
                " milli-ETH, ",
                _uintToString(lastEligibleCount),
                " last eligible, ",
                _uintToString(drawCount),
                " draws completed."
            )
        );
    }

    function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
        schema.vaultType = "DrawPotHolderVault";
        schema.description =
            "On-chain lotto vault. Hold the minimum balance - no registration. Winner gets 80%, dev gets 20%.";
        schema.methods = new VaultMethodSchema[](5);

        schema.methods[0].name = "potBalance";
        schema.methods[0].description = "Current prize pool in ETH.";
        schema.methods[0].inputs = new FieldDescriptor[](0);
        schema.methods[0].outputs = _singleUint("balance", "Vault balance", 18);
        schema.methods[0].approvals = new ApproveAction[](0);

        schema.methods[1].name = "nextDrawTime";
        schema.methods[1].description = "Unix timestamp of the next allowed draw.";
        schema.methods[1].inputs = new FieldDescriptor[](0);
        schema.methods[1].outputs = _singleTime("timestamp", "Next draw time");
        schema.methods[1].approvals = new ApproveAction[](0);

        schema.methods[2].name = "drawCount";
        schema.methods[2].description = "Total completed draws.";
        schema.methods[2].inputs = new FieldDescriptor[](0);
        schema.methods[2].outputs = _singleUint("count", "Draw count", 0);
        schema.methods[2].approvals = new ApproveAction[](0);

        schema.methods[3].name = "lastEligibleCount";
        schema.methods[3].description = "Eligible holders in the last completed draw.";
        schema.methods[3].inputs = new FieldDescriptor[](0);
        schema.methods[3].outputs = _singleUint("count", "Eligible count", 0);
        schema.methods[3].approvals = new ApproveAction[](0);

        schema.methods[4].name = "executeDraw";
        schema.methods[4].description = "Keeper-only. Pays 80% to winner, 20% to dev wallet.";
        schema.methods[4].inputs = new FieldDescriptor[](0);
        schema.methods[4].outputs = new FieldDescriptor[](0);
        schema.methods[4].approvals = new ApproveAction[](0);
        schema.methods[4].isWriteMethod = true;
    }

    function _singleUint(string memory name, string memory desc, uint8 decimals)
        private
        pure
        returns (FieldDescriptor[] memory outputs)
    {
        outputs = new FieldDescriptor[](1);
        outputs[0] = FieldDescriptor(name, "uint256", desc, decimals);
    }

    function _singleTime(string memory name, string memory desc)
        private
        pure
        returns (FieldDescriptor[] memory outputs)
    {
        outputs = new FieldDescriptor[](1);
        outputs[0] = FieldDescriptor(name, "time", desc, 0);
    }

    function _uintToString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}

/// @title DrawPotHolderVaultFactory
contract DrawPotHolderVaultFactory is VaultFactoryBaseV2 {
    address public immutable beacon;

    constructor() {
        DrawPotHolderVault impl = new DrawPotHolderVault();
        beacon = address(new UpgradeableBeacon(address(impl)));
    }

    function newVault(address taxToken, address, address, bytes calldata vaultData)
        external
        override
        returns (address vault)
    {
        require(msg.sender == _getVaultPortal(), "Only VaultPortal");

        (uint256 drawInterval, uint256 minHoldTokens, address keeper, address devWallet) =
            abi.decode(vaultData, (uint256, uint256, address, address));
        require(drawInterval >= 60, "Interval too short");
        require(minHoldTokens > 0, "Min hold required");
        require(keeper != address(0), "Keeper required");
        require(devWallet != address(0), "Dev wallet required");

        uint256 minHold = minHoldTokens * 1e18;

        vault = address(
            new BeaconProxy(
                beacon,
                abi.encodeCall(
                    DrawPotHolderVault.initialize, (taxToken, drawInterval, minHold, keeper, devWallet)
                )
            )
        );
    }

    function isQuoteTokenSupported(address quoteToken) external pure override returns (bool) {
        return quoteToken == address(0);
    }

    function vaultDataSchema() public pure override returns (VaultDataSchema memory schema) {
        schema.description =
            "DrawPot holder vault. No registration. Winner gets 80%, dev gets 20%. Keeper runs each draw.";
        schema.fields = new FieldDescriptor[](4);
        schema.fields[0] = FieldDescriptor("drawInterval", "uint256", "Seconds between draws (1200 = 20 min)", 0);
        schema.fields[1] =
            FieldDescriptor("minHoldTokens", "uint256", "Minimum tokens to be eligible (whole tokens, e.g. 20000)", 0);
        schema.fields[2] = FieldDescriptor("keeper", "address", "Wallet allowed to execute draws", 0);
        schema.fields[3] = FieldDescriptor("devWallet", "address", "Wallet that receives 20% of each pot", 0);
        schema.isArray = false;
    }

    function tokenCreationPolicies() public pure override returns (FactoryPolicy[] memory policies) {
        policies = new FactoryPolicy[](2);
        policies[0] = FactoryPolicy({
            target: "quoteToken",
            operator: "eq",
            value: abi.encode(address(0)),
            description: "Payment token must be native ETH."
        });
        policies[1] = FactoryPolicy({
            target: "vaultBps",
            operator: "eq",
            value: abi.encode(uint16(10_000)),
            description: "Route 100% of tax to the vault (Vault = 100%)."
        });
    }

    function _validateBeforeLaunch(IVaultFactoryValidationV2.LaunchValidationDataV1 memory data)
        internal
        pure
        override
        returns (bool success, string memory reason)
    {
        if (data.quoteToken != address(0)) {
            return (false, "DrawPot vault requires native ETH as quote token.");
        }
        if (data.vaultBps != 10_000) {
            return (false, "Set tax allocation to 100% vault.");
        }
        if (data.deflationBps != 0 || data.dividendBps != 0 || data.lpBps != 0) {
            return (false, "Burn, dividend, and LP allocation must be 0%.");
        }
        return (true, "");
    }
}
