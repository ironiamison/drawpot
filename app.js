const DRAW_INTERVAL_MS = 20 * 60 * 1000;

function getNextDrawTime() {
  const now = Date.now();
  return now + (DRAW_INTERVAL_MS - (now % DRAW_INTERVAL_MS));
}

function formatCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add("hidden"), 2500);
}

function updateCountdown() {
  document.getElementById("countdown").textContent = formatCountdown(getNextDrawTime() - Date.now());
}

document.getElementById("copy-contract").addEventListener("click", async (e) => {
  const addr = e.currentTarget.dataset.address;
  if (!addr) {
    showToast("Contract not live yet — launching on Flap");
    return;
  }
  try {
    await navigator.clipboard.writeText(addr);
    showToast("Contract copied");
  } catch {
    showToast("Copy failed");
  }
});

updateCountdown();
setInterval(updateCountdown, 1000);
