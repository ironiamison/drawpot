/* Hood Lotto — live interactive layer */

const DRAW_MS = 20 * 60 * 1000;
const RING_C = 553;
const ETH_USD = 3400;

const state = {
  prizeUsd: 0,
  prizeEth: 0,
  vaultUsd: 0,
  feesUsd: 0,
  paidUsd: 0,
  participants: 0,
  entries: 0,
  draws: 0,
  connected: false,
  drawing: false,
  lastDrawAt: 0,
};

const ACTIVITY_TYPES = [
  { type: "buy", icon: "↑", tpl: (a) => `<strong>${a}</strong> bought $POT` },
  { type: "sell", icon: "↓", tpl: (a) => `<strong>${a}</strong> sold $POT` },
  { type: "vault", icon: "$", tpl: (v) => `Vault <strong>+${v} ETH</strong> from tax` },
  { type: "entry", icon: "✓", tpl: (a) => `<strong>${a}</strong> entered the draw` },
];

const TICKER_ITEMS = [
  "Hood Lotto — The Robinhood Lottery",
  "Every 20 Minutes Someone Wins",
  "Hold 20K $POT To Enter",
  "5% Tax → 100% Vault",
  "Live On Robinhood Chain",
  "Launch Via Flap",
];

// ── Utils ──

function $(id) { return document.getElementById(id); }

function randAddr() {
  const h = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `0x${h()}…${h().slice(0, 3)}`;
}

function fmtUsd(n) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtEth(n) {
  return n.toFixed(4);
}

function nextDrawMs() {
  const now = Date.now();
  return DRAW_MS - (now % DRAW_MS);
}

function showToast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add("hidden"), 2800);
}

function animateValue(el, from, to, duration, fmt) {
  const start = performance.now();
  function frame(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ── Ticker ──

function initTicker() {
  const track = $("ticker-track");
  const items = [...TICKER_ITEMS, ...TICKER_ITEMS];
  track.innerHTML = items.map((t) => `<span>${t}</span>`).join("");
}

// ── Lotto balls ──

function initBalls(container, count = 6) {
  container.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const b = document.createElement("div");
    b.className = "ball" + (i === count - 1 ? " green" : "");
    b.textContent = String(Math.floor(Math.random() * 90) + 10);
    container.appendChild(b);
  }
}

function shuffleBalls(container) {
  container.querySelectorAll(".ball").forEach((b) => {
    b.classList.add("spin");
    b.textContent = String(Math.floor(Math.random() * 90) + 10);
    setTimeout(() => b.classList.remove("spin"), 400);
  });
}

// ── Countdown ring ──

function updateCountdown() {
  const remaining = nextDrawMs();
  const totalSec = Math.floor(remaining / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  $("countdown").textContent = `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;

  const pct = 1 - remaining / DRAW_MS;
  $("ring-progress").style.strokeDashoffset = RING_C * (1 - pct);

  const phase = $("draw-phase");
  if (totalSec <= 10 && totalSec > 0) {
    phase.textContent = "Drawing soon…";
    phase.style.color = "#ff5000";
  } else if (state.drawing) {
    phase.textContent = "Selecting winner…";
  } else {
    phase.textContent = "Entries open";
    phase.style.color = "";
  }

  const drawSlot = Math.floor(Date.now() / DRAW_MS);
  if (totalSec <= 1 && !state.drawing && state.lastDrawAt !== drawSlot) {
    state.lastDrawAt = drawSlot;
    triggerDraw();
  }
}

// ── Live stats (demo until contract wired) ──

function tickStats() {
  const taxBump = (Math.random() * 0.0008 + 0.0002) * ETH_USD;
  state.prizeUsd += taxBump * 0.6;
  state.prizeEth = state.prizeUsd / ETH_USD;
  state.vaultUsd = state.prizeUsd;
  state.feesUsd += taxBump * 0.4;

  if (Math.random() > 0.7) {
    state.participants += 1;
    state.entries += Math.floor(Math.random() * 3) + 1;
  }

  $("prize-pool").textContent = fmtUsd(state.prizeUsd);
  $("prize-eth").textContent = fmtEth(state.prizeEth);
  $("vault-balance").textContent = "$" + fmtUsd(state.vaultUsd);
  $("fees-collected").textContent = "$" + fmtUsd(state.feesUsd);
  $("total-paid").textContent = "$" + fmtUsd(state.paidUsd);
  $("participants").textContent = state.participants.toLocaleString();
  $("entries").textContent = state.entries.toLocaleString();
  $("draws-count").textContent = state.draws;

  const fillPct = Math.min(95, (state.prizeUsd / 5000) * 100);
  $("vault-fill").style.width = fillPct + "%";
  $("vault-fill-pct").textContent = Math.round(fillPct) + "%";

  updateOdds();
}

function updateOdds() {
  const odds = state.participants > 0 ? (100 / state.participants).toFixed(2) + "%" : "—";
  $("your-odds").textContent = state.connected ? odds : "Connect";
}

// ── Activity feed ──

function addActivity(item) {
  const feed = $("activity-feed");
  const li = document.createElement("li");
  li.className = "activity-item";
  li.innerHTML = `
    <div class="activity-icon ${item.type}">${item.icon}</div>
    <div class="activity-body">${item.body}</div>
    <span class="activity-time">now</span>
  `;
  feed.prepend(li);
  while (feed.children.length > 12) feed.lastChild.remove();

  feed.querySelectorAll(".activity-time").forEach((t, i) => {
    if (i === 0) t.textContent = "now";
    else if (i < 4) t.textContent = `${i}s`;
    else t.textContent = `${i * 3}s`;
  });
}

function randomActivity() {
  const t = ACTIVITY_TYPES[Math.floor(Math.random() * ACTIVITY_TYPES.length)];
  let body;
  if (t.type === "vault") {
    const v = (Math.random() * 0.05 + 0.01).toFixed(3);
    body = t.tpl(v);
  } else {
    body = t.tpl(randAddr());
  }
  addActivity({ type: t.type, icon: t.icon, body });
}

function seedActivity() {
  for (let i = 0; i < 5; i++) randomActivity();
}

// ── Draw animation ──

function triggerDraw() {
  state.drawing = true;
  const flash = $("draw-flash");
  const flashBalls = $("flash-balls");
  flash.classList.remove("hidden");
  initBalls(flashBalls, 5);

  const winner = randAddr();
  const prize = state.prizeUsd;

  let spins = 0;
  const spinInterval = setInterval(() => {
    flashBalls.querySelectorAll(".ball").forEach((b) => {
      b.textContent = String(Math.floor(Math.random() * 90) + 10);
    });
    spins++;
    if (spins > 8) clearInterval(spinInterval);
  }, 120);

  setTimeout(() => {
    $("flash-winner").textContent = winner;
    clearInterval(spinInterval);
  }, 1500);

  setTimeout(() => {
    flash.classList.add("hidden");
    state.drawing = false;

    if (prize > 0) {
      state.paidUsd += prize;
      state.draws += 1;
      state.prizeUsd = 0;
      state.prizeEth = 0;
      state.vaultUsd = 0;
      addWinner(winner, prize);
      addActivity({
        type: "vault",
        icon: "★",
        body: `<strong>${winner}</strong> won <strong>$${fmtUsd(prize)}</strong>`,
      });
      showToast(`Winner: ${winner}`);
    }

    shuffleBalls($("lotto-balls"));
    tickStats();
  }, 3500);
}

function addWinner(wallet, prize) {
  const tbody = $("winners-body");
  const empty = tbody.querySelector(".empty-row");
  if (empty) empty.remove();

  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${state.draws}</td>
    <td class="winner-wallet">${wallet}</td>
    <td class="winner-prize">$${fmtUsd(prize)}</td>
    <td>Just now</td>
    <td class="winner-tx">View →</td>
  `;
  tbody.prepend(tr);
}

// ── Particles ──

function initParticles() {
  const canvas = $("particles");
  const ctx = canvas.getContext("2d");
  let w, h, dots;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
    dots = Array.from({ length: 40 }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.5 + 0.5,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      a: Math.random() * 0.3 + 0.1,
    }));
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    dots.forEach((d) => {
      d.x += d.vx;
      d.y += d.vy;
      if (d.x < 0) d.x = w;
      if (d.x > w) d.x = 0;
      if (d.y < 0) d.y = h;
      if (d.y > h) d.y = 0;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,200,5,${d.a})`;
      ctx.fill();
    });
    requestAnimationFrame(draw);
  }

  resize();
  window.addEventListener("resize", resize);
  draw();
}

// ── Events ──

$("copy-contract").addEventListener("click", async (e) => {
  const addr = e.currentTarget.dataset.address;
  if (!addr) return showToast("Contract not live yet — launch on Flap");
  try {
    await navigator.clipboard.writeText(addr);
    showToast("Contract copied");
  } catch {
    showToast("Copy failed");
  }
});

$("connect-wallet").addEventListener("click", () => {
  state.connected = true;
  showToast("Wallet connected (demo)");
  updateOdds();
});

$("check-eligibility").addEventListener("click", () => {
  if (!state.connected) return showToast("Connect wallet first");
  showToast("Need 20,000+ $POT to enter draws");
});

// ── Boot ──

initTicker();
initBalls($("lotto-balls"));
initParticles();
seedActivity();

state.prizeUsd = 127.43;
state.prizeEth = state.prizeUsd / ETH_USD;
state.vaultUsd = state.prizeUsd;
state.feesUsd = 89.2;
state.participants = 47;
state.entries = 312;
tickStats();

setInterval(updateCountdown, 1000);
setInterval(tickStats, 4000);
setInterval(randomActivity, 3500);
setInterval(() => shuffleBalls($("lotto-balls")), 8000);

updateCountdown();
