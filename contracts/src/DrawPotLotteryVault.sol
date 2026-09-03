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

/// @title DrawPotLotteryVault
/// @notice Flap tax vault — accumulates ETH from trade tax, pays one random eligible holder every N seconds.
/// @dev Holders with >= minHold must call enterDraw() once. Anyone can call executeDraw() after the interval.
contract DrawPotLotteryVault is Initializable, VaultBaseV2, ReentrancyGuardUpgradeable {
    uint256 public constant MAX_ENTRANTS = 4096;

    address public taxToken;
    uint256 public drawInterval;
    uint256 public minHold;

    uint256 public lastDrawTime;
    uint256 public drawCount;
    uint256 public totalPaidOut;

    address public lastWinner;
    uint256 public lastPrize;

    address[] internal _entrants;
    mapping(address => uint256) internal _entrantIndex; // index + 1, 0 = not entered

    event EnteredDraw(address indexed wallet);
    event ExitedDraw(address indexed wallet);
    event DrawExecuted(uint256 indexed drawId, address indexed winner, uint256 prize, uint256 timestamp);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _taxToken, uint256 _drawInterval, uint256 _minHold) external initializer {
        __ReentrancyGuard_init();
        require(_drawInterval >= 60, "Interval too short");
        require(_minHold > 0, "Min hold required");

        taxToken = _taxToken;
        drawInterval = _drawInterval;
        minHold = _minHold;
        lastDrawTime = block.timestamp;
    }

    receive() external payable {}

    /// @notice Register wallet for upcoming draws. Must hold >= minHold $POT.
    function enterDraw() external {
        _enter(msg.sender);
    }

    /// @notice Remove wallet from the draw pool.
    function exitDraw() external {
        _removeEntrant(msg.sender);
        emit ExitedDraw(msg.sender);
    }

    /// @notice Execute a draw when the interval has elapsed. Pays full vault balance to one winner.
    function executeDraw() external nonReentrant {
        require(block.timestamp >= lastDrawTime + drawInterval, "Draw not ready");
        require(_entrants.length > 0, "No entrants");
        require(address(this).balance > 0, "Empty pot");

        address winner = _pickWinner();
        require(winner != address(0), "No eligible winner");

        uint256 prize = address(this).balance;
        lastDrawTime = block.timestamp;
        drawCount++;
        lastWinner = winner;
        lastPrize = prize;
        totalPaidOut += prize;

        emit DrawExecuted(drawCount, winner, prize, block.timestamp);

        (bool ok,) = winner.call{value: prize}("");
        require(ok, "Payout failed");
    }

    function nextDrawTime() external view returns (uint256) {
        return lastDrawTime + drawInterval;
    }

    function potBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function entrantCount() external view returns (uint256) {
        return _entrants.length;
    }

    function isRegistered(address wallet) external view returns (bool) {
        return _entrantIndex[wallet] > 0;
    }

    function getEntrant(uint256 index) external view returns (address) {
        return _entrants[index];
    }

    function description() public view override returns (string memory) {
        return string(
            abi.encodePacked(
                "DrawPot Lottery Vault: ",
                _uintToString(drawInterval),
                "s draws, min hold ",
                _uintToString(minHold / 1e18),
                " tokens. Pot ",
                _uintToString(address(this).balance / 1e15),
                " milli-ETH, ",
                _uintToString(_entrants.length),
                " entrants, ",
                _uintToString(drawCount),
                " draws completed."
            )
        );
    }

    function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
        schema.vaultType = "DrawPotLotteryVault";
        schema.description =
            "On-chain lotto vault. Tax fills the pot. One registered holder wins the full balance every draw interval.";
        schema.methods = new VaultMethodSchema[](7);

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

        schema.methods[2].name = "entrantCount";
        schema.methods[2].description = "Registered wallets in the current draw pool.";
        schema.methods[2].inputs = new FieldDescriptor[](0);
        schema.methods[2].outputs = _singleUint("count", "Entrant count", 0);
        schema.methods[2].approvals = new ApproveAction[](0);

        schema.methods[3].name = "drawCount";
        schema.methods[3].description = "Total completed draws.";
        schema.methods[3].inputs = new FieldDescriptor[](0);
        schema.methods[3].outputs = _singleUint("count", "Draw count", 0);
        schema.methods[3].approvals = new ApproveAction[](0);

        schema.methods[4].name = "enterDraw";
        schema.methods[4].description = "Register if you hold the minimum $POT balance.";
        schema.methods[4].inputs = new FieldDescriptor[](0);
        schema.methods[4].outputs = new FieldDescriptor[](0);
        schema.methods[4].approvals = new ApproveAction[](0);
        schema.methods[4].isWriteMethod = true;

        schema.methods[5].name = "exitDraw";
        schema.methods[5].description = "Leave the draw pool.";
        schema.methods[5].inputs = new FieldDescriptor[](0);
        schema.methods[5].outputs = new FieldDescriptor[](0);
        schema.methods[5].approvals = new ApproveAction[](0);
        schema.methods[5].isWriteMethod = true;

        schema.methods[6].name = "executeDraw";
        schema.methods[6].description = "Run the draw after the interval. Pays one winner the full pot.";
        schema.methods[6].inputs = new FieldDescriptor[](0);
        schema.methods[6].outputs = new FieldDescriptor[](0);
        schema.methods[6].approvals = new ApproveAction[](0);
        schema.methods[6].isWriteMethod = true;
    }

    function _enter(address wallet) internal {
        require(IERC20(taxToken).balanceOf(wallet) >= minHold, "Below min hold");
        if (_entrantIndex[wallet] > 0) return;
        require(_entrants.length < MAX_ENTRANTS, "Entrant cap reached");

        _entrants.push(wallet);
        _entrantIndex[wallet] = _entrants.length;
        emit EnteredDraw(wallet);
    }

    function _removeEntrant(address wallet) internal {
        uint256 idx = _entrantIndex[wallet];
        if (idx == 0) return;

        uint256 lastIdx = _entrants.length;
        address lastWallet = _entrants[lastIdx - 1];

        _entrants[idx - 1] = lastWallet;
        _entrantIndex[lastWallet] = idx;
        _entrants.pop();
        delete _entrantIndex[wallet];
    }

    function _pickWinner() internal view returns (address) {
        uint256 len = _entrants.length;
        uint256 seed = uint256(
            keccak256(
                abi.encodePacked(block.prevrandao, block.timestamp, address(this), drawCount, len, block.number)
            )
        );

        for (uint256 attempt = 0; attempt < 16; attempt++) {
            address candidate = _entrants[seed % len];
            if (IERC20(taxToken).balanceOf(candidate) >= minHold) {
                return candidate;
            }
            seed = uint256(keccak256(abi.encodePacked(seed, attempt)));
        }
        return address(0);
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

/// @title DrawPotLotteryVaultFactory
/// @notice Flap V2 vault factory for DrawPot lottery vaults on Robinhood Chain and BNB.
contract DrawPotLotteryVaultFactory is VaultFactoryBaseV2 {
    address public immutable beacon;

    constructor() {
        DrawPotLotteryVault impl = new DrawPotLotteryVault();
        beacon = address(new UpgradeableBeacon(address(impl)));
    }

    function newVault(address taxToken, address, address, bytes calldata vaultData)
        external
        override
        returns (address vault)
    {
        require(msg.sender == _getVaultPortal(), "Only VaultPortal");

        (uint256 drawInterval, uint256 minHoldTokens) = abi.decode(vaultData, (uint256, uint256));
        require(drawInterval >= 60, "Interval too short");
        require(minHoldTokens > 0, "Min hold required");

        uint256 minHold = minHoldTokens * 1e18;

        vault = address(
            new BeaconProxy(
                beacon,
                abi.encodeCall(DrawPotLotteryVault.initialize, (taxToken, drawInterval, minHold))
            )
        );
    }

    function isQuoteTokenSupported(address quoteToken) external pure override returns (bool) {
        return quoteToken == address(0);
    }

    function vaultDataSchema() public pure override returns (VaultDataSchema memory schema) {
        schema.description =
            "DrawPot lottery vault. One winner takes the full pot every draw interval. Holders above min balance must enterDraw() once.";
        schema.fields = new FieldDescriptor[](2);
        schema.fields[0] = FieldDescriptor("drawInterval", "uint256", "Seconds between draws (1200 = 20 min)", 0);
        schema.fields[1] = FieldDescriptor("minHoldTokens", "uint256", "Minimum $POT to enter (whole tokens, e.g. 20000)", 0);
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
