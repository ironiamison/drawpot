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

  // The RPC rate-limits bursts, so the Transfer-log scan runs at most once per
  // request and feeds BOTH the eligible-holder count and the activity feed.
  let logStatePromise = null;
  const getLogState = () => (logStatePromise ||= fetchTokenLogState(RPC_URL, token, minRaw, excluded));

  try {
    // Explorer calls are best-effort (Blockscout sits behind Cloudflare at times);
    // everything the pot/draw logic needs comes straight from RPC.
    const [tokenInfoR, vaultBalanceHex, escrowPendingHex, hookPendingHex, transfersR, ethPrice, lottery, eligibleR] = await Promise.all([
      fetchJson(`${EXPLORER_API}/tokens/${token}`).catch(() => ({})),
      rpcGetBalance(RPC_URL, vault),
      rpcEscrowPending(RPC_URL, FEE_ESCROW_ADDRESS.toLowerCase(), vault),
      rpcHookPendingTax(RPC_URL).catch(() => "0x0"),
      fetchJson(`${EXPLORER_API}/tokens/${token}/transfers`).catch(() => ({ items: [] })),
      fetchEthPrice(),
      fetchLotteryState(RPC_URL, vault, fromBlock),
      fetchEligibleHolders(EXPLORER_API, token, minRaw, excluded)
        .catch(() => getLogState().then((s) => ({ count: s.count })))
        .catch(() => ({ count: 0 })),
    ]);
    const tokenInfo = tokenInfoR || {};
    let transfers = transfersR || { items: [] };
    const eligible = eligibleR || { count: 0 };
    if (!transfers.items?.length) {
      // Blockscout unreachable — rebuild the feed from the same log scan.
      transfers = { items: await getLogState().then((s) => s.recentTransfers).catch(() => []) };
    }

    // Read the pot straight from the chain: Blockscout's indexed coin_balance lags.
    // Include creator fees still sitting in the Pons escrow — they're claimed at
    // draw time — plus the ETH-side creator tax accruing on the MemeHook
    // post-graduation (moves to escrow when the Pons operator sweeps).
    const vaultWei = BigInt(vaultBalanceHex || "0x0") + BigInt(escrowPendingHex || "0x0") + BigInt(hookPendingHex || "0x0");
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

// Post-graduation, creator tax accrues on the shared Pons MemeHook per poolId
// until swept. ETH-side balance is readable via pendingCreatorTax(poolId, 0x0).
// (Token-denominated fees also accrue but need an operator conversion, so they
// show up in the pot only after a sweep.)
const MEME_HOOK = process.env.MEME_HOOK_ADDRESS || "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
const POOL_ID = process.env.POOL_ID || "0x5311c807a5a12ca3a854521f20170c8116199c0d3bacaf467a1efb1b3d30ce50";

async function rpcHookPendingTax(rpcUrl) {
  const data = "0xc8eaa792" + POOL_ID.slice(2) + "0".repeat(64); // pendingCreatorTax(poolId, native)
  return rpcCall(rpcUrl, MEME_HOOK, data);
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

// One pass over all Transfer logs since launch. Returns the eligible-holder
// count AND the most recent transfers (classified buy/sell) so the endpoint
// never scans twice. Retries individual RPC calls on rate-limit errors.
async function fetchTokenLogState(rpcUrl, token, minRaw, excluded) {
  const rpcReq = async (method, params, attempt = 0) => {
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method, params }),
    });
    const j = await r.json();
    if (j.error) {
      if (attempt < 3 && /rate limit/i.test(j.error.message || "")) {
        await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
        return rpcReq(method, params, attempt + 1);
      }
      throw new Error(j.error.message);
    }
    return j.result;
  };
  const latest = Number(BigInt(await rpcReq("eth_blockNumber", [])));
  const balances = new Map();
  let allLogs = [];
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
    allLogs = allLogs.concat(logs);
  }
  let count = 0;
  for (const [addr, bal] of balances) {
    if (bal >= minRaw && !excluded.has(addr)) count += 1;
  }

  // Latest transfers, classified; internal hops between system contracts
  // (pool → router → hook legs) are dropped so only user-facing action shows.
  const recent = allLogs
    .filter((l) => {
      const from = ("0x" + l.topics[1].slice(26)).toLowerCase();
      const to = ("0x" + l.topics[2].slice(26)).toLowerCase();
      return !(SYSTEM_ADDRESSES.has(from) && SYSTEM_ADDRESSES.has(to));
    })
    .slice(-15)
    .reverse();
  const blockTimes = {};
  for (const bn of [...new Set(recent.map((l) => l.blockNumber))]) {
    try {
      const b = await rpcReq("eth_getBlockByNumber", [bn, false]);
      blockTimes[bn] = new Date(Number(BigInt(b.timestamp)) * 1000).toISOString();
    } catch { blockTimes[bn] = ""; }
  }
  const recentTransfers = recent.map((l) => {
    const from = ("0x" + l.topics[1].slice(26)).toLowerCase();
    const to = ("0x" + l.topics[2].slice(26)).toLowerCase();
    let type = "transfer";
    if (SYSTEM_ADDRESSES.has(from)) type = "buy";
    else if (SYSTEM_ADDRESSES.has(to)) type = "sell";
    else if (from === "0x0000000000000000000000000000000000000000") type = "mint";
    return {
      from,
      to,
      tx_hash: l.transactionHash,
      timestamp: blockTimes[l.blockNumber] || "",
      type,
      amount: BigInt(l.data === "0x" ? "0x0" : l.data).toString(),
    };
  });

  return { count, recentTransfers };
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

// Pons/Uniswap system contracts: a transfer leaving one of these is a buy,
// one entering is a sell, anything else is a wallet-to-wallet move.
const SYSTEM_ADDRESSES = new Set([
  "0x8366a39cc670b4001a1121b8f6a443a643e40951", // Uniswap V4 pool manager
  "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044", // Pons meme hook
  "0x9eb4a3179621ccbb86eb8599400e54259b93d553", // LUCK bonding curve (graduated)
  "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e", // Pons factory
  "0x267444d099b10fb5ed7c3cc7b7c767adca574952", // launch locker
  "0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e", // fee escrow
  "0x42df2a798f82289e177311362e8f5ccc45c1219c", // buyback vault
  // swap routers observed in front of the V4 pool — transfers touching these
  // are trade legs, not wallet moves
  "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f",
  "0x39b38686a19836ac10162c490e4558e120cbbe5f",
  "0x8f10b468b06c6fd214b65f87778827f7d113f996",
  "0x8876789976decbfcbbbe364623c63652db8c0904",
]);

function mapTransfer(t) {
  const from = t.from?.hash || t.from || "?";
  const to = t.to?.hash || t.to || "?";
  const hash = t.tx_hash || t.transaction_hash || "";
  const ts = t.timestamp || t.block_timestamp || "";
  const type = t.type || (from === "0x0000000000000000000000000000000000000000" ? "mint" : "transfer");
  return { from, to, hash, ts, type, total: t.total?.value || t.amount || "0" };
}
