const PRICE_SOURCES = [
  async () => {
    const j = await fetchJson("https://api.coinbase.com/v2/prices/ETH-USD/spot");
    return Number(j.data?.amount || 0);
  },
  async () => {
    const j = await fetchJson("https://api.kraken.com/0/public/Ticker?pair=ETHUSD");
    return Number(j.result?.XETHZUSD?.c?.[0] || 0);
  },
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  const vault = (req.query.vault || process.env.VAULT_ADDRESS || "").toLowerCase();
  const rpc = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

  if (!vault || !/^0x[a-f0-9]{40}$/.test(vault)) {
    return res.status(400).json({ ok: false, error: "vault required" });
  }

  // Pons V2 credits creator fees to its escrow until the vault claims them.
  const escrow = (process.env.FEE_ESCROW_ADDRESS || "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e").toLowerCase();

  try {
    const [balanceHex, pendingHex, ethPrice] = await Promise.all([
      rpcGetBalance(rpc, vault),
      rpcEscrowPending(rpc, escrow, vault),
      fetchEthPrice(),
    ]);

    const vaultWei = BigInt(balanceHex || "0x0") + BigInt(pendingHex || "0x0");
    const vaultEth = Number(vaultWei) / 1e18;
    const vaultUsd = vaultEth * ethPrice;

    return res.status(200).json({
      ok: true,
      vaultEth,
      vaultUsd,
      ethPrice,
      updatedAt: Date.now(),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function fetchEthPrice() {
  for (const source of PRICE_SOURCES) {
    try {
      const price = await source();
      if (price > 0) return price;
    } catch { /* try next */ }
  }
  return 0;
}

async function rpcEscrowPending(rpcUrl, escrow, vault) {
  try {
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "eth_call",
        params: [{ to: escrow, data: "0x70a08231" + vault.slice(2).padStart(64, "0") }, "latest"],
      }),
    });
    const j = await r.json();
    if (j.error) return "0x0";
    return j.result || "0x0";
  } catch {
    return "0x0";
  }
}

async function rpcGetBalance(rpcUrl, address) {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`API ${r.status}`);
  return r.json();
}
