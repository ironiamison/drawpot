// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {DrawPotPonsVault} from "../src/DrawPotPonsVault.sol";

/// Minimal replica of Pons V2 FeeEscrow claim semantics: credited balances,
/// claim() pays msg.sender and zeroes the ledger.
contract MockFeeEscrow {
    mapping(address => uint256) private _native;

    error NothingToClaim();

    function credit(address recipient) external payable {
        _native[recipient] += msg.value;
    }

    function balanceOf(address recipient) external view returns (uint256) {
        return _native[recipient];
    }

    function claim() external {
        uint256 amount = _native[msg.sender];
        if (amount == 0) revert NothingToClaim();
        _native[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "native transfer failed");
    }
}

contract MockToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function burn(address from, uint256 amount) external {
        balanceOf[from] -= amount;
    }
}

contract DrawPotPonsVaultTest is Test {
    MockFeeEscrow escrow;
    MockToken token;
    DrawPotPonsVault vault;

    address keeper = makeAddr("keeper");
    address devWallet = makeAddr("devWallet");
    address winner = makeAddr("winner");

    uint256 constant INTERVAL = 1200;
    uint256 constant MIN_HOLD = 20000e18;

    function setUp() public {
        escrow = new MockFeeEscrow();
        token = new MockToken();
        vault = new DrawPotPonsVault(address(escrow), INTERVAL, MIN_HOLD, keeper, devWallet);
        vault.setToken(address(token));
        token.mint(winner, MIN_HOLD);
    }

    function _executeDraw() internal {
        vm.roll(block.number + 1);
        vm.prank(keeper);
        vault.executeDraw(winner, keccak256("snapshot"), 5, block.number);
    }

    function test_drawClaimsEscrowAndSplits80_20() public {
        escrow.credit{value: 1 ether}(address(vault));
        assertEq(vault.potBalance(), 1 ether);
        assertEq(vault.pendingEscrow(), 1 ether);

        vm.warp(block.timestamp + INTERVAL);
        _executeDraw();

        assertEq(winner.balance, 0.8 ether);
        assertEq(devWallet.balance, 0.2 ether);
        assertEq(address(vault).balance, 0);
        assertEq(vault.pendingEscrow(), 0);
        assertEq(vault.drawCount(), 1);
        assertEq(vault.totalPaidOut(), 1 ether);
        assertEq(vault.totalDevPaid(), 0.2 ether);
        assertEq(vault.lastWinner(), winner);
        assertEq(vault.lastPrize(), 0.8 ether);
    }

    function test_drawCombinesHeldEthAndEscrow() public {
        vm.deal(address(this), 3 ether);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertTrue(ok);
        escrow.credit{value: 2 ether}(address(vault));

        assertEq(vault.potBalance(), 3 ether);

        vm.warp(block.timestamp + INTERVAL);
        _executeDraw();

        assertEq(winner.balance, 2.4 ether);
        assertEq(devWallet.balance, 0.6 ether);
    }

    function test_claimFeesIsPermissionlessAndIdempotent() public {
        escrow.credit{value: 0.5 ether}(address(vault));

        vm.prank(makeAddr("random"));
        uint256 claimed = vault.claimFees();
        assertEq(claimed, 0.5 ether);
        assertEq(address(vault).balance, 0.5 ether);

        // No revert when escrow is empty.
        uint256 second = vault.claimFees();
        assertEq(second, 0);
    }

    function test_revertsWhenPotEmpty() public {
        vm.warp(block.timestamp + INTERVAL);
        vm.roll(block.number + 1);
        vm.prank(keeper);
        vm.expectRevert("Empty pot");
        vault.executeDraw(winner, keccak256("snapshot"), 5, block.number);
    }

    function test_onlyKeeperCanDraw() public {
        escrow.credit{value: 1 ether}(address(vault));
        vm.warp(block.timestamp + INTERVAL);
        vm.expectRevert("Not keeper");
        vault.executeDraw(winner, keccak256("snapshot"), 5, block.number);
    }

    function test_revertsBeforeInterval() public {
        escrow.credit{value: 1 ether}(address(vault));
        vm.roll(block.number + 1);
        vm.prank(keeper);
        vm.expectRevert("Draw not ready");
        vault.executeDraw(winner, keccak256("snapshot"), 5, block.number);
    }

    function test_revertsWhenWinnerBelowMinHold() public {
        escrow.credit{value: 1 ether}(address(vault));
        token.burn(winner, 1);
        vm.warp(block.timestamp + INTERVAL);
        vm.roll(block.number + 1);
        vm.prank(keeper);
        vm.expectRevert("Winner below min");
        vault.executeDraw(winner, keccak256("snapshot"), 5, block.number);
    }

    function test_revertsOnStaleSnapshot() public {
        escrow.credit{value: 1 ether}(address(vault));
        vm.warp(block.timestamp + INTERVAL);
        uint256 snapshotBlock = block.number;
        vm.roll(block.number + vault.MAX_SNAPSHOT_AGE() + 1);
        vm.prank(keeper);
        vm.expectRevert("Stale snapshot");
        vault.executeDraw(winner, keccak256("snapshot"), 5, snapshotBlock);
    }

    function test_setTokenOnlyOnceAndOnlyOwner() public {
        DrawPotPonsVault fresh = new DrawPotPonsVault(address(escrow), INTERVAL, MIN_HOLD, keeper, devWallet);

        vm.prank(makeAddr("stranger"));
        vm.expectRevert("Not owner");
        fresh.setToken(address(token));

        fresh.setToken(address(token));
        vm.expectRevert("Token already set");
        fresh.setToken(address(token));
    }

    function test_drawRevertsUntilTokenSet() public {
        DrawPotPonsVault fresh = new DrawPotPonsVault(address(escrow), INTERVAL, MIN_HOLD, keeper, devWallet);
        escrow.credit{value: 1 ether}(address(fresh));
        vm.warp(block.timestamp + INTERVAL);
        vm.prank(keeper);
        vm.expectRevert("Token not set");
        fresh.executeDraw(winner, keccak256("snapshot"), 5, block.number);
    }

    function test_secondDrawWaitsFullInterval() public {
        escrow.credit{value: 1 ether}(address(vault));
        vm.warp(block.timestamp + INTERVAL);
        _executeDraw();

        escrow.credit{value: 1 ether}(address(vault));
        vm.roll(block.number + 1);
        vm.prank(keeper);
        vm.expectRevert("Draw not ready");
        vault.executeDraw(winner, keccak256("snapshot"), 5, block.number);

        vm.warp(block.timestamp + INTERVAL);
        _executeDraw();
        assertEq(vault.drawCount(), 2);
    }

    receive() external payable {}
}
