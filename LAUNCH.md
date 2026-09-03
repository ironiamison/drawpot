# POTLUCK launch runbook

Everything below is sequential. Wallet requirements: a **deployer/creator wallet**
(pays gas, launches the token, calls `setToken`) and a **keeper wallet** (executes
draws every 20 min — keep it topped up with Robinhood Chain ETH). They can be the
same wallet; using the creator wallet as keeper also lets it sweep curve fees.

## 1. Deploy the vault

```bash
cd contracts
export PRIVATE_KEY=0x...        # deployer
export KEEPER_ADDRESS=0x...     # draw executor
export DEV_WALLET=0x...         # receives 20% of each pot
./deploy.sh                     # prints the DrawPotPonsVault address
```

## 2. Launch $LUCK on Pons V2 (ponsfamily.com)

| Field | Value |
|---|---|
| Name / symbol | Potluck / LUCK |
| Quote asset | native ETH |
| `creatorFeeRecipient` | **the vault address from step 1** |
| `creatorTaxBps` | 500 (5%) |
| `buybackEnabled` | false |
| Logo | `assets/potluck-icon.png` |

Save the **token address** and **bonding curve address** from the launch
transaction (`TokenLaunched` event: token + curve).

## 3. Bind the token to the vault (one-time, deployer wallet)

```bash
cast send <VAULT> "setToken(address)" <TOKEN> \
  --private-key $PRIVATE_KEY \
  --rpc-url https://rpc.mainnet.chain.robinhood.com
```

## 4. Update site config

`config.js`: set `tokenAddress`, `vaultAddress`, `lotteryAddress` (= vault),
`vaultDeploymentBlock` (block of the vault deploy tx).

## 5. Set Vercel env vars

```
TOKEN_ADDRESS=0x...
VAULT_ADDRESS=0x...
PRIVATE_KEY=0x...              # keeper wallet
VAULT_DEPLOYMENT_BLOCK=...
CURVE_ADDRESS=0x...            # bonding curve — lets the keeper sweep fees pre-graduation
```

(The keeper cron in `vercel.json` already runs `/api/keeper` every minute.)

## 6. Deploy

```bash
vercel --prod
```

## 7. Smoke test

- Site shows "Live · LUCK" pill and the pot climbs as trades happen
  (pot = vault balance + escrow pending, so it moves even before the first claim).
- After 20 min: first `DrawExecuted` appears in Winner history with a payout tx.
- Manual keeper run if needed:
  `TOKEN_ADDRESS=... VAULT_ADDRESS=... PRIVATE_KEY=... CURVE_ADDRESS=... node keeper/draw.mjs`

## Anti-scam controls

- **Contracts can never win.** The keeper drops the bonding curve, vault, escrow,
  burn addresses, and any address with deployed code from the eligible set before
  picking a winner (balcheck is on-chain via `eth_getCode`/`balanceOf`).
- **Optional wallet allowlist.** Set `ALLOWLIST=0x...,0x...` in Vercel env to
  restrict winners to known wallets. Balances are still verified on-chain, and
  the vault contract independently re-checks the winner holds ≥ 20K at payout.
  Remove the env var to reopen draws to all holders.

## Notes

- Pot flow: trade → 5% creator tax accrues on curve/hook → swept to Pons
  FeeEscrow (`0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`) → vault claims inside
  `executeDraw` → 80% winner / 20% dev.
- Eligibility: hold ≥ 20,000 $LUCK at snapshot AND at payout.
- Keeper wallet needs gas for ~72 draws/day (tiny on Robinhood Chain, but check it weekly).
