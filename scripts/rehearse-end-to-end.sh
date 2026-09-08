#!/usr/bin/env bash
# The whole product, in one command, on a fork of Arbitrum One.
#
# Two rehearsals already existed and neither covered the join:
#
#   apps/app/e2e/fork-account.ts   opens an account through the real interface, on the real
#                                  deployed factory — but never funds it and never runs the enclave
#   apps/cre/rehearse-idle.sh      runs the enclave end to end — but deploys its own factory and
#                                  opens the account with `cast`
#
# So "an account opened through the app is one the enclave manages" had never run. That sentence is
# the demo, and #234 is the issue about it. This script is that sentence, executed.
#
# WHAT IT DOES NOT SHOW, said here rather than left to be assumed. The CRE simulator is not a TEE:
# this proves the workflow compiles for the runtime, reads the chain, decides, signs, and that the
# signed call lands and moves capital. DON authorisation and enclave attestation are shown by the
# deployed workflow's executions, not by anything here.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
PORT=8546   # matches the staging RPC in apps/cre/project.yaml, so the simulator does not warn
RPC="http://127.0.0.1:$PORT"
APP_PORT=3100
BE_PORT=8787

# anvil's first account. It only ever signs on a fork — never one of Helico's, which is the rule.
OWNER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

# What the app is hard-coded to nominate and permit. Read from the app rather than restated, so a
# change there fails this script instead of silently making it test something else.
AGENT=$(grep -oE '"0x84C3891a[0-9a-fA-F]+"' apps/app/lib/account.ts | head -1 | tr -d '"')
AAVE=$(grep -oE '"0x794a61358D[0-9a-fA-F]+"' apps/app/lib/account.ts | head -1 | tr -d '"')
USDC=0xaf88d065e77c8cC2239327C5EDb3A432268e5831
AUSDC=0x724dc807b04555b71ed48a6896b6F41593b8C637
FACTORY=$(grep -oE '"0x01CC7d9FE8[0-9a-fA-F]+"' apps/app/lib/account.ts | head -1 | tr -d '"')
# Holds nine figures of USDC on Arbitrum; impersonated rather than minted, so the token behaves as
# it does in production instead of as whatever a storage poke leaves behind.
WHALE=0x47c031236e19d024b42f8AE6780E44A573170703
FUND=${FUND:-5000000000} # 5,000 USDC

for tool in anvil cast jq bun go python3; do
	command -v "$tool" >/dev/null || { echo "missing $tool"; exit 1; }
done
command -v cre >/dev/null || command -v ~/.cre/bin/cre >/dev/null || { echo "missing cre"; exit 1; }
CRE=$(command -v cre || echo ~/.cre/bin/cre)
[ -n "$AGENT" ] && [ -n "$AAVE" ] && [ -n "$FACTORY" ] || {
	echo "could not read the agent, market or factory out of apps/app/lib/account.ts"; exit 1; }

# macOS ships bash 3.2, which has no ${VAR,,}. This does the same job everywhere.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
PIDS=()
cleanup() {
	for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
	[ -f "$CFG_BACKUP" ] && cp "$CFG_BACKUP" apps/cre/workflow/config.staging.json && rm -f "$CFG_BACKUP"
	return 0
}
CFG_BACKUP=""
trap cleanup EXIT

say "1/8  fork Arbitrum One on $PORT"
anvil --fork-url "${ARBITRUM_RPC_URL:-https://arb1.arbitrum.io/rpc}" --port "$PORT" --silent &
PIDS+=($!)
until cast block-number --rpc-url "$RPC" >/dev/null 2>&1; do sleep 0.5; done
echo "block $(cast block-number --rpc-url "$RPC")"
# The factory is the deployed one, on the fork. If this is empty the fork is not Arbitrum One.
CODE=$(cast code "$FACTORY" --rpc-url "$RPC" | wc -c | tr -d ' ')
[ "$CODE" -gt 10 ] || { echo "no factory at $FACTORY — is the fork Arbitrum One?"; exit 1; }
echo "factory $FACTORY is deployed here, with ${CODE} bytes of code"

say "2/8  the backend, and the app built against the fork"
(cd apps/be && go run ./cmd/be >/tmp/helico-be.log 2>&1) &
PIDS+=($!)
export NEXT_PUBLIC_ARBITRUM_RPC_URL="$RPC"
export NEXT_PUBLIC_BE_API_URL="http://localhost:$BE_PORT"
(cd apps/app && bun run build >/tmp/helico-app-build.log 2>&1) || {
	echo "the app failed to build:"; tail -20 /tmp/helico-app-build.log; exit 1; }
(cd apps/app && bun run start -p "$APP_PORT" >/tmp/helico-app.log 2>&1) &
PIDS+=($!)
until curl -sf "http://localhost:$APP_PORT" >/dev/null 2>&1; do sleep 1; done
echo "app on :$APP_PORT, backend on :$BE_PORT"

say "3/8  open the account through the interface, not with cast"
(cd apps/app && FORK_RPC_URL="$RPC" APP_URL="http://localhost:$APP_PORT" bun run e2e/fork-account.ts)

ACCOUNT=$(cast call "$FACTORY" 'accountFor(address)(address)' "$OWNER" --rpc-url "$RPC")
OPEN=$(cast call "$FACTORY" 'isOpen(address)(bool)' "$OWNER" --rpc-url "$RPC" 2>/dev/null || echo unknown)
ONCHAIN_AGENT=$(cast call "$ACCOUNT" 'agent()(address)' --rpc-url "$RPC")
echo "account   $ACCOUNT  (open: $OPEN)"
echo "agent     $ONCHAIN_AGENT  — nominated by pressing a button, not by this script"
[ "$(lower "$ONCHAIN_AGENT")" = "$(lower "$AGENT")" ] || { echo "the app nominated $ONCHAIN_AGENT, expected $AGENT"; exit 1; }

say "4/8  fund it with real USDC"
cast rpc anvil_impersonateAccount "$WHALE" --rpc-url "$RPC" >/dev/null
cast rpc anvil_setBalance "$WHALE" 0xde0b6b3a7640000 --rpc-url "$RPC" >/dev/null
cast send "$USDC" 'transfer(address,uint256)' "$ACCOUNT" "$FUND" --from "$WHALE" --unlocked --rpc-url "$RPC" >/dev/null
echo "idle     $(cast call "$USDC" 'balanceOf(address)(uint256)' "$ACCOUNT" --rpc-url "$RPC" | awk '{print $1}')"
echo "working  $(cast call "$AUSDC" 'balanceOf(address)(uint256)' "$ACCOUNT" --rpc-url "$RPC" | awk '{print $1}')"

say "5/8  point the enclave at the account the app opened"
CFG_BACKUP=$(mktemp)
cp apps/cre/workflow/config.staging.json "$CFG_BACKUP"
# `subgraphUrl` is cleared: Studio indexes mainnet, so on a fork it would answer `accounts: []` and
# the enclave would manage nothing. Config's own account is the union's other half, and here it is
# the whole of it. That difference is exactly what production does not have.
python3 - "$ACCOUNT" "$RPC" "$AGENT" "$AAVE" <<'PY'
import json, sys, pathlib
account, rpc, agent, pool = sys.argv[1:5]
p = pathlib.Path('apps/cre/workflow/config.staging.json')
c = json.loads(p.read_text())
c.update(account=account, rpcUrl=rpc, agent=agent, pools=[pool], subgraphUrl='')
for k in ('aiUrl','aiModel','aiFallbackModel','aiMaxTokens','aiTimeoutSeconds'):
    c.pop(k, None)
p.write_text(json.dumps(c, indent='\t') + '\n')
PY
jq -c '{account, agent, pools, asset, delivery}' apps/cre/workflow/config.staging.json

say "6/8  the enclave reads, decides and signs"
python3 scripts/pack-cre-vault.py apps/cre/.env >/dev/null
(cd apps/cre && "$CRE" workflow simulate ./workflow --target staging-settings --env .env \
	--trigger-index 0 --non-interactive | tee /tmp/helico-e2e-sim.log)

say "7/8  carry the signed call, as the agent the app nominated"
BEFORE=$(cast call "$AUSDC" 'balanceOf(address)(uint256)' "$ACCOUNT" --rpc-url "$RPC" | awk '{print $1}')
CALL=$(grep -oE '\{\\"params.*\}' /tmp/helico-e2e-sim.log | tail -1 | sed 's/\\"/"/g')
[ -n "$CALL" ] || { echo "the enclave signed nothing — it held, or it failed"; exit 1; }
TO=$(echo "$CALL" | jq -r '.call.to')
DATA=$(echo "$CALL" | jq -r '.call.data')
[ "$(lower "$TO")" = "$(lower "$ACCOUNT")" ] || { echo "the call is addressed to $TO, not to the account"; exit 1; }
# Impersonated rather than signed with a key. `supplyIdle` authorises by `msg.sender`, so what has
# to be true is that the sender is the nominated agent — and on a fork that needs no private key,
# which keeps Helico's real agent key out of this entirely.
cast rpc anvil_impersonateAccount "$AGENT" --rpc-url "$RPC" >/dev/null
cast rpc anvil_setBalance "$AGENT" 0xde0b6b3a7640000 --rpc-url "$RPC" >/dev/null
cast send "$TO" "$DATA" --from "$AGENT" --unlocked --rpc-url "$RPC" >/dev/null
echo "sent as $AGENT"

say "8/8  what actually moved"
AFTER=$(cast call "$AUSDC" 'balanceOf(address)(uint256)' "$ACCOUNT" --rpc-url "$RPC" | awk '{print $1}')
IDLE=$(cast call "$USDC" 'balanceOf(address)(uint256)' "$ACCOUNT" --rpc-url "$RPC" | awk '{print $1}')
AGENT_OWN=$(cast call "$USDC" 'balanceOf(address)(uint256)' "$AGENT" --rpc-url "$RPC" | awk '{print $1}')
echo "working  $BEFORE -> $AFTER"
echo "idle     $IDLE"
echo "the agent's own USDC $AGENT_OWN"
# A transaction that succeeds and moves nothing reads in a log exactly like one that worked.
[ "$AFTER" != "$BEFORE" ] || { echo; echo "Nothing moved, whatever the transaction says."; exit 1; }
[ "$AGENT_OWN" = "0" ] || { echo; echo "The agent kept $AGENT_OWN. It must never hold anything."; exit 1; }

echo
echo "An account opened through the app, on the deployed factory, was managed by the enclave."
