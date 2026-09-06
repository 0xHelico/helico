#!/usr/bin/env bash
# Runs the whole thing end to end on a local fork of Arbitrum One: deploys the vault, gives it
# a position that has drifted out of range, and lets the CRE workflow decide and deliver.
#
# This exists because "we ran it and it worked" is not evidence. A judge should be able to
# clone the repository and get the same numbers, which is what issue #21 asks for.
#
# What it does NOT show, and the README says so too: the simulator is not a TEE, and the mock
# forwarder verifies no DON signatures. This proves the delivery path and the vault's
# execution. It does not prove DON authorisation.
set -euo pipefail

cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)

RPC=${RPC:-http://127.0.0.1:8546}
PORT=${PORT:-8546}
FORK_URL=${ARBITRUM_RPC_URL:-https://arb1.arbitrum.io/rpc}

# anvil's first two accounts. Public knowledge, and they hold nothing on any real chain.
OWNER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
OWNER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
AGENT=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

# The forwarder the CRE CLI broadcasts through when simulating. It verifies nothing, which is
# the whole caveat on this rehearsal.
MOCK_FORWARDER=0xd770499057619c9a76205fd4168161cf94abc532
ARB=0x912CE59144191C1204E64559FE8253a0e49E6548
ARB_BALANCE_SLOT=51
EXPIRY=1791244800

for tool in anvil cast forge cre jq; do
	command -v "$tool" >/dev/null || { echo "missing: $tool"; exit 1; }
done
[ -f .env ] || { echo "copy .env.example to .env first"; exit 1; }

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

say "1/6  fork Arbitrum One on :$PORT"
anvil --fork-url "$FORK_URL" --port "$PORT" --silent &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
until cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; do sleep 1; done
[ "$(cast chain-id --rpc-url "$RPC")" = 42161 ] || { echo "not Arbitrum One"; exit 1; }
echo "forked at block $(cast block-number --rpc-url "$RPC")"

say "2/6  deploy the vault, pointed at the mock forwarder"
VAULT=$(cd "$ROOT/contracts" && AGENT_ADDRESS=$AGENT FORWARDER_ADDRESS=$MOCK_FORWARDER \
	forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast --private-key "$OWNER_KEY" \
	2>&1 | awk '/vault \(proxy\)/ {print $NF}')
[ -n "$VAULT" ] || { echo "deploy produced no address"; exit 1; }
echo "vault    $VAULT"
echo "forwarder $(cast call "$VAULT" 'forwarder()(address)' --rpc-url "$RPC")"

say "3/6  fund the owner on the fork"
cast rpc anvil_setBalance "$OWNER" 0x21e19e0c9bab2400000 --rpc-url "$RPC" >/dev/null
# ARB is a proxy; its balances live in slot 51 of the implementation's layout.
SLOT=$(cast index address "$OWNER" $ARB_BALANCE_SLOT)
cast rpc anvil_setStorageAt "$ARB" "$SLOT" \
	"$(cast to-uint256 1000000000000000000000)" --rpc-url "$RPC" >/dev/null
echo "ARB      $(cast call $ARB 'balanceOf(address)(uint256)' "$OWNER" --rpc-url "$RPC")"

say "4/6  mint a position that is out of range, and commit the mandate"
OUT=$(cd "$ROOT/contracts" && VAULT=$VAULT EXPIRY=$EXPIRY \
	forge script script/Rehearse.s.sol:Rehearse --rpc-url "$RPC" --broadcast --private-key "$OWNER_KEY" 2>&1)
echo "$OUT" | grep -E 'tick now|token id|range|liquidity|0x[0-9a-f]{64}' || true
HASH=$(echo "$OUT" | grep -oE '0x[0-9a-f]{64}' | tail -1)
[ -n "$HASH" ] || { echo "no mandate hash in the output"; exit 1; }

say "5/6  point the workflow at what was just deployed"
jq --tab --arg v "$VAULT" --arg h "$HASH" --arg o "$OWNER" \
	'.vault=$v | .mandateHash=$h | .owner=$o' workflow/config.staging.json > /tmp/helico-config.$$ \
	&& mv /tmp/helico-config.$$ workflow/config.staging.json
jq -c '{vault, mandateHash, owner, delivery}' workflow/config.staging.json

say "6/6  simulate the workflow, broadcasting through the forwarder"
cre workflow simulate ./workflow --target staging-settings --env .env \
	--trigger-index 0 --non-interactive --broadcast | tee /tmp/helico-sim.$$

say "what the fork says now"
# The workflow prints a transaction hash whether or not the transaction succeeded, so the
# hash on its own is not evidence. Check the receipt, and if it reverted, say why.
TX=$(grep -oE '0x[0-9a-f]{64}' /tmp/helico-sim.$$ | tail -1 || true)
if [ -n "${TX:-}" ]; then
	STATUS=$(cast receipt "$TX" status --rpc-url "$RPC" 2>/dev/null || echo "?")
	echo "tx         $TX  status=$STATUS"
	if [ "$STATUS" != "1" ]; then
		echo
		echo "The re-centre did not land. What the vault said:"
		cast run --rpc-url "$RPC" "$TX" 2>&1 | tail -20
		exit 1
	fi
fi
NEW=$(cast call "$VAULT" 'positionOf(address)(uint256)' "$OWNER" --rpc-url "$RPC" | awk '{print $1}')
echo "position   $NEW"
echo "owner      $(cast call 0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869 'ownerOf(uint256)(address)' "$NEW" --rpc-url "$RPC")"
echo "liquidity  $(cast call 0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869 'getPositionLiquidity(uint256)(uint128)' "$NEW" --rpc-url "$RPC")"
echo "vault ETH  $(cast balance "$VAULT" --rpc-url "$RPC")"
echo "vault ARB  $(cast call $ARB 'balanceOf(address)(uint256)' "$VAULT" --rpc-url "$RPC")"

say "again, to show the cooldown refuse it"
cre workflow simulate ./workflow --target staging-settings --env .env \
	--trigger-index 0 --non-interactive --broadcast

echo
echo "workflow/config.staging.json was rewritten with the vault this run deployed."
echo "git checkout apps/cre/workflow/config.staging.json to restore it."
