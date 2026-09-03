#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${PRIVATE_KEY:-}" || -z "${KEEPER_ADDRESS:-}" || -z "${DEV_WALLET:-}" ]]; then
  echo "Missing env. Create contracts/.env (or export) with:"
  echo "  PRIVATE_KEY=0x...      # deployer (also calls setToken after launch)"
  echo "  KEEPER_ADDRESS=0x...   # draw executor wallet"
  echo "  DEV_WALLET=0x...       # receives 20% of each pot"
  exit 1
fi

RPC="${RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
CHAIN="${CHAIN_ID:-4663}"

echo "Building..."
forge build --root .

echo "Simulating..."
forge script script/DeployDrawPotPonsVault.s.sol:DeployDrawPotPonsVault \
  --root . \
  --rpc-url "$RPC" \
  --chain-id "$CHAIN"

echo "Broadcasting..."
forge script script/DeployDrawPotPonsVault.s.sol:DeployDrawPotPonsVault \
  --root . \
  --rpc-url "$RPC" \
  --chain-id "$CHAIN" \
  --broadcast

echo "Done. Save the DrawPotPonsVault address above — it is the creatorFeeRecipient for the Pons launch."
