// POTLUCK site config — vault is live on Robinhood Chain; set tokenAddress
// right after the $LUCK launch on Pons V2 (vault 0xa981… is the
// creatorFeeRecipient in the launch params).
window.POTLUCK_CONFIG = {
  tokenAddress: "0x89b5749a2a675491163a6277779d4a7dc4b56c88",
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
  ponsUrl: "https://www.ponsfamily.com/launchpad/0x89b5749a2a675491163a6277779d4a7dc4b56c88",
  feeEscrowAddress: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
  // Post-graduation: fees accrue on the shared MemeHook per pool until the
  // Pons operator sweeps them into the escrow. Read pendingCreatorTax /
  // pendingFees with this poolId to show the true unswept pot.
  memeHookAddress: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
  poolId: "0x5311c807a5a12ca3a854521f20170c8116199c0d3bacaf467a1efb1b3d30ce50",

  pollMs: 8000,
  devFeeBps: 2000,
  winnerShareBps: 8000,

  vaultVersion: "pons",
};
