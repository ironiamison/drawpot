# DAWPOT

Live on-chain lottery dashboard for Robinhood Chain.

**Vercel:** https://drawpot.vercel.app

## After launching on Flap

1. Paste your token contract in `config.js`:
```js
tokenAddress: "0xYourTokenHere",
vaultAddress: "0xYourVaultHere", // optional
flapUrl: "https://flap.sh/your-token-page",
```

2. Set Vercel env vars (optional, for server-side):
```
TOKEN_ADDRESS=0x...
VAULT_ADDRESS=0x...
```

3. Redeploy — site polls `/api/live` every 15s for real vault, holders, transfers.

## Local dev

```bash
vercel dev
```

## Custom domain

Add `drawpot.xyz` in Vercel → Project Settings → Domains.
