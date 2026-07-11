# DrawPot

On-chain lottery on **Robinhood Chain**. Hold **$POT**, fees fill the vault, one wallet wins every 20 minutes.

**Site:** [drawpot.xyz](https://drawpot.xyz) · **Chain:** [Robinhood Chain](https://docs.robinhood.com/chain/) (ID 4663)

## Deploy (GitHub Pages)

1. Push this repo to GitHub
2. Settings → Pages → Source: **Deploy from branch** → `main` / root
3. Add DNS for `drawpot.xyz`:
   - `A` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - or `CNAME` → `<username>.github.io`

## Local preview

```bash
python3 -m http.server 8080
```

## Token

| | |
|---|---|
| Name | DrawPot |
| Symbol | $POT |
| Chain | Robinhood Chain |
| Chain ID | 4663 |
| Explorer | [blockscout](https://robinhoodchain.blockscout.com/) |
| Wallet | [Robinhood Wallet](https://robinhood.com/us/en/support/articles/robinhood-wallet/) |
| Min entry | 20,000 $POT |
