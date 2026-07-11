// Set your contract addresses here after launch on Flap
window.DAWPOT_CONFIG = {
  // Token contract — paste after launch
  tokenAddress: "",

  // Flap vault address (optional — falls back to token contract ETH balance)
  vaultAddress: "",

  // Lottery/draw contract (optional — for winner events)
  lotteryAddress: "",

  chainId: 4663,
  chainName: "Robinhood Chain",
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",
  explorerApi: "https://robinhoodchain.blockscout.com/api/v2",

  symbol: "POT",
  minHold: 20000,
  decimals: 18,

  // Flap buy link — update with your token slug after launch
  flapUrl: "https://flap.sh",

  pollMs: 15000,
};
