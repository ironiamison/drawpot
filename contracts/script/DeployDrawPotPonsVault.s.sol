// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {DrawPotPonsVault} from "../src/DrawPotPonsVault.sol";

/// Deploy the vault BEFORE launching on Pons V2 — its address is the
/// `creatorFeeRecipient` in the launch params. After launch, call
/// `setToken(<token>)` from the deployer wallet.
contract DeployDrawPotPonsVault is Script {
    // Pons V2 FeeEscrow on Robinhood Chain (chain id 4663).
    address constant PONS_FEE_ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address keeper = vm.envAddress("KEEPER_ADDRESS");
        address devWallet = vm.envAddress("DEV_WALLET");
        uint256 drawInterval = vm.envOr("DRAW_INTERVAL", uint256(1200));
        uint256 minHoldTokens = vm.envOr("MIN_HOLD_TOKENS", uint256(20000));

        vm.startBroadcast(pk);
        DrawPotPonsVault vault = new DrawPotPonsVault(
            PONS_FEE_ESCROW,
            drawInterval,
            minHoldTokens * 1e18,
            keeper,
            devWallet
        );
        vm.stopBroadcast();

        console2.log("DrawPotPonsVault:", address(vault));
        console2.log("");
        console2.log("Pons V2 launch steps:");
        console2.log("1. Launch on ponsfamily.com (quote asset: native ETH)");
        console2.log("2. creatorFeeRecipient = vault address above");
        console2.log("3. creatorTaxBps = 500 (5%, cap is maxCreatorTaxBps = 1000)");
        console2.log("4. buybackEnabled = false (lets the creator wallet sweep curve fees)");
        console2.log("5. After launch: vault.setToken(<token address>) from deployer wallet");
        console2.log("6. Update config.js + Vercel env vars with token, vault, deployment block");
    }
}
