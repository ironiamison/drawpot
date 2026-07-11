# DrawPot

On-chain lottery on **Robinhood Chain**, launched via **[Flap](https://flap.sh)**.

Hold **$POT**, taxes fill the vault, one wallet wins every 20 minutes.

**Site:** [drawpot.xyz](https://drawpot.xyz)

## Flap launch config

Use these settings in Flap (matches your screenshot):

| Setting | Value |
|---------|-------|
| Enable Vault | **On** |
| Payment Token | **ETH** |
| Buy Tax | **5%** |
| Sell Tax | **5%** |
| Tax Allocation | **100% → Vault** (0% burn, 0% dividend, 0% LP) |

The red **"Total allocation must be 100%"** error means you need to assign all tax buckets — set Vault/Marketing to **100%** and leave the rest at 0.

## Token

| | |
|---|---|
| Name | DrawPot |
| Symbol | $POT |
| Launch | [Flap](https://flap.sh) |
| Chain | Robinhood Chain (4663) |
| Buy / Sell Tax | 5% / 5% |
| Min entry | 20,000 $POT |

## Local preview

```bash
python3 -m http.server 8080
```
