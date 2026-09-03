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

async function fetchEligibleHolders(token) {
  const holders = [];
  let cursor = "";
  for (let page = 0; page < 20; page += 1) {
    const res = await fetch(`${EXPLORER_API}/tokens/${token}/holders${cursor}`);
    if (!res.ok) break;
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

  const sweep = await sweepCurveFees(client, account);

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
