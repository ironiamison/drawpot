const DRAW_EXECUTED_TOPIC = "0xd151cf347adc3d1e7c281984c1abc221440f9b0356b84f3a8a157dfda332055e";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=3, stale-while-revalidate=10");

  const {
    TOKEN_ADDRESS = "",
    VAULT_ADDRESS = "",
    EXPLORER_API = "https://robinhoodchain.blockscout.com/api/v2",
    RPC_URL = "https://rpc.mainnet.chain.robinhood.com",
    MIN_HOLD = "20000",
    DECIMALS = "18",
    VAULT_DEPLOYMENT_BLOCK = "0",
    FEE_ESCROW_ADDRESS = "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
    CURVE_ADDRESS = "",
  } = process.env;

  const token = (req.query.token || TOKEN_ADDRESS || "").toLowerCase();
  if (!token || !/^0x[a-f0-9]{40}$/.test(token)) {
    return res.status(200).json({ live: false, error: "TOKEN_ADDRESS not configured" });
  }

  const vault = (req.query.vault || VAULT_ADDRESS || "").toLowerCase();
  if (!vault || !/^0x[a-f0-9]{40}$/.test(vault)) {
    return res.status(200).json({ live: false, error: "VAULT_ADDRESS not configured" });
  }

  const minHold = BigInt(MIN_HOLD);
  const decimals = Number(DECIMALS);
  const minRaw = minHold * 10n ** BigInt(decimals);
  const fromBlock = `0x${Number(VAULT_DEPLOYMENT_BLOCK || 0).toString(16)}`;

  const excluded = new Set([
    token,
    vault,
    CURVE_ADDRESS.toLowerCase(),
    FEE_ESCROW_ADDRESS.toLowerCase(),
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead",
  ]);

  try {
    // Explorer calls are best-effort (Blockscout sits behind Cloudflare at times);
    // everything the pot/draw logic needs comes straight from RPC.
    const [tokenInfoR, vaultBalanceHex, escrowPendingHex, transfersR, ethPrice, lottery, eligibleR] = await Promise.all([
      fetchJson(`${EXPLORER_API}/tokens/${token}`).catch(() => ({})),
      rpcGetBalance(RPC_URL, vault),
      rpcEscrowPending(RPC_URL, FEE_ESCROW_ADDRESS.toLowerCase(), vault),
      fetchJson(`${EXPLORER_API}/tokens/${token}/transfers`).catch(() => ({ items: [] })),
      fetchEthPrice(),
      fetchLotteryState(RPC_URL, vault, fromBlock),
      fetchEligibleHolders(EXPLORER_API, token, minRaw, excluded)
        .catch(() => fetchEligibleFromLogs(RPC_URL, token, minRaw, excluded))
        .catch(() => ({ count: 0 })),
    ]);
    const tokenInfo = tokenInfoR || {};
    const transfers = transfersR || { items: [] };
    const eligible = eligibleR || { count: 0 };

    // Read the pot straight from the chain: Blockscout's indexed coin_balance lags.
    // Include creator fees still sitting in the Pons escrow — they're claimed at draw time.
    const vaultWei = BigInt(vaultBalanceHex || "0x0") + BigInt(escrowPendingHex || "0x0");
    const vaultEth = Number(vaultWei) / 1e18;
    const vaultUsd = vaultEth * Number(ethPrice || 0);

    const totalSupply = BigInt(tokenInfo.total_supply || "0");
    const holderCount = Number(tokenInfo.holders || tokenInfo.holders_count || 0);
    const activity = (transfers.items || []).slice(0, 15).map(mapTransfer);

    return res.status(200).json({
      live: true,
      token,
      vault,
      symbol: tokenInfo.symbol || "LUCK",
      name: tokenInfo.name || "Potluck",
      vaultEth,
      vaultUsd,
      ethPrice,
      holders: eligible.count,
      eligibleHolders: eligible.count,
      nextDrawTime: lottery.nextDrawTime,
      drawCount: lottery.drawCount,
      lastWinner: lottery.lastWinner,
      lastPrize: lottery.lastPrize,
      lastDrawTime: lottery.lastDrawTime,
      winnerHistory: lottery.winnerHistory,
      totalPaidOut: lottery.totalPaidOut,
      holderCount,
      totalSupply: totalSupply.toString(),
      transfers: activity,
      updatedAt: Date.now(),
    });
  } catch (err) {
    return res.status(500).json({ live: false, error: err.message });
  }
}

async function fetchLotteryState(rpcUrl, vault, fromBlock) {
  try {
    const [nextDrawTime, drawCount, lastWinner, lastPrize, totalPaidOut] = await Promise.all([
      rpcCall(rpcUrl, vault, "0x74f47a7a"),
      rpcCall(rpcUrl, vault, "0x08222d58"),
      rpcCall(rpcUrl, vault, "0xfe188184"),
      rpcCall(rpcUrl, vault, "0x9d400a0b"),
      rpcCall(rpcUrl, vault, "0x1357e1dc"),
    ]);

    const winnerHistory = await fetchWinnerHistory(rpcUrl, vault, fromBlock);
    const lastWinnerTx = winnerHistory[0]?.transactionHash || "";
    return {
      nextDrawTime: Number(BigInt(nextDrawTime || "0x0")),
      drawCount: Number(BigInt(drawCount || "0x0")),
      lastWinner: `0x${(lastWinner || "0x").slice(-40)}`,
      lastPrize: (BigInt(lastPrize || "0x0")).toString(),
      lastDrawTime: winnerHistory[0]?.timestamp || 0,
      totalPaidOut: (BigInt(totalPaidOut || "0x0")).toString(),
      lastWinnerTx,
      winnerHistory,
    };
  } catch {
    return { nextDrawTime: 0, drawCount: 0, lastWinner: "", lastPrize: "0", lastDrawTime: 0, totalPaidOut: "0", lastWinnerTx: "", winnerHistory: [] };
  }
}

async function fetchWinnerHistory(rpcUrl, vault, fromBlock) {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "eth_getLogs",
      params: [{
        address: vault,
        fromBlock,
        toBlock: "latest",
        topics: [DRAW_EXECUTED_TOPIC],
      }],
    }),
  });
  const payload = await r.json();
  if (payload.error) throw new Error(payload.error.message);
  const logs = payload.result || [];
  return logs.reverse().map((log) => {
    const data = (log.data || "").slice(2);
    return {
      drawId: BigInt(log.topics[1] || "0x0").toString(),
      winner: `0x${(log.topics[2] || "").slice(-40)}`,
      prize: BigInt(`0x${data.slice(64, 128) || "0"}`).toString(),
      devPrize: BigInt(`0x${data.slice(128, 192) || "0"}`).toString(),
      timestamp: Number(BigInt(`0x${data.slice(192, 256) || "0"}`)),
      eligibleCount: BigInt(`0x${data.slice(256, 320) || "0"}`).toString(),
      transactionHash: log.transactionHash,
    };
  });
}

async function rpcEscrowPending(rpcUrl, escrow, vault) {
  try {
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
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
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "eth_getBalance", params: [address, "latest"] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function rpcCall(rpcUrl, to, data) {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`API ${r.status}: ${url}`);
  return r.json();
}

// Indexer-free eligible-holder count: replay Transfer logs since launch.
const TOKEN_LAUNCH_BLOCK = Number(process.env.TOKEN_LAUNCH_BLOCK || "53382236");
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function fetchEligibleFromLogs(rpcUrl, token, minRaw, excluded) {
  const rpcReq = async (method, params) => {
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method, params }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };
  const latest = Number(BigInt(await rpcReq("eth_blockNumber", [])));
  const balances = new Map();
  const CHUNK = 10_000;
  for (let from = TOKEN_LAUNCH_BLOCK; from <= latest; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, latest);
    const logs = await rpcReq("eth_getLogs", [{
      address: token,
      topics: [TRANSFER_TOPIC],
      fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + to.toString(16),
    }]);
    for (const l of logs) {
      const src = ("0x" + l.topics[1].slice(26)).toLowerCase();
      const dst = ("0x" + l.topics[2].slice(26)).toLowerCase();
      const amt = BigInt(l.data === "0x" ? "0x0" : l.data);
      balances.set(src, (balances.get(src) || 0n) - amt);
      balances.set(dst, (balances.get(dst) || 0n) + amt);
    }
  }
  let count = 0;
  for (const [addr, bal] of balances) {
    if (bal >= minRaw && !excluded.has(addr)) count += 1;
  }
  return { count };
}

// Several sources because each one fails somewhere: CoinGecko rate-limits,
// Binance geo-blocks US datacenters (Vercel), so Coinbase/Kraken back them up.
const PRICE_SOURCES = [
  async () => {
    const j = await fetchJson("https://api.coinbase.com/v2/prices/ETH-USD/spot");
    return Number(j.data?.amount || 0);
  },
  async () => {
    const j = await fetchJson("https://api.kraken.com/0/public/Ticker?pair=ETHUSD");
    return Number(j.result?.XETHZUSD?.c?.[0] || 0);
  },
  async () => {
    const j = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    return Number(j.ethereum?.usd || 0);
  },
];

async function fetchEthPrice() {
  for (const source of PRICE_SOURCES) {
    try {
      const price = await source();
      if (price > 0) return price;
    } catch { /* try next source */ }
  }
  return 0;
}

async function fetchEligibleHolders(api, token, minRaw, excluded = new Set()) {
  let count = 0;
  let cursor = "";
  const maxPages = 10;

  for (let page = 0; page < maxPages; page += 1) {
    const data = await fetchJson(`${api}/tokens/${token}/holders${cursor}`);
    const items = data.items || [];
    if (!items.length) break;

    let reachedBelowMinimum = false;
    for (const h of items) {
      const addr = (h.address?.hash || h.address || "").toLowerCase();
      const val = BigInt(h.value || h.balance || "0");
      if (val >= minRaw) {
        if (!excluded.has(addr)) count += 1;
      } else {
        reachedBelowMinimum = true;
      }
    }

    // Blockscout returns holders ordered by balance, so lower pages cannot add eligible wallets.
    if (reachedBelowMinimum || !data.next_page_params) break;
    cursor = `?${new URLSearchParams(data.next_page_params).toString()}`;
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
