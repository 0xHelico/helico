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

# The four markets `config.production.json` names, at their live addresses. The rehearsal used to
# permit Aave alone, and its comment said Aave was the only market on Arbitrum answering this
# interface — true when it was written, and untrue since `CompoundVenue` and `MorphoVenue` were
# deployed to answer it on behalf of Comet and of any ERC-4626 vault.
AAVE=0x794a61358D6845594F94dc1DB02A252b5b4814aD
COMPOUND=0x1eC57cE1DdfdC7a4EbF4F54Aedee19ab73fcBB2E
MORPHO=0xBBa798A61f0D7D1AE51466Fd4045Cd2Ea25c9A29
COMPOUND_WETH=0xb0A125F539237b553025e2cb180f9C40B25918cD

USDC=0xaf88d065e77c8cC2239327C5EDb3A432268e5831
AUSDC=0x724dc807b04555b71ed48a6896b6F41593b8C637
WETH=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
# Holds nine figures of USDC on Arbitrum; impersonated rather than minted, so the token behaves
# exactly as it does in production instead of as whatever a storage poke leaves behind.
WHALE=0x47c031236e19d024b42f8AE6780E44A573170703
FUND=50000000000 # 50,000 USDC
FUND_WETH=20000000000000000000 # 20 WETH

for tool in anvil cast forge cre jq; do
	command -v "$tool" >/dev/null || { echo "missing $tool"; exit 1; }
done
[ -f .env ] || { echo "no .env — cp .env.example .env first"; exit 1; }
# The example carries no key on purpose (#471). Staging broadcasts to the fork below, so the CLI
# needs one: anvil's first account, which `anvil` prints at startup and which holds nothing real.
grep -qE '^CRE_ETH_PRIVATE_KEY=0x[0-9a-fA-F]{64}\s*$' .env ||
	{ echo "CRE_ETH_PRIVATE_KEY is empty in .env — for a rehearsal, paste the first key anvil prints"; exit 1; }
# The workflow asks the Vault DON for ONE secret, HELICO_VAULT, holding every value as JSON —
# the DON answers one retrieval per execution. So the rehearsal has to build that item too, and
# building it is the same act as checking for it: the packer names any SECRET_* that is absent,
# which an .env predating this workflow will have plenty of. Doing both here rather than checking
# one list and packing another is deliberate — those two lists drifting is exactly the bug that
# put an Anvil key into a production upload.
python3 "$ROOT/scripts/pack-cre-vault.py" .env
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
# WETH is wrapped rather than taken from a holder: it holds its own backing, so impersonating it
# to transfer out does not work.
cast send "$WETH" 'deposit()' --value "$FUND_WETH" --rpc-url "$RPC" --private-key "$OWNER_KEY" >/dev/null
cast send "$WETH" 'transfer(address,uint256)' "$ACCOUNT" "$FUND_WETH" --rpc-url "$RPC" --private-key "$OWNER_KEY" >/dev/null

# Every market the deployed config names, because a comparison the owner never allowed is a
# comparison the enclave skips. Permitting one would prove the workflow runs and prove nothing
# about it choosing.
for venue in "$AAVE" "$COMPOUND" "$MORPHO" "$COMPOUND_WETH"; do
	cast send "$ACCOUNT" 'permitVenue(address,bool)' "$venue" true --rpc-url "$RPC" --private-key "$OWNER_KEY" >/dev/null
done
cast send "$ACCOUNT" 'setAgent(address)' "$AGENT" --rpc-url "$RPC" --private-key "$OWNER_KEY" >/dev/null
echo "idle USDC  $(cast call "$USDC" 'balanceOf(address)(uint256)' "$ACCOUNT" --rpc-url "$RPC" | awk '{print $1}')"
echo "idle WETH  $(cast call "$WETH" 'balanceOf(address)(uint256)' "$ACCOUNT" --rpc-url "$RPC" | awk '{print $1}')"
echo "working    $(cast call "$AUSDC" 'balanceOf(address)(uint256)' "$ACCOUNT" --rpc-url "$RPC" | awk '{print $1}')"
echo "agent      $(cast call "$ACCOUNT" 'agent()(address)' --rpc-url "$RPC")"
echo "permitted  4 markets, and each says what it pays:"
for venue in "$AAVE" "$COMPOUND" "$MORPHO"; do
	printf '  %s  %s bps\n' "$venue" \
		"$(cast call "$venue" 'getReserveData(address)((uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))' "$USDC" --rpc-url "$RPC" | tr -d '()' | cut -d, -f3 | awk '{printf "%d", $1/1e23}')"
done
printf '  %s  %s bps (WETH)\n' "$COMPOUND_WETH" \
	"$(cast call "$COMPOUND_WETH" 'getReserveData(address)((uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))' "$WETH" --rpc-url "$RPC" | tr -d '()' | cut -d, -f3 | awk '{printf "%d", $1/1e23}')"

say "5/7  point the workflow at what we just built"
# Copied rather than left to `git checkout` afterwards. That command reverts the whole file, so
# it would silently undo any unrelated edit in it -- which is a trap, not a cleanup.
cp workflow/config.staging.json /tmp/helico-staging-backup.$$
restore_config() { cp /tmp/helico-staging-backup.$$ workflow/config.staging.json 2>/dev/null || true; }
# The model explains the verdict; it never decides it. So the rehearsal runs *with* the model when
# this .env carries real router credentials, and without it when it does not. Someone cloning the
# repository has the placeholders from .env.example, and a rehearsal that dies on an unreachable
# endpoint would tell them nothing about the part they came to check — while dropping the model
# for everyone would leave our own longest path never exercised here.
#
# **The shape the deployed config has, not a smaller one.** This used to write a single Aave pool
# and one asset, with a comment saying Aave was the only market on Arbitrum answering this
# interface — true then, and untrue since the venues were deployed. A rehearsal that permits one
# market proves the workflow runs and proves nothing about it *choosing*, which is the thing the
# Chainlink track is about.
#
# So it writes the four markets and two assets that `config.production.json` names, including the
# per-market `assets` scope. That scope is not decoration: a `CompoundVenue` lists exactly one
# asset and **reverts** for any other, and one reverting call fails the whole batch — so an
# unscoped USDC venue in a config that also names WETH stops every run rather than earning less.
# Anything added here must also be permitted in step 4, or the enclave reads it, finds it
# disallowed, and skips it.
# Set, and not the placeholder from .env.example. Written in shell rather than reaching for
# python, because a nested heredoc inside a command substitution is how this line broke once.
ai_set() {
	local v
	v=$(grep -m1 -oE "^$1=.*" .env | cut -d= -f2- | tr -d "\"' ")
	[ -n "$v" ] && [ "$v" != "replace-me" ] && [ "$v" != "sk-replace-me" ]
}
if ai_set SECRET_AI_API_KEY && ai_set SECRET_AI_USERNAME && ai_set SECRET_AI_PASSWORD; then
	AI_READY=yes
else
	AI_READY=no
fi
if [ "$AI_READY" = yes ]; then
	echo "model on:  $(jq -r .aiModel workflow/config.staging.json), falling back to $(jq -r .aiFallbackModel workflow/config.staging.json)"
	FILTER='.account = $a | .rpcUrl = $r | .pools = $p | .assets = $s'
else
	echo "model off: .env has placeholder router credentials, so the verdict goes unexplained"
	FILTER='del(.aiUrl,.aiModel,.aiFallbackModel,.aiMaxTokens,.aiTimeoutSeconds) | .account = $a | .rpcUrl = $r | .pools = $p | .assets = $s'
fi
# Taken from the deployed config rather than retyped, so this rehearsal cannot drift away from the
# thing it exists to rehearse.
POOLS=$(jq -c '.pools' workflow/config.production.json)
ASSETS=$(jq -c '.assets' workflow/config.production.json)
jq --arg a "$ACCOUNT" --arg r "$RPC" --argjson p "$POOLS" --argjson s "$ASSETS" \
	"$FILTER" workflow/config.staging.json > /tmp/helico-idle.$$ \
	&& mv /tmp/helico-idle.$$ workflow/config.staging.json
jq -c '{account, pools, assets, agent, delivery, aiModel}' workflow/config.staging.json

# **Warm the fork before the enclave reads it.** The simulator gives an HTTP call ten seconds, and
# the first batch is now 24 `eth_call`s — one per market per asset, plus the balances — against an
# anvil that has to fetch each address's state from the upstream RPC the first time it is touched.
# Measured on this machine: three cold reads took 7.6s and the same three warm took 0.49s, so the
# batch times out on a cold fork and the failure reads like a broken workflow.
#
# Nothing about production is being papered over here — a real node answers from warm state. What
# is being removed is a fixture artefact. The ten-second ceiling is worth knowing all the same:
# it is what bounds how many markets one run can compare.
say "5b/7  warm the fork, so the ten-second batch limit is not a fixture artefact"
warm() { cast call "$1" "$2" "$3" --rpc-url "$RPC" >/dev/null 2>&1 || true; }
RESERVE='getReserveData(address)((uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))'
for venue in "$AAVE" "$COMPOUND" "$MORPHO" "$COMPOUND_WETH"; do
	for asset in "$USDC" "$WETH"; do
		# A venue reverts for an asset it does not list, which is exactly what the enclave will
		# meet and exactly why each read here is allowed to fail on its own.
		warm "$venue" 'getReserveAToken(address)(address)' "$asset"
		warm "$venue" 'getVirtualUnderlyingBalance(address)(uint128)' "$asset"
		warm "$venue" "$RESERVE" "$asset"
	done
done
echo "touched every market against both assets"

say "6/7  simulate — the enclave reads, decides and signs"
cre workflow simulate ./workflow --target staging-settings --env .env \
	--trigger-index 0 --non-interactive | tee /tmp/helico-idle-sim.$$

say "7/7  carry the signed call to the chain, as the agent"
# **Measured at the market the enclave actually chose, not at the one this script used to assume.**
# It read Aave's aToken, which was right while Aave was the only permitted market. Now the enclave
# compares three and picks the best — and on this fork it picks Morpho — so a check pinned to Aave
# reports "nothing moved" about a move that worked. The fixture was single-market, which is the
# same shape as the bug it would have hidden.
position() {
	local pool=$1 asset=$2 receipt value
	receipt=$(cast call "$pool" 'getReserveAToken(address)(address)' "$asset" --rpc-url "$RPC" | awk '{print $1}')
	if [ "$(echo "$receipt" | tr 'A-Z' 'a-z')" = "$(echo "$pool" | tr 'A-Z' 'a-z')" ]; then
		# The venue is its own receipt, so its balance is a share count and has to be converted.
		# Reading it as an amount of asset is #323 with a different caller.
		value=$(cast call "$receipt" 'balanceOf(address)(uint256)' "$ACCOUNT" --rpc-url "$RPC" | awk '{print $1}')
		cast call "$receipt" 'previewRedeem(uint256)(uint256)' "$value" --rpc-url "$RPC" | awk '{print $1}'
	else
		cast call "$receipt" 'balanceOf(address)(uint256)' "$ACCOUNT" --rpc-url "$RPC" | awk '{print $1}'
	fi
}
# The simulator prints the handler's return as a JSON string, so the statement inside it arrives
# escaped: `{\"params\":...}` rather than `{"params":...}`. Unescaped here rather than matched
# around, because the escaping is the simulator's and could change.
CALL=$(grep -oE '\{\\"params.*\}' /tmp/helico-idle-sim.$$ | tail -1 | sed 's/\\"/"/g')
[ -n "$CALL" ] || { echo "the workflow signed nothing — it decided to hold, or it failed"; exit 1; }
TO=$(echo "$CALL" | jq -r '.call.to')
DATA=$(echo "$CALL" | jq -r '.call.data')
CHOSE=$(echo "$CALL" | jq -r '.params.pool')
CHOSE_ASSET=$(echo "$CALL" | jq -r '.params.asset')
echo "to    $TO"
echo "data  ${DATA:0:74}..."
echo "chose $CHOSE  for  $CHOSE_ASSET"
BEFORE=$(position "$CHOSE" "$CHOSE_ASSET")
cast send "$TO" "$DATA" --rpc-url "$RPC" --private-key "$AGENT_KEY" >/dev/null

# A transaction that succeeds and moves nothing reads in a log exactly like one that worked, so
# the balance is the only thing worth believing.
AFTER=$(position "$CHOSE" "$CHOSE_ASSET")
echo
echo "at the chosen market  $BEFORE -> $AFTER"
echo "idle USDC             $(cast call "$USDC" 'balanceOf(address)(uint256)' "$ACCOUNT" --rpc-url "$RPC" | awk '{print $1}')"
echo "idle WETH             $(cast call "$WETH" 'balanceOf(address)(uint256)' "$ACCOUNT" --rpc-url "$RPC" | awk '{print $1}')"
echo "agent's own USDC      $(cast call "$USDC" 'balanceOf(address)(uint256)' "$AGENT" --rpc-url "$RPC" | awk '{print $1}')"
[ "$AFTER" != "$BEFORE" ] || { echo; echo "Nothing moved, whatever the transaction says."; exit 1; }

# **That it moved is not that it chose.** With one permitted market the two are the same sentence;
# with four they are not, and only the second is what the Chainlink track is about. So say which
# market won and by how much over the runner-up.
BEST_RATE=0
BEST_POOL=
for venue in "$AAVE" "$COMPOUND" "$MORPHO"; do
	r=$(cast call "$venue" "$RESERVE" "$USDC" --rpc-url "$RPC" | tr -d '()' | cut -d, -f3 | awk '{printf "%d", $1/1e23}')
	[ "$r" -gt "$BEST_RATE" ] && { BEST_RATE=$r; BEST_POOL=$venue; }
done
echo
if [ "$(echo "$CHOSE" | tr 'A-Z' 'a-z')" = "$(echo "$BEST_POOL" | tr 'A-Z' 'a-z')" ]; then
	echo "it chose the best-paying of the permitted markets: $BEST_POOL at $BEST_RATE bps"
else
	echo "it chose $CHOSE, but $BEST_POOL pays $BEST_RATE bps"
	exit 1
fi

restore_config
echo
echo "workflow/config.staging.json was rewritten for this run and has been restored from a copy."
echo "Not with git checkout, which would also revert anything else you had changed in it."
