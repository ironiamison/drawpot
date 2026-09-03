// POTLUCK site config — set token + vault addresses after the Pons V2 launch.
// NOTE: current addresses are from the old Flap launch; replace them when the
// token relaunches on Pons (deploy DrawPotPonsVault first, it is the
// creatorFeeRecipient in the Pons launch params).
window.POTLUCK_CONFIG = {
  tokenAddress: "0x442b4591f357cd8de782442c732320317bbf7777",
  vaultAddress: "0xA0B2CAa5cf60d882Df8A3cfA0a107e340CdBe6e1",
  lotteryAddress: "0xA0B2CAa5cf60d882Df8A3cfA0a107e340CdBe6e1",
  vaultDeploymentBlock: 7886159,

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
