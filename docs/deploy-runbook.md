# Deploy runbook

Written before the deploy rather than during it, because the questions below are the kind that
stop a deploy halfway and are cheapest to answer while nothing is at stake.

Order used to matter for one reason — *CRE has nothing to read until an account exists* — and it
no longer does. The subgraph indexes `HelicoAccountFactory`, so the workflow discovers every
account that has ever been opened and manages all of them. The workflow can be deployed before a
single account exists; it will hold, say so, and start managing accounts the moment they appear.

What that changes here: **step 2 is no longer a precondition for step 4.** It is still worth doing
first, because an empty run proves less than a run with something in it.

## Four keys, four roles, split by blast radius

All in the source-of-truth `.env`, which is gitignored and untracked. Read as text, never sourced,
and passed to `cast` as `--private-key "$(…)"` at the moment of use — no keystore, no password.

| Role | Address | Holds | If this key leaks |
|---|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | `0x6DCd7485aB17e0CBD0723b8435a35bb8d029439E` | 0.0079 | Deploys contracts and spends its gas. Nearly idle once the deploy is done |
| `AGENT_PRIVATE_KEY` | `0x84C3891a9693c891877aC474a90d17d29075fcAf` | 0.0100 | Moves capital between the account and permitted markets. **Cannot take it** — neither call has a recipient parameter |
| `RELAYER_PRIVATE_KEY` | `0x96575074e509DAB29D56D83060c2438730aC582E` | 0.0050 | Opens accounts, which grants nothing, and carries calls the owner already signed. Almost no damage |
| `UPGRADE_PRIVATE_KEY` | `0xaeE1F9d2c23730CA04Dd478830c2acc495536E9C` | 0.0020 | **Replaces an account's code, immediately.** The largest power in the system |

**None of the four is ever used for testing.** Ghoza's rule, 8 September, and it is narrower
than it sounds: not "be careful with them", but *do not reach for them at all* when something
needs a wallet. A fork run uses anvil's well-known accounts; a browser check generates a key and
throws it away; a script that wants a signer makes one. The four above exist to hold mainnet
authority, and every use that is not that widens their exposure for nothing.

The reason to write it down rather than assume it: a test that needs "a funded wallet on
Arbitrum" is exactly the moment a real key looks convenient, and the agent key is funded.

The split is by exposure against power. The relayer is the most exposed key — it lives in the
backend and is touched on every user request — and it is deliberately the one that can do least.
The upgrader can do the most and should be touched least; it holds a small balance only so an
emergency fix is not blocked on funding one.

**The agent and the upgrader were one key until this split.** That combination meant the key that
moves money could also rewrite the limit that stops it moving money anywhere else — and since the
upgrade delay was removed for the hackathon, immediately. Separating them costs one wallet.

Funded from the deployer: `0xa9282b81…` (agent), `0x77a6b0e6…` (relayer), `0x172eebbe…` (upgrader).

### Why the agent needs gas at all

Easy to miss, because it sounds like a key that only signs.

`supplyIdle` and `withdrawIdle` check `msg.sender == agent`, so **the agent address sends its own
transactions**. The EIP-712 statement the enclave produces is the enclave attesting to what it
decided; it is not what authorises the call.

That is a constraint on the design rather than a detail: making these moves relayable would need a
signature-accepting variant of `supplyIdle`, the way `executeWithSignature` works for the owner —
a contract change, not something the backend can absorb. At 0.02 gwei each move costs on the order
of 0.00005 ETH, so the agent's balance covers hundreds.

## Still to answer

- [ ] **The production agent key must eventually be the DON's.** For the hackathon it is a key on
      a laptop, which is not what "the key never leaves the enclave" means. Fine for a demo, and
      worth saying rather than implying otherwise — the video's do-not-say list already carries it.
- [ ] **Who runs the relayer, and where its key lives.** #186 gave the app the read half —
      `apps/app/lib/account.ts` calls `accountFor` and renders the account before it exists. The
      write half is still missing: nothing sends `open`, in either `apps/app` or `apps/be`, so
      today a user's account has to be opened for them by hand. The wallet exists and is funded;
      the code that spends it does not. Still part of #175.

## Preconditions

- [x] **#182 merged** — 8 September 13:28 WIB. The account contracts are on `main`
- [x] **#176 merged** — 8 September 13:32 WIB. The workflow that reads the account
- [ ] **[#188](https://github.com/0xHelico/helico/pull/188) decided** — it changes
      `HelicoAccount.withdrawIdle`, so it changes the implementation bytecode. Deploying before it
      lands means the first upgrade is a bug fix, on the day the upgrade path is least rehearsed.
      Merging it first costs a review; deploying without it costs an upgrade
- [ ] `forge test`, the fork suite and `check-storage-layout.py` green on `main`
- [ ] Deployer funded on Arbitrum One (chain id 42161)

### How much, measured rather than guessed

@rifkyeasy ran every step above on a fork and totalled the gas. At Arbitrum One's price when he
measured it — `cast gas-price` said **0.02 gwei**:

| | gas | at 0.02 gwei |
|---|---|---|
| implementation + factory | 2,845,193 | 0.000057 ETH |
| open, permit, setAgent | ~300,000 | 0.000006 ETH |
| `HelicoMandateSwap` | ~400,000 | 0.000008 ETH |
| SwapVM router | ~5,000,000 | 0.000100 ETH |
| **everything** | | **~0.00017 ETH** |

**0.005 ETH covers all of it at twenty-five times that gas price.** Fund more than the estimate —
a script that runs out of gas halfway is a bad way to learn the number — but not by two orders of
magnitude, which is what "0.02 ETH" was. That figure gated this deploy for four days and nobody
had measured it.

## 1. The account factory

```bash
cd contracts
KEY=$(python3 -c "import re,pathlib;print(re.search(r'^DEPLOYER_PRIVATE_KEY=(.*)$',pathlib.Path('<source-of-truth>/.env').read_text(),re.M).group(1).strip())")
ACCOUNT_UPGRADER=0xaeE1F9d2c23730CA04Dd478830c2acc495536E9C \
forge script script/DeployAccountFactory.s.sol:DeployAccountFactory \
  --rpc-url $ARBITRUM_RPC_URL --broadcast --private-key "$KEY"
```

The script refuses any chain that is not 42161, and after broadcasting it checks two things
rather than assuming them: that the factory points at the implementation just deployed, and that
the address it predicts for an owner is the address it actually produces. A deploy that prints
those two lines has already verified itself.

**Record:** implementation address, factory address — in [`deployments.md`](deployments.md),
which is where the live ones already are.

**Then verify, in the same sitting.** A contract deployed and not verified is one a judge has to
take a screenshot's word for:

```bash
forge verify-contract $IMPLEMENTATION src/HelicoAccount.sol:HelicoAccount \
  --chain-id 42161 --etherscan-api-key "$ETHERSCAN_API_KEY" \
  --constructor-args $(cast abi-encode "constructor(address)" $ACCOUNT_UPGRADER) --watch
```

`ETHERSCAN_API_KEY` lives in the source-of-truth `.env`. **One key serves every chain** on
Etherscan's v2 API — there is no separate Arbiscan key to look for, and `--chain-id 42161` is
what aims it. The constructor arguments are in
`broadcast/<Script>.s.sol/42161/run-latest.json` under `arguments`, so they never have to be
remembered.

Check it from the other side afterwards. `forge` reporting success and the explorer serving the
source are two different claims:

```bash
curl -s "https://api.etherscan.io/v2/api?chainid=42161&module=contract&action=getsourcecode&address=$ADDR&apikey=$ETHERSCAN_API_KEY"
```

### If it says the bytecode does not match — and the contract uses `via_ir`

This cost six attempts on the SwapVM router. Read this before spending the fifth.

**The failure looks like a settings problem and is not.** Settings copied from the artifact's own
`metadata.settings` failed too. What separates it from a genuinely bad deployment is one check,
and it is worth running first so the next hour is spent on the right thing:

```bash
# does the deploy transaction start with our own artifact's creation bytecode?
python3 -c "
import json
art = json.load(open('out-swapvm/<Contract>.sol/<Contract>.json'))['bytecode']['object']
tx  = json.load(open('broadcast/<Script>.s.sol/42161/run-latest.json'))['transactions'][0]['transaction']['input']
print('faithful:', tx.lower().startswith(art.lower()))"
```

If that is `True`, the chain has what this repository built and the problem is the verifier.

**The cause.** solc's IR pipeline produces different bytecode depending on **which files are in
the compilation unit**, even when the extra files contribute nothing to the contract. Foundry
compiles the whole project; `forge verify-contract --show-standard-json-input` submits only the
contract's dependency closure. For the router that was 155 sources against 64 — same settings,
same solc, fifty bytes apart. Contracts built without `via_ir` never meet this, which is why the
other three verified first time.

Sourcify names it and Etherscan does not, so when Etherscan will not say why,
`forge verify-contract --verifier sourcify` is worth one run purely as a diagnosis:

```
extra_file_input_bug — metadata hashes match but not the bytecodes
```

**Metadata matching while bytecode does not always means compiler *input*, never compiler
*settings*.** The hash is computed over the sources and settings; if it matches, those matched.

**The fix.** Submit what was actually compiled. `build-info` names the real unit:

```bash
FOUNDRY_PROFILE=swapvm forge verify-contract $ADDR src/path/File.sol:Contract \
  --chain-id 42161 --show-standard-json-input 2>/dev/null | sed -n '/^{/,$p' > /tmp/base.json

python3 - <<'EOF'
import json, glob

CONTRACT = 'src/swapvm/HelicoAquaSwapVMRouter.sol'
artifact = json.load(open(f'out-swapvm/{CONTRACT.split("/")[-1]}/HelicoAquaSwapVMRouter.json'))

# Foundry keeps every build-info it has ever written, so the newest is not reliably yours and
# `glob(...)[0]` is arbitrary. The artifact's `id` is its **source id**, and the build-info that
# produced it is the one whose `source_id_to_path` maps that id back to this contract's own path.
# Exact, and it does not depend on timestamps or on how many builds are lying around.
wanted = str(artifact['id'])
builds = []
for f in glob.glob('out-swapvm/build-info/*.json'):
    paths = json.load(open(f)).get('source_id_to_path', {})
    if paths.get(wanted) == CONTRACT:
        builds.append((f, paths))
if len(builds) != 1:
    raise SystemExit(f'expected one build-info for {CONTRACT}, found {len(builds)}')
_, paths = builds[0]

base = json.load(open('/tmp/base.json'))
sources = {p: {'content': open(p, encoding='utf-8').read()} for p in sorted(paths.values())}
json.dump({'language': 'Solidity', 'sources': sources, 'settings': base['settings']},
          open('/tmp/full.json', 'w'))
print('sources:', len(sources), 'was:', len(base['sources']))
EOF
```

If that raises, `forge clean` and rebuild: more than one match means two builds compiled the same
file at the same source id, and neither is safe to guess between.

**Then compile it locally before submitting anything.** This is the step that turns the next
submission from a guess into a certainty, and it answers in seconds where Etherscan's queue takes
minutes:

```bash
solc --standard-json --base-path . --allow-paths . < /tmp/full.json
# compare .contracts[file][Contract].evm.bytecode.object against the artifact's bytecode.object
```

Once they are identical, POST it. Note that on Etherscan's v2 API **`chainid` belongs in the
query string**, not the body — in the body it is rejected as missing:

```
POST https://api.etherscan.io/v2/api?chainid=42161&module=contract&action=verifysourcecode&apikey=$ETHERSCAN_API_KEY
  codeformat=solidity-standard-json-input   sourceCode=<contents of full.json>
  contractaddress=$ADDR                     contractname=src/path/File.sol:Contract
  compilerversion=v0.8.30+commit.73712a01   constructorArguements=<no 0x>
```

## 2. Open an account, and give it its rules

```bash
cast call  $FACTORY 'accountFor(address)(address)' $OWNER --rpc-url $ARBITRUM_RPC_URL
cast send  $FACTORY 'open(address)' $OWNER --rpc-url $ARBITRUM_RPC_URL --private-key "$KEY"
```

The address printed by the first command must equal the one the second produces. That is the
whole promise of a counterfactual factory, and it costs one comparison to check.

Then, **as the owner**:

```bash
cast send $ACCOUNT 'permitVenue(address,bool)' 0x794a61358D6845594F94dc1DB02A252b5b4814aD true \
  --rpc-url $ARBITRUM_RPC_URL --private-key "$OWNER_KEY"
cast send $ACCOUNT 'setAgent(address)' $AGENT \
  --rpc-url $ARBITRUM_RPC_URL --private-key "$OWNER_KEY"
```

**Verify before moving on**, because the workflow refuses to act if either is wrong:

```bash
cast call $ACCOUNT 'agent()(address)' --rpc-url $ARBITRUM_RPC_URL
cast call $ACCOUNT 'permittedVenue(address)(bool)' 0x794a61358D6845594F94dc1DB02A252b5b4814aD --rpc-url $ARBITRUM_RPC_URL
```

### And two calls that prove it did what it was for

Added after @rifkyeasy rehearsed everything above on a fork and pointed out that the runbook
stops one step early. A deployment that leaves you unable to answer *"can the agent act, and can
I get out"* is not finished, and both answers are one `cast send` each.

```bash
# as the agent — the whole product in one call, and the owner never signs for it
cast send $ACCOUNT 'supplyIdle(address,address,uint256)' $AAVE_POOL $USDC <amount> \
  --rpc-url $ARBITRUM_RPC_URL --private-key "$AGENT_KEY"

# as the owner — the door nobody can wall up, with the aToken in the list
cast send $ACCOUNT 'escape(address[])' "[$AUSDC]" \
  --rpc-url $ARBITRUM_RPC_URL --private-key "$OWNER_KEY"
```

On the fork, `escape` returned **40,000.000099 aUSDC against 40,000 supplied**. The position
comes home with what it earned, because an aToken is an ERC-20 the account holds and `escape`
takes a token list — nothing has to be unwound first and none of the yield is stranded. Do this
with a small amount before trusting it with a real one.

## 3. Fill in the workflow's config

`apps/cre/workflow/config.production.json`:

| Field | Value |
|---|---|
| `account` | **leave zero.** The workflow reads every account from the subgraph, so naming one here is not how an account gets managed — it is how one account stays managed when the index cannot answer. Set it only for an account a demo depends on |
| `agent` | `0x84C3891a9693c891877aC474a90d17d29075fcAf`, the same address `setAgent` was given |
| `pools` | `["0x794a61358D6845594F94dc1DB02A252b5b4814aD"]` |
| `asset` | USDC, already correct |
| `reportReceiver` | leave zero — `delivery` is `signature`, and `deliver` refuses to write to an address with no code |
| `policyHash` | zero means "no policy published", which is a valid state and disables only the cross-check |

## 4. The workflow

Secrets first: the policy values and `SECRET_AGENT_KEY` have to be released to the DON, and the
key must be the one whose address step 2 named as agent. Then deploy against
`production-settings`.

**The first run is the check.** It should read the account, decide, and sign. If the account holds
nothing yet, the honest outcome is a hold — a workflow that supplies from an empty account would
be the surprising result, not the reassuring one.

## The SwapVM router

Independent of everything above — CRE does not read it, and no account has to exist first.

```bash
cd contracts
SWAPVM_RESCUER=<address> \
FOUNDRY_PROFILE=swapvm forge script script/DeploySwapVMRouter.s.sol:DeploySwapVMRouter \
  --rpc-url $ARBITRUM_RPC_URL --broadcast --private-key "$KEY"
```

**`FOUNDRY_PROFILE=swapvm` is not optional.** SwapVM needs the IR pipeline; the default profile
does not compile these files at all, so without it the script is not there to run.

`SWAPVM_RESCUER` is the only authority the router has: whoever may retrieve tokens stranded in
it. Unset means nobody can, and stranded tokens stay stranded. It cannot touch a maker's funds —
those move only through Aqua, keyed to the app a maker shipped to.

**Record:** the router address. Then read the two lines the script prints after broadcasting: it
checks that the router points at the canonical Aqua, and that it reports opcode 34, which is the
number an off-chain program builder has to emit. What it cannot check is that opcode 34 is the
instruction we mean — only a swap proves that, and `test/ForkSwapVMYieldCover.t.sol` is where it
is proven, against a fork of this chain.

> ⚠️ **Ship to this address, not to 1inch's.** A maker ships to an app address and Aqua keys
> every balance by it. Ship a program containing opcode 34 to the canonical router and that
> router has nothing at 34: the swap reverts on an out-of-range instruction, and the maker is
> left with a live commitment against a strategy nobody can fill. The address printed above is
> the one that goes into the frontend, the taker script, and the video.
>
> **It costs a transaction, not funds** — measured, not assumed, in
> `test_ShippingToTheWrongRouterStrandsTheStrategyAndSpendsNothing`. The wrong router really does
> hold a live commitment, and it can still spend none of it: the swap reverts before any transfer,
> the wallet, the lending position and the other side of the pair are all untouched, and the taker
> receives nothing. `dock` with the shipped token set takes the commitment back in one call.
>
> What it cannot do is be repaired in place. Aqua refuses to re-ship a strategy hash that already
> has balances (`StrategiesMustBeImmutable`), and docking sets the per-token sentinel to 255
> rather than back to zero — so that hash is spent for that app, permanently. Ship to the right
> app instead; a different app is a different ledger key, and unaffected.

## What can be deployed before all of this

`HelicoMandateSwap` stands outside the chain above: CRE does not read it, and nothing still open
changes its behaviour. The wrinkle this section used to carry is gone — #182 landed, so `main` is
the source Arbiscan would verify against and it is not about to move underneath a verification.

It and the SwapVM router are the two that can go out while the account questions are still open,
because nothing above depends on either and neither depends on anything above.

## Do not deploy

`HelicoVault` and the Uniswap v4 path. CRE no longer drives it, and the frontend's move off it is
[#175](https://github.com/0xHelico/helico/issues/175).
