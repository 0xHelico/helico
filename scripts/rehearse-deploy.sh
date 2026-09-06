#!/usr/bin/env bash
# Rehearse the mainnet deployment against a local fork, end to end, through `run()`.
#
# The unit and fork tests call `Deploy.deploy(...)` directly. That is a different door from the
# one production uses, and the difference is not academic: the first version of the script was
# refused outright by Foundry for relying on `address(this)` inside a broadcast, and every test
# passed anyway because calling `deploy` externally made `address(this)` the script contract.
#
# So this is the check that matters, and it costs nothing: anvil forks Robinhood mainnet, the
# script broadcasts for real against it, and the deployed vault is read back.
#
#   ./scripts/rehearse-deploy.sh
#
# Requires a reachable Arbitrum One RPC.
set -euo pipefail

RPC="${ARBITRUM_RPC_URL:-https://arb1.arbitrum.io/rpc}"
PORT="${ANVIL_PORT:-8555}"
LOCAL="http://127.0.0.1:${PORT}"
# anvil's first well-known account. Local only, never a real key.
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
AGENT="${AGENT_ADDRESS:-0x00000000000000000000000000000000000ABCDE}"

cd "$(dirname "$0")/../contracts"

echo "forking $RPC on :$PORT"
anvil --fork-url "$RPC" --chain-id 42161 --port "$PORT" --silent &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
until cast chain-id --rpc-url "$LOCAL" >/dev/null 2>&1; do sleep 1; done

AGENT_ADDRESS="$AGENT" forge script script/Deploy.s.sol:Deploy --sig "run()" \
  --rpc-url "$LOCAL" --private-key "$KEY" --broadcast

VAULT=$(python3 -c "
import json
r=json.load(open('broadcast/Deploy.s.sol/42161/run-latest.json'))
print([t['contractAddress'] for t in r['transactions'] if t['contractName']=='ERC1967Proxy'][0])")

echo
echo "deployed vault: $VAULT"
echo "  positionManager $(cast call "$VAULT" 'positionManager()(address)' --rpc-url "$LOCAL")"
echo "  stateView       $(cast call "$VAULT" 'stateView()(address)' --rpc-url "$LOCAL")"
echo "  poolManager     $(cast call "$VAULT" 'poolManager()(address)' --rpc-url "$LOCAL")"
echo "  agent has role  $(cast call "$VAULT" 'hasRole(bytes32,address)(bool)' "$(cast keccak AGENT_ROLE)" "$AGENT" --rpc-url "$LOCAL")"
echo
echo "re-initialisable? (expect a revert)"
cast call "$VAULT" 'initialize(address,address,address,address)' "$AGENT" "$AGENT" "$AGENT" "$AGENT" \
  --rpc-url "$LOCAL" 2>&1 | tail -1
