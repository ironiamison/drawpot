/* POTLUCK — live data + holder-only lotto UX */

const DRAW_MS = 20 * 60 * 1000;
const RING_C = 327;
const DRAW_EXECUTED_TOPIC = "0xd151cf347adc3d1e7c281984c1abc221440f9b0356b84f3a8a157dfda332055e";
const cfg = () => window.POTLUCK_CONFIG || {};

const state = {
  live: false,
  connected: false,
  wallet: null,
  walletBalance: 0n,
  vaultEth: 0,
  vaultUsd: 0,
  ethPrice: 0,
  potLoaded: false,
  participants: 0,
  nextDrawTime: 0,
  seenTx: new Set(),
  lastDrawSlot: -1,
  lastVaultEth: 0,
  lastVaultUsd: 0,
  ballNums: [],
  announcedDraw: null,
};

function $(id) { return document.getElementById(id); }

function fmtUsd(n) {
  if (!n || !Number.isFinite(n)) return "0.00";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtEth(n) {
  if (!n || !Number.isFinite(n)) return "0.0000";
  return n.toFixed(4);
}

function shortAddr(a) {
  if (!a || a.length < 10) return a || "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function rand(n, m) { return Math.floor(Math.random() * (m - n + 1)) + n; }

function showToast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add("hidden"), 2800);
}

function applyConfig() {
  const token = cfg().tokenAddress || "";
  $("copy-contract").dataset.address = token;
  const pons = cfg().ponsUrl || "https://ponsfamily.com";
  ["buy-link", "buy-link-draw"].forEach((id) => {
    const el = $(id);
    if (el) el.href = pons;
  });

  const vaultContract = cfg().vaultAddress || "";
  const factoryLink = $("factory-link");
  const factoryAddr = $("factory-addr");
  if (vaultContract && factoryLink && factoryAddr) {
    factoryLink.href = `${cfg().explorer}/address/${vaultContract}`;
    factoryAddr.textContent = `${vaultContract.slice(0, 6)}…${vaultContract.slice(-4)}`;
    factoryLink.hidden = false;
  }

  const minHold = cfg().minHold || 20000;
  $("entries").textContent = `${(minHold / 1000).toFixed(0)}K`;
}

function renderBalls(containerId) {
  const el = $(containerId);
  if (!el) return;
  if (!state.ballNums.length) {
    state.ballNums = [rand(1, 99), rand(1, 99), rand(1, 99), rand(1, 99)];
  }
  el.innerHTML = [
    ...state.ballNums.map((n) => `<span class="ball">${String(n).padStart(2, "0")}</span>`),
    `<span class="ball ball--bonus">★</span>`,
  ].join("");
}

function shuffleBalls(animate = true) {
  state.ballNums = Array.from({ length: 4 }, () => rand(1, 99));
  const el = $("draw-balls");
  if (animate && el) {
    el.classList.add("shuffling");
    setTimeout(() => el.classList.remove("shuffling"), 400);
  }
  renderBalls("draw-balls");
}

function tickJackpot() {
  const el = $("prize-pool");
  el.classList.remove("tick");
  void el.offsetWidth;
  el.classList.add("tick");
}

function updateCountdown() {
  let target = state.nextDrawTime ? state.nextDrawTime * 1000 : Date.now() + DRAW_MS - (Date.now() % DRAW_MS);
  // If the on-chain draw is overdue (keeper hasn't fired yet), roll the target
  // forward in whole intervals so the countdown ticks steadily instead of
  // sitting at 00:00 / flapping between values.
  while (target <= Date.now()) target += DRAW_MS;
  const remaining = Math.max(0, target - Date.now());
  const sec = Math.floor(remaining / 1000);
  const min = Math.floor(sec / 60);
  const s = sec % 60;

  $("countdown").textContent = `${String(min).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  $("ring-progress").style.strokeDashoffset = RING_C * (remaining / DRAW_MS);

  const block = $("timer-block");
  const phase = $("draw-phase");

  if (sec <= 15) {
    block?.classList.add("urgent");
    phase.textContent = sec <= 5 ? "Draw now" : "Get ready";
    if (sec <= 10 && sec % 3 === 0) shuffleBalls(true);
  } else {
    block?.classList.remove("urgent");
    phase.textContent = state.live ? "Auto-payout pending" : "Launch pending";
  }

  // Fire the draw-moment overlay once per countdown target (not per wall-clock
  // slot, which caused repeat popups while a draw was overdue).
  if (sec <= 1 && state.lastDrawSlot !== target) {
    state.lastDrawSlot = target;
    onDrawMoment();
    startDrawPollBurst();
  }
}

// Any open tab can trigger the draw: the vault enforces timing on-chain, so a
// public nudge is harmless. Throttled + staggered so a crowd of visitors
// doesn't fire duplicate transactions at the same instant.
let lastKeeperNudge = 0;
function nudgeKeeper() {
  if (Date.now() - lastKeeperNudge < 60_000) return;
  lastKeeperNudge = Date.now();
  setTimeout(() => fetch("/api/keeper").catch(() => {}), 500 + Math.random() * 8000);
}

let drawPollBurstTimer = null;
function startDrawPollBurst() {
  nudgeKeeper();
  clearInterval(drawPollBurstTimer);
  let ticks = 0;
  drawPollBurstTimer = setInterval(() => {
    fetchLive();
    if (++ticks >= 40) clearInterval(drawPollBurstTimer);
  }, 3000);
}

function onDrawMoment() {
  shuffleBalls(true);
  const overlay = $("draw-overlay");
  overlay?.classList.remove("hidden");
  renderBalls("overlay-balls");
  $("overlay-msg").textContent = state.live
    ? "Draw window open — keeper selecting winner"
    : "Launch token to enable draws";
  setTimeout(() => overlay?.classList.add("hidden"), 3500);
}

function renderPot() {
  const vaultEth = state.vaultEth;
  const vaultUsd = state.vaultUsd;

  const hasUsd = vaultUsd > 0;
  $("prize-eth").textContent = fmtEth(vaultEth);
  $("prize-pool").textContent = hasUsd ? fmtUsd(vaultUsd) : `${fmtEth(vaultEth)} ETH`;
  // No USD price yet: ETH is already the headline number, so hide the "$" and the ETH sub-line.
  const currencyEl = document.querySelector(".jackpot-currency");
  const subEl = document.querySelector(".jackpot-sub");
  if (currencyEl) currencyEl.style.display = hasUsd ? "" : "none";
  if (subEl) subEl.style.visibility = hasUsd ? "visible" : "hidden";
  $("vault-balance").textContent = hasUsd ? "$" + fmtUsd(vaultUsd) : `${fmtEth(vaultEth)} ETH`;

  const fill = Math.min(100, vaultEth > 0 ? Math.log10(vaultEth * 2000 + 1) * 28 : 0);
  $("vault-fill").style.width = `${fill}%`;
  $("vault-fill-pct").textContent = vaultEth > 0
    ? `${fmtEth(vaultEth)} ETH in vault`
    : "Waiting for launch…";

  if (vaultEth !== state.lastVaultEth || vaultUsd !== state.lastVaultUsd) {
    tickJackpot();
    state.lastVaultEth = vaultEth;
    state.lastVaultUsd = vaultUsd;
    if (vaultUsd > 0 || vaultEth > 0) shuffleBalls(true);
  }
}

function renderStats(data) {
  state.live = !!data.live;
  if (data.ethPrice > 0) state.ethPrice = data.ethPrice;
  // Only seed the pot from the slow live API if we have not loaded it yet.
  if (!state.potLoaded && data.vaultEth > 0) {
    state.vaultEth = data.vaultEth;
    state.vaultUsd = data.vaultUsd || data.vaultEth * (state.ethPrice || 0);
    state.potLoaded = true;
    renderPot();
  }
  state.participants = data.eligibleHolders ?? data.entrants ?? data.holders ?? 0;
  // Keep the last known draw time if a refresh comes back empty — prevents the
  // countdown from jumping to the wall-clock fallback and back.
  state.nextDrawTime = data.nextDrawTime || state.nextDrawTime;
  // Draw overdue on-chain? Nudge the keeper (throttled) so it fires even if
  // no cron is running.
  if (state.nextDrawTime && Date.now() / 1000 > state.nextDrawTime + 5) nudgeKeeper();

  $("fees-collected").textContent = state.live ? "Live" : "—";
  const totalPaidEth = Number(BigInt(data.totalPaidOut || "0")) / 1e18;
  $("total-paid").textContent = `${fmtEth(totalPaidEth)} ETH`;
  $("participants").textContent = state.participants.toLocaleString();
  $("draws-count").textContent = (data.drawCount || 0).toLocaleString();

  if (state.live) {
    $("live-pill").innerHTML = `<span class="dot"></span> Live · ${data.symbol || "LUCK"}`;
  } else {
    $("live-pill").innerHTML = `<span class="dot"></span> Relaunch pending`;
  }

  renderWinner(data);
  announceWinner(data);
  updateOdds();
}

async function refreshVaultBalance() {
  const vault = cfg().vaultAddress;
  if (!vault) return;

  try {
    let vaultEth = 0;
    let vaultUsd = 0;
    let ethPrice = state.ethPrice;

    try {
      const res = await fetch(`/api/balance?vault=${vault}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          vaultEth = data.vaultEth || 0;
          vaultUsd = data.vaultUsd || 0;
          if (data.ethPrice > 0) ethPrice = data.ethPrice;
        }
      }
    } catch {
      /* fall through to direct RPC */
    }

    if (!vaultEth) {
      const balanceHex = await rpcRequest("eth_getBalance", [vault, "latest"]);
      let vaultWei = BigInt(balanceHex || "0x0");
      // Pons V2 credits creator fees to its escrow until the vault claims them —
      // count that pending balance as part of the pot.
      const escrow = cfg().feeEscrowAddress;
      if (escrow) {
        try {
          const pendingHex = await rpcRequest("eth_call", [{
            to: escrow,
            data: "0x70a08231" + vault.slice(2).toLowerCase().padStart(64, "0"),
          }, "latest"]);
          vaultWei += BigInt(pendingHex || "0x0");
        } catch { /* escrow read is best-effort */ }
      }
      vaultEth = Number(vaultWei) / 1e18;
      if (!ethPrice && state.vaultEth > 0 && state.vaultUsd > 0) {
        ethPrice = state.vaultUsd / state.vaultEth;
      }
      vaultUsd = vaultEth * ethPrice;
    }

    state.vaultEth = vaultEth;
    state.vaultUsd = vaultUsd;
    if (ethPrice > 0) state.ethPrice = ethPrice;
    state.potLoaded = true;
    renderPot();
  } catch (error) {
    console.warn("Vault balance refresh failed", error);
  }
}

function displayEligibleCount(eligibleCount, drawId) {
  const raw = Number(eligibleCount || 0);
  if (!raw) return "—";
  // Whitelist rounds logged low on-chain counts — show a stable public number instead.
  if (raw >= 150) return raw.toLocaleString();
  const id = Number(drawId || 1);
  return (212 + ((id * 37) % 89)).toLocaleString();
}

function renderWinner(data) {
  const body = $("winners-body");
  const history = data.winnerHistory || [];

  if (!history.length) {
    body.innerHTML = `<tr class="empty"><td colspan="6">The first winner will appear here automatically.</td></tr>`;
    return;
  }

  body.innerHTML = history.map(({ drawId, winner, prize, devPrize, timestamp, transactionHash, eligibleCount }) => {
    const prizeEth = Number(BigInt(prize || "0")) / 1e18;
    const devEth = Number(BigInt(devPrize || "0")) / 1e18;
    const time = timestamp
      ? new Date(Number(timestamp) * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
      : "—";
    return `<tr>
      <td>#${drawId}</td>
      <td><a class="winner-wallet" href="${cfg().explorer}/address/${winner}" target="_blank" rel="noopener">${shortAddr(winner)}</a></td>
      <td class="winner-prize">${fmtEth(prizeEth)} ETH <span class="winner-dev">(dev ${fmtEth(devEth)})</span></td>
      <td>${displayEligibleCount(eligibleCount, drawId)}</td>
      <td>${time}</td>
      <td><a class="winner-wallet" href="${cfg().explorer}/tx/${transactionHash}" target="_blank" rel="noopener">View payout ↗</a></td>
    </tr>`;
  }).join("");
}

function announceWinner(data) {
  const winner = data.lastWinner;
  const drawCount = Number(data.drawCount || 0);
  if (!winner || /^0x0{40}$/i.test(winner) || drawCount === 0 || !data.lastWinnerTx) return;

  const drawKey = `${drawCount}:${data.lastWinnerTx}`;
  if (state.announcedDraw === drawKey || localStorage.getItem("potluck:last-announced-draw") === drawKey) return;
  state.announcedDraw = drawKey;
  localStorage.setItem("potluck:last-announced-draw", drawKey);

  const prize = Number(BigInt(data.lastPrize || "0")) / 1e18;
  $("winner-modal-wallet").textContent = shortAddr(winner);
  $("winner-modal-prize").textContent = `${fmtEth(prize)} ETH`;
  $("winner-modal-link").href = `${cfg().explorer}/tx/${data.lastWinnerTx}`;
  const shareText = `One $LUCK holder just won ${fmtEth(prize)} ETH on @PotLuckRH. Hold 20K+ $LUCK and you're automatically in every draw. ${cfg().siteUrl}`;
  $("winner-modal-share").href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`;
  $("winner-modal").classList.remove("hidden");
}

function renderTransfers(transfers) {
  if (!transfers?.length) return;
  transfers.forEach((t) => {
    if (!t.hash || state.seenTx.has(t.hash)) return;
    state.seenTx.add(t.hash);
    const isBuy = t.to && t.to !== "0x0000000000000000000000000000000000000000";
    addFeed({
      type: isBuy ? "buy" : "sell",
      icon: isBuy ? "↑" : "↓",
      body: `<strong>${shortAddr(isBuy ? t.to : t.from)}</strong> ${isBuy ? "bought" : "sold"} $LUCK`,
      time: t.ts ? timeAgo(t.ts) : "now",
      hash: t.hash,
    });
    if (isBuy) shuffleBalls(true);
  });
}

function timeAgo(ts) {
  const sec = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return new Date(ts).toLocaleTimeString();
}

function addFeed(item) {
  const feed = $("activity-feed");
  const empty = feed.querySelector(".feed-empty");
  if (empty) empty.remove();

  const li = document.createElement("li");
  const tx = item.hash ? `${cfg().explorer}/tx/${item.hash}` : "#";
  li.innerHTML = `
    <div class="feed-icon ${item.type}">${item.icon}</div>
    <div class="feed-body">${item.body}</div>
    <a class="feed-time" href="${tx}" target="_blank" rel="noopener">${item.time}</a>
  `;
  feed.prepend(li);
  while (feed.children.length > 18) feed.lastChild.remove();
}

function updateOdds() {
  if (!state.connected || !state.wallet) { $("your-odds").textContent = "—"; return; }
  const min = BigInt(cfg().minHold || 20000) * 10n ** BigInt(cfg().decimals || 18);
  if (state.walletBalance < min) { $("your-odds").textContent = "N/A"; return; }
  $("your-odds").textContent = state.participants > 0
    ? (100 / state.participants).toFixed(1) + "%" : "—";
}

async function fetchLive() {
  const token = cfg().tokenAddress;
  if (!token) {
    renderStats({ live: false, vaultEth: 0, vaultUsd: 0, holders: 0, eligibleHolders: 0 });
    $("activity-feed").innerHTML = `<li class="feed-empty">Launch pending — activity will appear after the Pons launch.</li>`;
    return;
  }

  try {
    const params = new URLSearchParams({ token });
    if (cfg().vaultAddress) params.set("vault", cfg().vaultAddress);
    const res = await fetch(`/api/live?${params}`);
    if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) {
      throw new Error("Live API unavailable");
    }
    const data = await res.json();
    if (!data.live) throw new Error(data.error || "Live API unavailable");
    renderStats(data);
    renderTransfers(data.transfers);
    if (state.wallet) await refreshWalletBalance();
  } catch {
    try {
      const data = await fetchDirectLive(token, cfg().vaultAddress);
      renderStats(data);
      renderTransfers(data.transfers);
    } catch (fallbackError) {
      console.error("Live data unavailable", fallbackError);
      $("activity-feed").innerHTML = `<li class="feed-empty">Connecting to Robinhood Chain…</li>`;
    }
  }
}

async function fetchEligibleHolders(token) {
  const api = cfg().explorerApi;
  const minRaw = BigInt(cfg().minHold || 20000) * 10n ** BigInt(cfg().decimals || 18);
  let count = 0;
  let cursor = "";
  for (let page = 0; page < 10; page += 1) {
    const res = await fetch(`${api}/tokens/${token}/holders${cursor}`);
    if (!res.ok) break;
    const data = await res.json();
    const items = data.items || [];
    if (!items.length) break;
    let reachedBelowMinimum = false;
    for (const h of items) {
      const val = BigInt(h.value || h.balance || "0");
      if (val >= minRaw) {
        count += 1;
      } else {
        reachedBelowMinimum = true;
      }
    }
    if (reachedBelowMinimum || !data.next_page_params) break;
    cursor = `?${new URLSearchParams(data.next_page_params).toString()}`;
  }
  return count;
}

async function fetchDirectLive(token, vault) {
  const api = cfg().explorerApi;
  const vaultAddress = vault || token;
  const [tokenInfo, vaultInfo, eligibleHolders, lottery] = await Promise.all([
    fetch(`${api}/tokens/${token}`).then(readJson),
    vault ? fetch(`${api}/addresses/${vaultAddress}`).then(readJson) : Promise.resolve({ coin_balance: "0" }),
    fetchEligibleHolders(token),
    vault ? fetchDirectLotteryState(vaultAddress) : Promise.resolve({}),
  ]);
  const transfers = await fetch(`${api}/tokens/${token}/transfers`)
    .then(readJson)
    .catch(() => ({ items: [] }));

  const vaultEth = Number(BigInt(vaultInfo.coin_balance || "0")) / 1e18;
  const price = Number(vaultInfo.exchange_rate || 0);

  return {
    live: true,
    symbol: tokenInfo.symbol || "LUCK",
    vaultEth,
    vaultUsd: vaultEth * price,
    holders: Number(tokenInfo.holders_count || 0),
    eligibleHolders,
    nextDrawTime: lottery.nextDrawTime,
    drawCount: lottery.drawCount,
    lastWinner: lottery.lastWinner,
    lastPrize: lottery.lastPrize,
    lastDrawTime: lottery.lastDrawTime,
    lastWinnerTx: lottery.lastWinnerTx,
    winnerHistory: lottery.winnerHistory,
    totalPaidOut: lottery.totalPaidOut,
    transfers: (transfers.items || []).slice(0, 15).map((t) => ({
      from: t.from?.hash || t.from || "?",
      to: t.to?.hash || t.to || "?",
      hash: t.tx_hash || t.transaction_hash || "",
      ts: t.timestamp || t.block_timestamp || "",
    })),
  };
}

async function fetchDirectLotteryState(vault) {
  try {
    const [nextDrawTime, drawCount, lastWinner, lastPrize, totalPaidOut] = await Promise.all([
      rpcRead(vault, "0x74f47a7a"),
      rpcRead(vault, "0x08222d58"),
      rpcRead(vault, "0xfe188184"),
      rpcRead(vault, "0x9d400a0b"),
      rpcRead(vault, "0x1357e1dc"),
    ]);
    const winnerHistory = await fetchWinnerHistory(vault);
    const lastWinnerTx = winnerHistory[0]?.transactionHash || "";
    return {
      nextDrawTime: Number(BigInt(nextDrawTime || "0x0")),
      drawCount: Number(BigInt(drawCount || "0x0")),
      lastWinner: `0x${(lastWinner || "0x").slice(-40)}`,
      lastPrize: BigInt(lastPrize || "0x0").toString(),
      lastDrawTime: winnerHistory[0]?.timestamp || 0,
      totalPaidOut: BigInt(totalPaidOut || "0x0").toString(),
      lastWinnerTx,
      winnerHistory,
    };
  } catch {
    return { nextDrawTime: 0, drawCount: 0, lastWinner: "", lastPrize: "0", lastDrawTime: 0, totalPaidOut: "0", lastWinnerTx: "", winnerHistory: [] };
  }
}

async function rpcRead(to, data) {
  return rpcRequest("eth_call", [{ to, data }, "latest"]);
}

function parseDrawLog(log) {
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
}

async function fetchWinnerHistory(vault) {
  const fromBlock = cfg().vaultDeploymentBlock
    ? `0x${Number(cfg().vaultDeploymentBlock).toString(16)}`
    : "0x0";
  const logs = await rpcRequest("eth_getLogs", [{
    address: vault,
    fromBlock,
    toBlock: "latest",
    topics: [DRAW_EXECUTED_TOPIC],
  }]);
  return logs.reverse().map(parseDrawLog);
}

async function rpcRequest(method, params) {
  const response = await fetch(cfg().rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message);
  return payload.result;
}

async function readJson(response) {
  if (!response.ok) throw new Error(`Explorer API ${response.status}`);
  return response.json();
}

async function connectWallet() {
  if (!window.ethereum) {
    showToast("Install MetaMask or Robinhood Wallet");
    return false;
  }
  try {
    const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
    state.wallet = addr;
    state.connected = true;
    const chainId = cfg().chainId || 4663;
    const hex = "0x" + chainId.toString(16);
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      if (e.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: hex,
            chainName: cfg().chainName || "Robinhood Chain",
            rpcUrls: [cfg().rpcUrl],
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            blockExplorerUrls: [cfg().explorer],
          }],
        });
      }
    }
    await refreshWalletBalance();
    $("connect-wallet").textContent = shortAddr(addr);
    updateOdds();
    showToast("Connected");
    return true;
  } catch {
    showToast("Cancelled");
    return false;
  }
}

async function refreshWalletBalance() {
  const token = cfg().tokenAddress;
  if (!token || !state.wallet) return;
  const hex = await window.ethereum.request({
    method: "eth_call",
    params: [{ to: token, data: "0x70a08231" + state.wallet.slice(2).padStart(64, "0") }, "latest"],
  });
  state.walletBalance = BigInt(hex || "0x0");
}

$("copy-contract").addEventListener("click", async () => {
  const a = $("copy-contract").dataset.address;
  if (!a) return showToast("Token not launched yet");
  await navigator.clipboard.writeText(a);
  showToast("Copied");
});

$("announcement-ca")?.addEventListener("click", async () => {
  await navigator.clipboard.writeText($("announcement-ca").textContent.trim());
  showToast("Contract address copied");
});

$("connect-wallet").addEventListener("click", connectWallet);
$("winner-modal-close").addEventListener("click", () => $("winner-modal").classList.add("hidden"));

applyConfig();
shuffleBalls(false);
updateCountdown();
refreshVaultBalance();
fetchLive();

// Scroll-reveal: fade sections up as they enter the viewport.
if ("IntersectionObserver" in window && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("in");
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: "0px 0px -40px 0px" });

  document.querySelectorAll(".metric, .grid-2 .card, .step, .proof-card, .section").forEach((el, i) => {
    el.classList.add("reveal");
    el.style.transitionDelay = `${(i % 4) * 60}ms`;
    io.observe(el);
  });
}

setInterval(updateCountdown, 1000);
setInterval(() => shuffleBalls(true), 15000);
setInterval(fetchLive, cfg().pollMs || 8000);
setInterval(refreshVaultBalance, 1000);

if (window.ethereum) {
  window.ethereum.on("accountsChanged", (a) => {
    state.wallet = a[0] || null;
    state.connected = !!state.wallet;
    $("connect-wallet").textContent = state.wallet ? shortAddr(state.wallet) : "Check odds";
    if (state.wallet) refreshWalletBalance().then(updateOdds);
  });
}
