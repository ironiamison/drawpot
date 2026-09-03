# POTLUCK

Live on-chain lottery dashboard for Robinhood Chain. Hold $LUCK, win the pot.

**Site:** https://holdpot.xyz

## Launching on Pons V2

1. Deploy the vault first — it must exist before launch because it is the
   `creatorFeeRecipient`:

```bash
cd contracts
PRIVATE_KEY=0x... KEEPER_ADDRESS=0x... DEV_WALLET=0x... ./deploy.sh
```

2. Launch $LUCK on [ponsfamily.com](https://ponsfamily.com):
    - Quote asset: **native ETH**
    - `creatorFeeRecipient`: **the vault address**
    - `creatorTaxBps`: **500** (5%)
    - `buybackEnabled`: **false** (lets the creator wallet sweep curve fees)

3. Bind the token to the vault (one-time, from the deployer wallet):

```bash
cast send <VAULT> "setToken(address)" <TOKEN> --private-key $PRIVATE_KEY \
  --rpc-url https://rpc.mainnet.chain.robinhood.com
```

4. Paste addresses in `config.js`:

```js
tokenAddress: "0xYourTokenHere",
vaultAddress: "0xYourVaultHere",
vaultDeploymentBlock: ...,
```

5. Set Vercel env vars (for auto-draws):

```
TOKEN_ADDRESS=0x...
VAULT_ADDRESS=0x...
PRIVATE_KEY=0x...          # keeper wallet (use the launch creator wallet so it can sweep)
VAULT_DEPLOYMENT_BLOCK=...
CURVE_ADDRESS=0x...        # the token's Pons bonding curve (optional, pre-graduation sweeps)
```

6. Redeploy — site polls live vault data every 8s.

## How the pot fills on Pons

Pons V2 does not push fees: the 5% creator tax accrues on the bonding curve
(pre-graduation) or the Uniswap V4 hook (post-graduation), gets swept into the
Pons **FeeEscrow** (`0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`), and the vault
claims it automatically inside every `executeDraw`. The site shows
vault balance + escrow-pending as one pot.

## Local dev

```bash
vercel dev
```

## Domain

Production domain: `holdpot.xyz` (kept from before the POTLUCK rebrand — it is
already registered and attached to the Vercel project).
