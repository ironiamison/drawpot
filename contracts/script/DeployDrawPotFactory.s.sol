// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {DrawPotLotteryVaultFactory} from "../src/DrawPotLotteryVault.sol";

contract DeployDrawPotFactory is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);

        DrawPotLotteryVaultFactory factory = new DrawPotLotteryVaultFactory();

        vm.stopBroadcast();

        console2.log("DrawPotLotteryVaultFactory:", address(factory));
        console2.log("Beacon:", factory.beacon());
        console2.log("");
        console2.log("Flap launch steps:");
        console2.log("1. Enable Vault -> Custom Vault Factory");
        console2.log("2. Paste factory address above");
        console2.log("3. drawInterval = 1200, minHoldTokens = 20000");
        console2.log("4. Buy/Sell tax 5%, allocation 100% vault, payment ETH");
    }
}
