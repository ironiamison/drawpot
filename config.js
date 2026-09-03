// POTLUCK site config — vault is live on Robinhood Chain; set tokenAddress
// right after the $LUCK launch on Pons V2 (vault 0xa981… is the
// creatorFeeRecipient in the launch params).
window.POTLUCK_CONFIG = {
  tokenAddress: "", // set at Pons launch
  vaultAddress: "0xa981d27b27c6f60931e6c99a1bcf22ed2a2e8a9e",
  lotteryAddress: "0xa981d27b27c6f60931e6c99a1bcf22ed2a2e8a9e",
  vaultDeploymentBlock: 53367042,

  siteUrl: "https://holdpot.xyz",

  chainId: 4663,
  chainName: "Robinhood Chain",
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",
  explorerApi: "https://robinhoodchain.blockscout.com/api/v2",

  symbol: "LUCK",
  minHold: 20000,
  decimals: 18,

  // Pons V2 (ponsfamily.com) — creator fees accrue in this escrow until claimed.
  ponsUrl: "https://ponsfamily.com",
  feeEscrowAddress: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",

  pollMs: 8000,
  devFeeBps: 2000,
  winnerShareBps: 8000,

  vaultVersion: "pons",
};
