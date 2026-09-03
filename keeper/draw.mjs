#!/usr/bin/env node
/**
 * DrawPot keeper — snapshots eligible holders and executes draws.
 * Usage: TOKEN_ADDRESS=0x... VAULT_ADDRESS=0x... PRIVATE_KEY=0x... node keeper/draw.mjs
 */

import { keccak256, encodePacked, getAddress, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";

const RPC_URL = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const EXPLORER_API = process.env.EXPLORER_API || "https://robinhoodchain.blockscout.com/api/v2";
const VAULT = (process.env.VAULT_ADDRESS || "").toLowerCase();
const TOKEN = (process.env.TOKEN_ADDRESS || "").toLowerCase();
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const MIN_HOLD = BigInt(process.env.MIN_HOLD || "20000");
const DECIMALS = BigInt(process.env.DECIMALS || "18");
const MIN_RAW = MIN_HOLD * 10n ** DECIMALS;
const EXECUTE_DRAW = "0x79826224";
const BALANCE_OF = "0x70a08231";
// Pons V2: creator fees accrue on the token's bonding curve until swept into the
// fee escrow. Pre-graduation, the creator wallet may sweep (no internal swap
// needed when buyback is disabled). Set CURVE_ADDRESS to enable; post-graduation
// the Pons operator sweeps the Uniswap V4 hook, so this becomes a no-op.
const CURVE = (process.env.CURVE_ADDRESS || "").toLowerCase();
const SWEEP_FEES = toFunctionSelector("function sweepFees(uint256)");
const CREATOR_TAX_BALANCE = toFunctionSelector("function creatorTaxBalance()");
// Optional comma-separated wallet allowlist. When set, only these wallets can
// win, and their balances are verified on-chain (spoofed indexer data ignored).
const ALLOWLIST = (process.env.ALLOWLIST || "")
  .split(",")
  .map((a) => a.trim().toLowerCase())
  .filter((a) => /^0x[a-f0-9]{40}$/.test(a));
const FEE_ESCROW = (process.env.FEE_ESCROW_ADDRESS || "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e").toLowerCase();
// System addresses that hold tokens but must never win: the bonding curve,
// the vault, the token contract, the fee escrow, and burn addresses.
const NEVER_WIN = new Set(
  [
    VAULT,
    TOKEN,
    CURVE,
    FEE_ESCROW,
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead",
  ].filter(Boolean)
);

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function rpcCall(to, data) {
  return rpc("eth_call", [{ to, data }, "latest"]);
}

function pad32(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function encodeExecuteDraw(winner, snapshotHash, eligibleCount, snapshotBlock) {
  const winnerPadded = getAddress(winner).slice(2).padStart(64, "0");
  const hashPadded = snapshotHash.replace(/^0x/, "").padStart(64, "0");
  return EXECUTE_DRAW + winnerPadded + hashPadded + pad32(eligibleCount) + pad32(snapshotBlock);
}

async function fetchAllowlistedHolders(token) {
  // Verify each allowlisted wallet's balance directly on-chain via balanceOf —
  // no indexer involved, so spoofed transfer data cannot affect eligibility.
  const checks = await Promise.all(
    ALLOWLIST.filter((addr) => !NEVER_WIN.has(addr)).map(async (addr) => {
      const data = BALANCE_OF + addr.slice(2).padStart(64, "0");
      const result = await rpcCall(token, data);
      return { addr, balance: BigInt(result || "0x0") };
    })
  );
  return checks
    .filter((c) => c.balance >= MIN_RAW)
    .map((c) => getAddress(c.addr))
    .sort((a, b) => a.localeCompare(b));
}

async function isContract(addr) {
  const code = await rpc("eth_getCode", [addr, "latest"]);
  return Boolean(code) && code !== "0x";
}

/// Drop system addresses and smart contracts (bonding curve, LP pools, routers)
/// so only real wallets can win. If a code check fails, exclude to be safe.
async function filterWinnable(addresses) {
  const named = addresses.filter((a) => !NEVER_WIN.has(a.toLowerCase()));
  const contractFlags = await Promise.all(named.map((a) => isContract(a).catch(() => true)));
  return named.filter((_, i) => !contractFlags[i]);
}

async function fetchHoldersFromExplorer(token) {
  const holders = [];
  let cursor = "";
  for (let page = 0; page < 20; page += 1) {
    const res = await fetch(`${EXPLORER_API}/tokens/${token}/holders${cursor}`);
    if (!res.ok) throw new Error(`explorer ${res.status}`);
    const data = await res.json();
    const items = data.items || [];
    if (!items.length) break;
    let reachedBelowMinimum = false;
    for (const h of items) {
      const addr = (h.address?.hash || h.address || "").toLowerCase();
      const val = BigInt(h.value || h.balance || "0");
      if (val < MIN_RAW) {
        reachedBelowMinimum = true;
      } else if (addr) {
        holders.push(getAddress(addr));
      }
    }
    if (reachedBelowMinimum || !data.next_page_params) break;
    cursor = `?${new URLSearchParams(data.next_page_params).toString()}`;
  }
  return holders;
}

// Indexer-free fallback: replay Transfer logs since launch to find candidate
// holders, then confirm each balance on-chain via balanceOf.
const TOKEN_LAUNCH_BLOCK = Number(process.env.TOKEN_LAUNCH_BLOCK || "53382236");
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function fetchHoldersFromLogs(token) {
  const latest = Number(BigInt(await rpc("eth_blockNumber", [])));
  const balances = new Map();
  const CHUNK = 10_000;
  for (let from = TOKEN_LAUNCH_BLOCK; from <= latest; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, latest);
    const logs = await rpc("eth_getLogs", [{
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
  const candidates = [...balances.entries()]
    .filter(([addr, bal]) => bal >= MIN_RAW && addr !== "0x0000000000000000000000000000000000000000")
    .map(([addr]) => addr)
    .slice(0, 500);
  // Confirm on-chain — the log replay could be stale by a block or two.
  const confirmed = [];
  for (let i = 0; i < candidates.length; i += 25) {
    const batch = candidates.slice(i, i + 25);
    const results = await Promise.all(batch.map(async (addr) => {
      const bal = await rpcCall(token, BALANCE_OF + addr.slice(2).padStart(64, "0"));
      return { addr, ok: BigInt(bal || "0x0") >= MIN_RAW };
    }));
    for (const r of results) if (r.ok) confirmed.push(getAddress(r.addr));
  }
  return confirmed;
}

async function fetchEligibleHolders(token) {
  let holders;
  try {
    holders = await fetchHoldersFromExplorer(token);
  } catch {
    // Blockscout down or behind Cloudflare — derive holders from chain logs.
    holders = await fetchHoldersFromLogs(token);
  }
  const unique = [...new Set(holders)].sort((a, b) => a.localeCompare(b));
  return filterWinnable(unique);
}

function computeSnapshotHash(addresses) {
  return keccak256(encodePacked(["address[]"], [addresses]));
}

function pickWinner(addresses, snapshotHashHex, drawCount, blockNumber) {
  const seed = keccak256(
    encodePacked(["bytes32", "uint256", "uint256"], [snapshotHashHex, BigInt(drawCount), BigInt(blockNumber)])
  );
  const index = Number(BigInt(seed) % BigInt(addresses.length));
  return addresses[index];
}

// Post-graduation: fees accrue on the shared Pons MemeHook per pool. The
// creator may sweep when no internal swap is needed (token-side fees zero);
// otherwise the Pons operator sweeps on their own schedule and this reverts
// harmlessly with InternalSwapRequiresOperator.
const MEME_HOOK = (process.env.MEME_HOOK_ADDRESS || "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044").toLowerCase();
const POOL_ID = process.env.POOL_ID || "0x5311c807a5a12ca3a854521f20170c8116199c0d3bacaf467a1efb1b3d30ce50";
const SWEEP_POOL_FEES = toFunctionSelector("function sweepPoolFees(bytes32,uint256,uint256)");
const PENDING_CREATOR_TAX = toFunctionSelector("function pendingCreatorTax(bytes32,address)");

async function sweepHookFees(client, account) {
  if (!MEME_HOOK || !POOL_ID) return null;
  try {
    const pendingHex = await rpcCall(MEME_HOOK, PENDING_CREATOR_TAX + POOL_ID.slice(2) + "0".repeat(64));
    if (BigInt(pendingHex || "0x0") === 0n) return null;
    const data = SWEEP_POOL_FEES + POOL_ID.slice(2) + "0".repeat(128);
    // Preflight: skip quietly when the sweep needs the operator's internal swap.
    await rpc("eth_estimateGas", [{ from: account.address, to: MEME_HOOK, data }]);
    const txHash = await client.sendTransaction({ to: MEME_HOOK, data, account, gas: 1_200_000n });
    for (let i = 0; i < 10; i += 1) {
      const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
      if (receipt) return { txHash, status: receipt.status };
      await new Promise((r) => setTimeout(r, 1500));
    }
    return { txHash, status: "pending" };
  } catch (error) {
    return { error: error.message };
  }
}

async function sweepCurveFees(client, account) {
  if (!CURVE) return null;
  try {
    const balHex = await rpcCall(CURVE, CREATOR_TAX_BALANCE);
    if (BigInt(balHex || "0x0") === 0n) return null;

    const txHash = await client.sendTransaction({
      to: CURVE,
      data: SWEEP_FEES + pad32(0),
      account,
      gas: 800_000n,
    });
    // Wait briefly so the swept fees are in escrow before the draw claims them.
    for (let i = 0; i < 10; i += 1) {
      const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
      if (receipt) return { txHash, status: receipt.status };
      await new Promise((r) => setTimeout(r, 1500));
    }
    return { txHash, status: "pending" };
  } catch (error) {
    // e.g. InternalSwapRequiresOperator — the Pons operator will sweep instead.
    return { error: error.message };
  }
}

export async function runDraw() {
  if (!VAULT || !TOKEN || !PRIVATE_KEY) {
    return { ok: false, error: "Missing VAULT_ADDRESS, TOKEN_ADDRESS, or PRIVATE_KEY" };
  }

  const [nextDrawHex, drawCountHex] = await Promise.all([
    rpcCall(VAULT, "0x74f47a7a"),
    rpcCall(VAULT, "0x08222d58"),
  ]);

  const nextDraw = Number(BigInt(nextDrawHex || "0x0"));
  const drawCount = Number(BigInt(drawCountHex || "0x0"));
  const now = Math.floor(Date.now() / 1000);

  if (now < nextDraw) {
    return { ok: true, skipped: true, reason: "Draw not ready", nextDraw };
  }

  const account = privateKeyToAccount(PRIVATE_KEY);
  const client = createWalletClient({
    account,
    chain: { id: 4663, name: "Robinhood Chain" },
    transport: http(RPC_URL),
  });

  // Sweep first so freshly accrued fees make it into this draw's pot.
  const sweep = await sweepCurveFees(client, account);
  const hookSweep = await sweepHookFees(client, account);

  // Skip zero-pot draws — a "0 ETH winner" helps nobody. Post-graduation the
  // payable pot is vault balance + escrow credit; hook fees needing an
  // operator conversion join the pot at the next Pons sweep instead.
  const [vaultBalHex, escrowPendingHex] = await Promise.all([
    rpc("eth_getBalance", [VAULT, "latest"]),
    rpcCall(FEE_ESCROW, BALANCE_OF + VAULT.slice(2).padStart(64, "0")),
  ]);
  const potWei = BigInt(vaultBalHex || "0x0") + BigInt(escrowPendingHex || "0x0");
  if (potWei === 0n) {
    return { ok: true, skipped: true, reason: "Pot is empty — waiting for fee sweep", nextDraw, sweep, hookSweep };
  }

  const eligible = ALLOWLIST.length
    ? await fetchAllowlistedHolders(TOKEN)
    : await fetchEligibleHolders(TOKEN);
  if (!eligible.length) {
    return { ok: false, error: "No eligible holders" };
  }

  // Robinhood Chain is an Arbitrum Orbit L2: inside contracts block.number is
  // the L1 block, so the snapshot must be stamped with l1BlockNumber. Read it
  // only after the potentially slow indexer scan has completed (100-block cap).
  const latestBlock = await rpc("eth_getBlockByNumber", ["latest", false]);
  const snapshotBlock = Number.parseInt(latestBlock.l1BlockNumber || latestBlock.number, 16);
  const hash = computeSnapshotHash(eligible);
  const winner = pickWinner(eligible, hash, drawCount + 1, snapshotBlock);
  const data = encodeExecuteDraw(winner, hash, eligible.length, snapshotBlock);

  // Avoid a slow remote gas-estimation round trip: this vault accepts holder
  // snapshots for only 100 blocks, so the preflight call can make them stale.
  const txHash = await client.sendTransaction({ to: VAULT, data, account, gas: 1_500_000n });

  return {
    ok: true,
    txHash,
    winner,
    eligibleCount: eligible.length,
    snapshotHash: hash,
    snapshotBlock,
    eligible,
    sweep,
    hookSweep,
  };
}

if (process.argv[1]?.includes("draw.mjs")) {
  runDraw()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
