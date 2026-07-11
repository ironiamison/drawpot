/* DAWPOT — real on-chain data only */

const DRAW_MS = 20 * 60 * 1000;
const RING_C = 553;
const cfg = () => window.DAWPOT_CONFIG || {};

const state = {
  live: false,
  connected: false,
  wallet: null,
  walletBalance: 0n,
  ethPrice: 0,
  vaultEth: 0,
  vaultUsd: 0,
  participants: 0,
  entries: 0,
  seenTx: new Set(),
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

function showToast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add("hidden"), 2800);
}

function applyConfig() {
  const c = cfg();
  const token = c.tokenAddress || "";
  $("copy-contract").dataset.address = token;
  const flap = c.flapUrl || "https://flap.sh";
  ["buy-link", "buy-link-draw"].forEach((id) => {
    const el = $(id);
    if (el) el.href = flap;
  });
}

function initTicker() {
  const items = [
    "DAWPOT LOTTO",
    "Robinhood Crypto Tax Token",
    "Every 20 Minutes Someone Wins",
    "Hold 20K $POT To Enter",
    "Live On Robinhood Chain",
  ];
  $("ticker-track").innerHTML = [...items, ...items].map((t) => `<span>${t}</span>`).join("");
}

function createBall(num, gold = false) {
  const el = document.createElement("div");
  el.className = `lotto-ball ${gold ? "lotto-ball--gold" : "lotto-ball--green"}`;
  el.innerHTML = gold
    ? `<span class="ball-feather">🪶</span>`
    : `<span class="ball-num">${String(num).padStart(2, "0")}</span>`;
  return el;
}

function initBalls(container) {
  container.innerHTML = "";
  [7, 23, 42, 88].forEach((n) => container.appendChild(createBall(n)));
  container.appendChild(createBall(0, true));
}

function updateCountdown() {
  const now = Date.now();
  const remaining = DRAW_MS - (now % DRAW_MS);
  const sec = Math.floor(remaining / 1000);
  $("countdown").textContent = `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  $("ring-progress").style.strokeDashoffset = RING_C * (remaining / DRAW_MS);

  const phase = $("draw-phase");
  if (sec <= 10) {
    phase.textContent = "Drawing soon…";
    phase.style.color = "#ffd700";
  } else {
    phase.textContent = state.live ? "Entries open" : "Awaiting token";
    phase.style.color = "";
  }
}

function renderStats(data) {
  state.live = data.live;
  state.ethPrice = data.ethPrice || 0;
  state.vaultEth = data.vaultEth || 0;
  state.vaultUsd = data.vaultUsd || 0;
  state.participants = data.holders || 0;
  state.entries = data.entries || data.holders || 0;

  $("prize-pool").textContent = fmtUsd(state.vaultUsd);
  $("prize-eth").textContent = fmtEth(state.vaultEth);
  $("vault-balance").textContent = "$" + fmtUsd(state.vaultUsd);
  $("fees-collected").textContent = state.live ? "On-chain" : "—";
  $("total-paid").textContent = "$0.00";
  $("participants").textContent = state.participants.toLocaleString();
  $("entries").textContent = state.entries.toLocaleString();
  $("draws-count").textContent = "0";

  const fillPct = Math.min(100, state.vaultEth > 0 ? Math.log10(state.vaultEth * 1000 + 1) * 25 : 0);
  $("vault-fill").style.width = fillPct + "%";
  $("vault-fill-pct").textContent = state.vaultEth > 0 ? fmtEth(state.vaultEth) + " ETH" : "0%";

  updateOdds();

  const badge = document.querySelector(".live-badge");
  if (badge && data.live) {
    badge.innerHTML = `<span class="live-dot"></span> Live · ${data.symbol || "POT"} · Robinhood Chain`;
  }
}

function renderTransfers(transfers) {
  if (!transfers?.length) return;

  transfers.forEach((t) => {
    if (!t.hash || state.seenTx.has(t.hash)) return;
    state.seenTx.add(t.hash);

    const isBuy = t.to && t.to !== "0x0000000000000000000000000000000000000000";
    const addr = isBuy ? t.to : t.from;
    const time = t.ts ? timeAgo(t.ts) : "now";

    addFeed({
      type: isBuy ? "buy" : "sell",
      icon: isBuy ? "↑" : "↓",
      body: `<strong>${shortAddr(addr)}</strong> ${isBuy ? "bought" : "sold"} $POT`,
      time,
      hash: t.hash,
    });
  });
}

function timeAgo(ts) {
  const d = new Date(ts);
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return d.toLocaleTimeString();
}

function addFeed(item) {
  const feed = $("activity-feed");
  const li = document.createElement("li");
  const c = cfg();
  const txLink = item.hash ? `${c.explorer}/tx/${item.hash}` : "#";
  li.innerHTML = `
    <div class="feed-icon ${item.type}">${item.icon}</div>
    <div class="feed-body">${item.body}</div>
    <a class="feed-time" href="${txLink}" target="_blank" rel="noopener">${item.time}</a>
  `;
  feed.prepend(li);
  while (feed.children.length > 20) feed.lastChild.remove();
}

function updateOdds() {
  if (!state.connected || !state.wallet) {
    $("your-odds").textContent = "—";
    return;
  }
  const minRaw = BigInt(cfg().minHold || 20000) * 10n ** BigInt(cfg().decimals || 18);
  if (state.walletBalance < minRaw) {
    $("your-odds").textContent = "N/A";
    return;
  }
  $("your-odds").textContent = state.participants > 0
    ? (100 / state.participants).toFixed(2) + "%"
    : "—";
}

async function fetchLive() {
  const c = cfg();
  const token = c.tokenAddress;
  if (!token) {
    renderStats({ live: false, vaultEth: 0, vaultUsd: 0, holders: 0, entries: 0 });
    setAwaiting();
    return;
  }

  try {
    const params = new URLSearchParams({ token });
    if (c.vaultAddress) params.set("vault", c.vaultAddress);

    const res = await fetch(`/api/live?${params}`);
    const data = await res.json();

    if (!data.live) {
      setAwaiting(data.error);
      return;
    }

    renderStats(data);
    renderTransfers(data.transfers);

    if (state.wallet) await refreshWalletBalance();
  } catch (e) {
    console.error(e);
    showToast("Failed to fetch on-chain data");
  }
}

function setAwaiting(msg) {
  const feed = $("activity-feed");
  if (!feed.children.length) {
    feed.innerHTML = `<li class="feed-empty">${msg || "Paste token contract in config.js — waiting for launch"}</li>`;
  }
}

async function connectWallet() {
  if (!window.ethereum) return showToast("Install MetaMask or Robinhood Wallet");

  try {
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    state.wallet = accounts[0];
    state.connected = true;

    const chainId = cfg().chainId || 4663;
    const hexChain = "0x" + chainId.toString(16);
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hexChain }],
      });
    } catch (e) {
      if (e.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: hexChain,
            chainName: cfg().chainName || "Robinhood Chain",
            rpcUrls: [cfg().rpcUrl],
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            blockExplorerUrls: [cfg().explorer],
          }],
        });
      }
    }

    await refreshWalletBalance();
    $("connect-wallet").textContent = shortAddr(state.wallet);
    updateOdds();
    showToast("Wallet connected");
  } catch {
    showToast("Connection cancelled");
  }
}

async function refreshWalletBalance() {
  const token = cfg().tokenAddress;
  if (!token || !state.wallet) return;

  const balHex = await window.ethereum.request({
    method: "eth_call",
    params: [{
      to: token,
      data: "0x70a08231" + state.wallet.slice(2).padStart(64, "0"),
    }, "latest"],
  });
  state.walletBalance = BigInt(balHex || "0x0");
}

function initParticles() {
  const canvas = $("particles");
  const ctx = canvas.getContext("2d");
  let w, h, parts;

  function resize() {
    w = canvas.width = innerWidth;
    h = canvas.height = innerHeight;
    parts = Array.from({ length: 40 }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      s: Math.random() * 3 + 1,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      gold: Math.random() > 0.7,
      a: Math.random() * 0.25 + 0.08,
    }));
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    parts.forEach((p) => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = w; if (p.x > w) p.x = 0;
      if (p.y < 0) p.y = h; if (p.y > h) p.y = 0;
      ctx.globalAlpha = p.a;
      ctx.fillStyle = p.gold ? "#ffd700" : "#00c805";
      ctx.fillRect(p.x, p.y, p.s, p.s);
    });
    requestAnimationFrame(draw);
  }

  resize();
  addEventListener("resize", resize);
  draw();
}

$("copy-contract").addEventListener("click", async (e) => {
  const addr = e.currentTarget.dataset.address;
  if (!addr) return showToast("Set tokenAddress in config.js first");
  try {
    await navigator.clipboard.writeText(addr);
    showToast("Contract copied");
  } catch {
    showToast("Copy failed");
  }
});

$("connect-wallet").addEventListener("click", connectWallet);

$("check-eligibility").addEventListener("click", async () => {
  if (!state.connected) return showToast("Connect wallet first");
  const minRaw = BigInt(cfg().minHold || 20000) * 10n ** BigInt(cfg().decimals || 18);
  if (state.walletBalance >= minRaw) {
    showToast(`Eligible — ${fmtHuman(state.walletBalance)} $POT`);
  } else {
    showToast(`Need ${cfg().minHold?.toLocaleString()}+ $POT`);
  }
});

function fmtHuman(raw) {
  const d = cfg().decimals || 18;
  const n = Number(raw) / 10 ** d;
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

applyConfig();
initTicker();
initBalls($("lotto-balls"));
initParticles();
updateCountdown();
fetchLive();

setInterval(updateCountdown, 1000);
setInterval(fetchLive, cfg().pollMs || 15000);

if (window.ethereum) {
  window.ethereum.on("accountsChanged", (a) => {
    state.wallet = a[0] || null;
    state.connected = !!state.wallet;
    $("connect-wallet").textContent = state.wallet ? shortAddr(state.wallet) : "Connect";
    if (state.wallet) refreshWalletBalance().then(updateOdds);
  });
}
