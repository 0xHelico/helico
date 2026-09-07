#!/usr/bin/env bash
# Runs the idle-capital workflow end to end on a local fork of Arbitrum One: deploys the account
# factory, opens an owner an account, funds it with real USDC taken from a whale on the fork,
# lets the enclave decide, and carries the statement it signs to the chain.
#
# This exists because "we ran it and it worked" is not evidence. A judge should be able to clone
# the repository and get the same numbers.
#
# What it does NOT show, said here rather than left to be assumed: the simulator is not a TEE.
# It proves the workflow compiles for the CRE runtime, reads the chain, decides, signs, and that
# the signed call lands and moves capital. It does not prove DON authorisation or attestation.
set -euo pipefail

cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
PORT=8546
RPC="http://127.0.0.1:$PORT"

# anvil's first two accounts. Public knowledge, and they hold nothing on any real chain.
OWNER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
OWNER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
AGENT=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
AGENT_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d

AAVE=0x794a61358D6845594F94dc1DB02A252b5b4814aD
USDC=0xaf88d065e77c8cC2239327C5EDb3A432268e5831
AUSDC=0x724dc807b04555b71ed48a6896b6F41593b8C637
# Holds nine figures of USDC on Arbitrum; impersonated rather than minted, so the token behaves
# exactly as it does in production instead of as whatever a storage poke leaves behind.
WHALE=0x47c031236e19d024b42f8AE6780E44A573170703
FUND=50000000000 # 50,000 USDC

for tool in anvil cast forge cre jq; do
	command -v "$tool" >/dev/null || { echo "missing $tool"; exit 1; }
done
[ -f .env ] || { echo "no .env — cp .env.example .env first"; exit 1; }
# An .env from before this workflow existed has the vault's MANDATE_* names and none of these,
# and the CLI's complaint about it names one variable at a time. Checked here so the answer is
# the whole list at once.
MISSING=$(comm -23 \
	<(grep -oE '^SECRET_IDLE_[A-Z_]+|^SECRET_AGENT_KEY' .env.example | sort -u) \
	<(grep -oE '^SECRET_IDLE_[A-Z_]+|^SECRET_AGENT_KEY' .env | sort -u))
[ -z "$MISSING" ] || { echo "your .env predates this workflow. Missing:"; echo "$MISSING"; exit 1; }
FORK_URL=${ARBITRUM_RPC_URL:-https://arb1.arbitrum.io/rpc}

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
cleanup() {
	[ -n "${ANVIL_PID:-}" ] && kill "$ANVIL_PID" 2>/dev/null || true
	type restore_config >/dev/null 2>&1 && restore_config
}
trap cleanup EXIT

say "1/7  fork Arbitrum One on $PORT"
anvil --fork-url "$FORK_URL" --port "$PORT" --silent &
ANVIL_PID=$!
until cast block-number --rpc-url "$RPC" >/dev/null 2>&1; do sleep 0.5; done
echo "block $(cast block-number --rpc-url "$RPC")"

say "2/7  deploy the account factory"
DEPLOY=$(cd "$ROOT/contracts" && forge script script/DeployAccountFactory.s.sol:DeployAccountFactory \
	--rpc-url "$RPC" --broadcast --private-key "$OWNER_KEY" 2>&1)
FACTORY=$(echo "$DEPLOY" | grep -oE 'account factory +0x[0-9a-fA-F]{40}' | grep -oE '0x[0-9a-fA-F]{40}')
[ -n "$FACTORY" ] || { echo "$DEPLOY" | tail -20; exit 1; }
echo "factory $FACTORY"

say "3/7  open the owner an account"
# The address is known before anything is deployed, which is the point of a CREATE2 factory.
PREDICTED=$(cast call "$FACTORY" 'accountFor(address)(address)' "$OWNER" --rpc-url "$RPC")
cast send "$FACTORY" 'open(address)' "$OWNER" --rpc-url "$RPC" --private-key "$OWNER_KEY" >/dev/null
ACCOUNT=$(cast call "$FACTORY" 'accountFor(address)(address)' "$OWNER" --rpc-url "$RPC")
[ "$PREDICTED" = "$ACCOUNT" ] || { echo "predicted $PREDICTED but got $ACCOUNT"; exit 1; }
echo "account $ACCOUNT (predicted before it existed)"

say "4/7  fund it with real USDC, and let the owner set its rules"
cast rpc anvil_impersonateAccount "$WHALE" --rpc-url "$RPC" >/dev/null
cast rpc anvil_setBalance "$WHALE" 0xde0b6b3a7640000 --rpc-url "$RPC" >/dev/null
cast send "$USDC" 'transfer(address,uint256)' "$ACCOUNT" "$FUND" --from "$WHALE" --unlocked --rpc-url "$RPC" >/dev/null
cast send "$ACCOUNT" 'permitVenue(address,bool)' "$AAVE" true --rpc-url "$RPC" --private-key "$OWNER_KEY" >/dev/null
cast send "$ACCOUNT" 'setAgent(address)' "$AGENT" --rpc-url "$RPC" --private-key "$OWNER_KEY" >/dev/null
echo "idle     $(cast call "$USDC" 'balanceOf(address)(uint256)' "$ACCOUNT" --rpc-url "$RPC" | awk '{print $1}')"
echo "working  $(cast call "$AUSDC" 'balanceOf(address)(uint256)' "$ACCOUNT" --rpc-url "$RPC" | awk '{print $1}')"
echo "agent    $(cast call "$ACCOUNT" 'agent()(address)' --rpc-url "$RPC")"

say "5/7  point the workflow at what we just built"
# Copied rather than left to `git checkout` afterwards. That command reverts the whole file, so
# it would silently undo any unrelated edit in it -- which is a trap, not a cleanup.
cp workflow/config.staging.json /tmp/helico-staging-backup.$$
restore_config() { cp /tmp/helico-staging-backup.$$ workflow/config.staging.json 2>/dev/null || true; }
# `aiUrl` is dropped: the rehearsal must not depend on a model endpoint being reachable, and the
# model explains the verdict rather than deciding it.
#
# `pools` is a list, and the one this rehearsal uses has a single entry. That is not the whole of
# what the workflow can do — it compares the rate at every permitted market and picks the best —
# but Aave v3 is the only market on Arbitrum answering this interface for USDC that we found:
# Radiant, the obvious second, is an Aave *v2* fork and reverts on `getReserveAToken(USDC)`.
# Choosing between several is covered by the unit tests, not by this script. Anything added to
# `pools` here must also be permitted with `permitVenue` in step 4, or the enclave will read it,
# find it disallowed, and skip it.
jq --arg a "$ACCOUNT" --arg r "$RPC" 'del(.aiUrl,.aiModel,.aiFallbackModel,.aiMaxTokens,.aiTimeoutSeconds)
	| .account = $a | .rpcUrl = $r' workflow/config.staging.json > /tmp/helico-idle.$$ \
	&& mv /tmp/helico-idle.$$ workflow/config.staging.json
jq -c '{account, pools, asset, agent, delivery}' workflow/config.staging.json

say "6/7  simulate — the enclave reads, decides and signs"
cre workflow simulate ./workflow --target staging-settings --env .env \
	--trigger-index 0 --non-interactive | tee /tmp/helico-idle-sim.$$

say "7/7  carry the signed call to the chain, as the agent"
BEFORE=$(cast call "$AUSDC" 'balanceOf(address)(uint256)' "$ACCOUNT" --rpc-url "$RPC" | awk '{print $1}')
# The simulator prints the handler's return as a JSON string, so the statement inside it arrives
# escaped: `{\"params\":...}` rather than `{"params":...}`. Unescaped here rather than matched
# around, because the escaping is the simulator's and could change.
CALL=$(grep -oE '\{\\"params.*\}' /tmp/helico-idle-sim.$$ | tail -1 | sed 's/\\"/"/g')
[ -n "$CALL" ] || { echo "the workflow signed nothing — it decided to hold, or it failed"; exit 1; }
TO=$(echo "$CALL" | jq -r '.call.to')
DATA=$(echo "$CALL" | jq -r '.call.data')
echo "to   $TO"
echo "data ${DATA:0:74}..."
cast send "$TO" "$DATA" --rpc-url "$RPC" --private-key "$AGENT_KEY" >/dev/null

# A transaction that succeeds and moves nothing reads in a log exactly like one that worked, so
# the balance is the only thing worth believing.
AFTER=$(cast call "$AUSDC" 'balanceOf(address)(uint256)' "$ACCOUNT" --rpc-url "$RPC" | awk '{print $1}')
echo
echo "working  $BEFORE -> $AFTER"
echo "idle     $(cast call "$USDC" 'balanceOf(address)(uint256)' "$ACCOUNT" --rpc-url "$RPC" | awk '{print $1}')"
echo "agent's own USDC $(cast call "$USDC" 'balanceOf(address)(uint256)' "$AGENT" --rpc-url "$RPC" | awk '{print $1}')"
[ "$AFTER" != "$BEFORE" ] || { echo; echo "Nothing moved, whatever the transaction says."; exit 1; }

restore_config
echo
echo "workflow/config.staging.json was rewritten for this run and has been restored from a copy."
echo "Not with git checkout, which would also revert anything else you had changed in it."
