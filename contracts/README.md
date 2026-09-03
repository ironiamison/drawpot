# DrawPot Pons Vault (v3)

Pons V2-compatible vault — hold to enter, auto payouts, 80/20 split.

## What it does

1. The vault is the launch's **creatorFeeRecipient** on Pons V2, so the 5%
   creator tax on every buy/sell is credited to it (in ETH) via the Pons
   **FeeEscrow** (`0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`).
2. Holders with **≥ minHoldTokens** are eligible automatically — no registration.
3. Every **1200s** (20 min) the **keeper** snapshots eligible holders and
   executes the draw. `executeDraw` claims any escrow balance first, so the
   full accrued pot is paid.
4. **80%** of the pot goes to one random eligible holder, **20%** to `devWallet`.
5. Sell below minimum → removed from next snapshot.

Same ABI surface as the old Flap vault (`executeDraw`, views, `DrawExecuted`
event), so the site and keeper are unchanged.

## Deploy vault (BEFORE the Pons launch)

```bash
cd contracts
export PRIVATE_KEY=0x...
export KEEPER_ADDRESS=0x...   # draw executor wallet (needs RH-chain ETH)
export DEV_WALLET=0x...       # receives 20% each draw
forge script script/DeployDrawPotPonsVault.s.sol:DeployDrawPotPonsVault \
  --root . \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --chain-id 4663 \
  --broadcast
```

Optional env: `DRAW_INTERVAL` (default 1200), `MIN_HOLD_TOKENS` (default 20000).

Note: run forge from `contracts/` with `--root .` — without it, forge
mis-detects the repo root and tries to compile the vendored `_flap-example`.

## Launch on Pons V2 (ponsfamily.com)

- Quote asset: **native ETH**
- `creatorFeeRecipient`: **the deployed vault address**
- `creatorTaxBps`: **500** (5% — protocol cap is `maxCreatorTaxBps()` = 1000)
- `buybackEnabled`: **false** — creator-wallet sweeps of the curve then need no
  internal swap, so the keeper can sweep without the Pons operator

## After launch

1. `vault.setToken(<token>)` from the deployer wallet (one-time).
2. Update `config.js` with token, vault, and deployment block.
3. Set Vercel env vars (see repo README) — include `CURVE_ADDRESS` so the
   keeper sweeps curve fees into escrow before each draw pre-graduation.

## How fees flow

```
trade → creator tax accrues on bonding curve (or V4 hook after graduation)
      → sweepFees / sweepPoolFees credits the Pons FeeEscrow
      → vault claims escrow inside executeDraw (or anyone calls claimFees())
      → 80% winner / 20% dev
```

## Auto payouts

Cron runs `/api/keeper` every minute. The site polls every 8s and bursts every
3s after draw time to show winners quickly.

Or run manually:

```bash
TOKEN_ADDRESS=0x... VAULT_ADDRESS=0x... PRIVATE_KEY=0x... CURVE_ADDRESS=0x... node keeper/draw.mjs
```

## Legacy

`DrawPotHolderVault.sol` / `DrawPotLotteryVault.sol` are the old Flap-launch
vaults (factory `0x9764e834ca7DaF54103D89c14D827589199E5b5B`). Kept for the
deployed contracts' reference; new launches use `DrawPotPonsVault.sol`.
