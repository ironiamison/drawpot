export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=30");

  const {
    TOKEN_ADDRESS = "",
    VAULT_ADDRESS = "",
    EXPLORER_API = "https://robinhoodchain.blockscout.com/api/v2",
    MIN_HOLD = "20000",
    DECIMALS = "18",
  } = process.env;

  const token = (req.query.token || TOKEN_ADDRESS || "").toLowerCase();
  if (!token || !/^0x[a-f0-9]{40}$/.test(token)) {
    return res.status(200).json({ live: false, error: "TOKEN_ADDRESS not configured" });
  }

  const vault = (req.query.vault || VAULT_ADDRESS || token).toLowerCase();
  const minHold = BigInt(MIN_HOLD);
  const decimals = Number(DECIMALS);
  const minRaw = minHold * 10n ** BigInt(decimals);

  try {
    const [tokenInfo, vaultAddr, transfers, ethPrice] = await Promise.all([
      fetchJson(`${EXPLORER_API}/tokens/${token}`),
      fetchJson(`${EXPLORER_API}/addresses/${vault}`),
      fetchJson(`${EXPLORER_API}/tokens/${token}/transfers?page=1`),
      fetchEthPrice(),
    ]);

    const holders = await fetchEligibleHolders(EXPLORER_API, token, minRaw);

    const vaultWei = BigInt(vaultAddr.coin_balance || "0");
    const vaultEth = Number(vaultWei) / 1e18;
    const vaultUsd = vaultEth * ethPrice;

    const totalSupply = BigInt(tokenInfo.total_supply || "0");
    const holderCount = Number(tokenInfo.holders || tokenInfo.holders_count || 0);

    const activity = (transfers.items || []).slice(0, 15).map(mapTransfer);

    return res.status(200).json({
      live: true,
      token,
      vault,
      symbol: tokenInfo.symbol || "POT",
      name: tokenInfo.name || "DrawPot",
      vaultEth,
      vaultUsd,
      ethPrice,
      holders: holders.count,
      entries: holders.count,
      holderCount,
      totalSupply: totalSupply.toString(),
      transfers: activity,
      updatedAt: Date.now(),
    });
  } catch (err) {
    return res.status(500).json({ live: false, error: err.message });
  }
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`API ${r.status}: ${url}`);
  return r.json();
}

async function fetchEthPrice() {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    const j = await r.json();
    return j.ethereum?.usd || 0;
  } catch {
    return 0;
  }
}

async function fetchEligibleHolders(api, token, minRaw) {
  let count = 0;
  let page = 1;
  const maxPages = 10;

  while (page <= maxPages) {
    const data = await fetchJson(`${api}/tokens/${token}/holders?page=${page}`);
    const items = data.items || [];
    if (!items.length) break;

    for (const h of items) {
      const val = BigInt(h.value || h.balance || "0");
      if (val >= minRaw) count += 1;
    }

    if (!data.next_page_params) break;
    page += 1;
  }

  return { count };
}

function mapTransfer(t) {
  const from = t.from?.hash || t.from || "?";
  const to = t.to?.hash || t.to || "?";
  const hash = t.tx_hash || t.transaction_hash || "";
  const ts = t.timestamp || t.block_timestamp || "";
  const type = t.type || (from === "0x0000000000000000000000000000000000000000" ? "mint" : "transfer");
  return { from, to, hash, ts, type, total: t.total?.value || t.amount || "0" };
}
