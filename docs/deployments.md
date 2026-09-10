# Deployments

Arbitrum One, chain id 42161. Every address below was read back from the chain after the
broadcast, not copied from a script's output — the third column is what the contract answers when
asked about itself.

## 10 September 2026 — a Compound venue for ETH

`CompoundVenue` was written, reviewed and deployed against a six-decimal market only. This one
points at `cWETHv3`, so the ETH side of a position earns while it waits instead of sitting idle —
which is what "USDC **and** ETH can both be earning" needs in order to be true.

| Contract | Address | Answers | Source |
|---|---|---|---|
| `CompoundVenue` (WETH) | [`0xb0A125F539237b553025e2cb180f9C40B25918cD`](https://arbiscan.io/address/0xb0A125F539237b553025e2cb180f9C40B25918cD#code) | `symbol()` → `hcWETH`, `decimals()` → 18, `UNDERLYING_ASSET_ADDRESS()` → WETH, `COMET()` → `0x6f7D514b…` | verified |

Read back from the chain after the broadcast, not from the script's output:

```
symbol                        hcWETH
name                          Helico Compound WETH
decimals                      18
ASSET                         0x82aF49447D8a07e3bd95BD0d56f35241523fBab1   WETH
COMET                         0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486   cWETHv3
UNDERLYING_ASSET_ADDRESS()    0x82aF49447D8a07e3bd95BD0d56f35241523fBab1   the Aave spelling
getReserveAToken(WETH)        0xb0A125F539237b553025e2cb180f9C40B25918cD   itself
currentLiquidityRate          12469942161792000000000000 ray  =  1.247% APR
```

The last two lines are the ones worth reading twice. The venue names **itself** as the receipt it
issues, which is the whole reason a Compound market can be reached by apps that only know how to
ask Aave's questions. And the rate is annual in ray — Comet answers per-second in wad, and the
venue does both conversions so the enclave never learns which protocol replied.

```
tx         0x4ce467b3b8e8eb7a3f358b599e8b6020bb961ab06d70f914cd772120c9326188
gas used   1,400,224   at 0.0201 gwei   cost 0.0000281 ETH
deployer   0x6DCd7485aB17e0CBD0723b8435a35bb8d029439E   0.0073941 -> 0.0073660
```

### No contract changed, and that was the thing to check

Nothing in `CompoundVenue` writes a scale factor down: name, symbol and `decimals` are all derived
from `comet.baseToken()`. So an eighteen-decimal market should need no edit at all. **Should** is
not a claim a submission is allowed to make, so `ForkCompoundVenueWeth.t.sol` watches it instead —
seven tests against real `cWETHv3`, the mirror of the USDC file, with the maker lending WETH and
selling it so the token unwound out of Compound is the eighteen-decimal one.

The test that would catch a hidden `1e6` is **not** the value-conservation check. That compares
the venue against itself, and a conversion wrong by a constant factor satisfies it in both places
at once. It is the anchor outside the venue: the payout has to be a real slice of a twenty ETH
position, and a factor of a million leaves that window in either direction.

`DeployCompoundVenue.s.sol` takes the asset as an argument and asks the chain to agree, rather
than reading it off the market — read off the market, the check could not fail. Both guards were
exercised against a fork before the broadcast:

```
ASSET=<USDC> over cWETHv3     ->  AssetMismatch(0x6f7D514b…, 0x82aF4944…, 0xaf88d065…)
COMET_ADDRESS=0x…dEaD         ->  NoCode(0x…dEaD)
```

### Naming it took a code change, which was not expected

`config.production.json` now carries it, and adding the line turned out not to be a one-line
change. Every market in that list was read for every asset, which was right while Aave was the
only market — one Pool serves every reserve. A `CompoundVenue` holds exactly one market and
`getReserveAToken` on any other asset **reverts**, and a failed call fails the whole run by design.
So adding WETH to `assets` against a list holding three USDC-only venues would not have earned
less; it would have stopped every run, every five minutes, in a TEE.

Measured before it was written, at the live addresses:

```
                 getReserveAToken(USDC)   getReserveAToken(WETH)
aave             0x724dc807…C637          0xe50fA9b3…28c8
compound USDC    0x1eC57cE1…BB2E          revert
morpho USDC      0xBBa798A6…c9A29         revert
compound WETH    revert                   0xb0A125F5…18cD
```

So a market may now name the assets it lists, and one that names none lists them all — which is
what an Aave Pool is, and what keeps every configuration written before this from needing a
migration. Declared rather than discovered on purpose: treating a revert as "does not list it"
would make a dropped RPC call, a paused venue and a market that genuinely does not hold the asset
all arrive as the same silence.

### Still inert

- the owner calls `permitVenue(0xb0A125F5…)` — the account refuses any market it was not told
  about, and there is no account yet
- ~~`config.production.json` names it with `kind: "share-priced"`~~ — done, scoped to WETH
- the workflow is redeployed, because config travels with the binary

Until all three, ETH does not earn and the submission must not say it does.

## 10 September 2026 — the Aqua apps went behind proxies

| Contract | Address | Answers | Source |
|---|---|---|---|
| `HelicoMandateSwap` | [`0x0524a353dfab33CD362593ae8e97707764Fb6041`](https://arbiscan.io/address/0x0524a353dfab33CD362593ae8e97707764Fb6041#code) | `AQUA()` → `0x1111113CCf…`, `UPGRADER()` → `0xaeE1F9d2…6E9C` | verified, proxy **and** implementation |
| `HelicoOracleBoard` | [`0xe8515af92442A5CDa67D1F32D1c8a987ba7e7d39`](https://arbiscan.io/address/0xe8515af92442A5CDa67D1F32D1c8a987ba7e7d39#code) | the same two | verified, proxy **and** implementation |

```
implementation behind the mandate swap   0xfdefc345…b557
implementation behind the oracle board   0xc54cf202…b410
proxy code                               329 chars — delegatecall and nothing else
```

**The address that matters is the proxy's.** A maker ships to it and Aqua keys every balance by
it; the implementation is a place the proxy borrows code from and is not an app. Both halves are
verified, because verifying only one leaves unverified bytecode at the address the README names.

### Why, and it is the third address change in two days

That is the argument rather than an embarrassment beside it. `ReceiptKind` widened `Venue` on 9
September and both apps had to be replaced; the venue pair was replaced an hour after that. Every
one of those moved an address quoted in five documents. Behind a proxy the next one is an upgrade.

`ForkMandateSwap.t.sol` proves the property rather than asserting it: a mandate is shipped, the app
is upgraded, and **the same mandate fills at the same price through the new code** — with Aqua's
ledger following it across, because Aqua keys balances by the app address and the address survived.

### What a maker is now trusting

An Aqua app can `pull` from the maker's own wallet, so whoever holds `UPGRADER` can change what an
already-shipped mandate does. That is a real transfer of trust and it is written into
`UpgradeableAquaApp` rather than left implicit. The mitigation is that `UPGRADER` is
`0xaeE1F9d2…6E9C` — held apart from the deployer and the agent, the same separation `HelicoAccount`
uses. A zero upgrader would freeze an app, which is a legitimate setting and not this one.

`scripts/check-storage-layout.py` now covers both apps. Their only storage is `_reentrancyLocks` at
slot 0, which is exactly why: a field declared above it moves the lock, and the lock is what stops
a taker re-entering a maker's strategy mid-fill.

### One guard that failed on a correct deployment

`scripts/check-deployed.ts` grepped the deployed bytecode for `mandateHash`'s selector. A proxy
carries no selectors at all, so the check went red on the deployment it exists to protect — the
implementation had it and the address that matters did not. It calls the function now instead,
which is the better test either way: a selector present in bytecode is not a selector that can be
reached.

### Superseded, and neither was ever used

`0xE56e2ACF…2a0d` and `0xF0aB4fF0…22A9`, both deployed the previous evening. `eth_getLogs` returned
zero events on both, so nothing was stranded.

## 9 September 2026 — two venues outside Aave, and the two apps that can now reach them

The enclave compares markets and moves capital to the best one, and until today every market it
could compare was Aave-shaped — which makes it a market picker rather than a yield optimiser.
These two answer `ILendingVenue` on behalf of Compound v3 and of any ERC-4626 vault.

| Contract | Address | Answers | Source |
|---|---|---|---|
| `CompoundVenue` | [`0x1eC57cE1DdfdC7a4EbF4F54Aedee19ab73fcBB2E`](https://arbiscan.io/address/0x1eC57cE1DdfdC7a4EbF4F54Aedee19ab73fcBB2E#code) | `symbol()` → `hcUSDC`, `UNDERLYING_ASSET_ADDRESS()` → USDC | verified |
| `MorphoVenue` | [`0xBBa798A61f0D7D1AE51466Fd4045Cd2Ea25c9A29`](https://arbiscan.io/address/0xBBa798A61f0D7D1AE51466Fd4045Cd2Ea25c9A29#code) | `symbol()` → `hmUSDC`, `UNDERLYING_ASSET_ADDRESS()` → USDC | verified |
| `HelicoMandateSwap` | [`0xE56e2ACF431D80fbBb3192CD264138629F4f2a0d`](https://arbiscan.io/address/0xE56e2ACF431D80fbBb3192CD264138629F4f2a0d#code) | `AQUA()` → `0x1111113CCf…` | verified |
| `HelicoOracleBoard` | [`0xF0aB4fF02ab557eC7abAE4697b279301643222A9`](https://arbiscan.io/address/0xF0aB4fF02ab557eC7abAE4697b279301643222A9#code) | `AQUA()` → `0x1111113CCf…`, feed answered `247996000000` at 8 decimals | verified |

> ⚠️ **The venue pair above replaced an earlier pair the same evening.** `0xB7B7DD5ff9cCf35D1AE3283F485b261B962a58a6`
> and `0xD7fC33eeaB4113d784402880B524B95e92A29b5A` went out at 19:10 and were superseded within the hour, because
> @rifkyeasy found that `supply` could mint **zero shares without reverting** — a donation into a
> fresh venue rounds an honest deposit to nothing while the call returns happily. The `+1` offset
> makes that donation unprofitable, which is not the same as harmless, and the docblock had
> treated the two as one thing. Neither superseded venue ever held anything: `totalAssets` was
> zero on both when they were replaced.

**The last two supersede** `0xA16D3138…87Ed` and `0xeb480C09…C760`, which both predate
`ReceiptKind` and cannot take a mandate or a board carrying today's `Venue`. That was checked
against the deployed bytecode rather than reasoned about:

```
old mandate swap   contains beb513da   today's mandateHash is 5344635d   → absent
old oracle board   contains 972fa952   today's hashOf      is 9918148b   → absent
new mandate swap   contains 5344635d
new oracle board   contains 9918148b
```

Neither of the superseded pair had ever been used — `eth_getLogs` on both returns **zero events**
from their deploy block to head — so nothing was stranded and no maker had to move.

### What makes a venue reachable, and none of it happened at deploy

A deployed venue is inert. Three more things are needed before the enclave can use one, and they
are deliberately not part of this deploy:

- the owner calls `permitVenue` for each address — the account refuses any market it was not told about
- `config.production.json` names them with `kind: "share-priced"`, since both issue shares whose
  price drifts upward rather than balances that grow
- the workflow is redeployed, because config travels with the binary

Until all three, the account reaches Aave and nothing else, and the submission must not say
otherwise.

```
CompoundVenue      tx 0xfe8a3a9ad56758eaecaaec6251ab35ed499ef448ed48e23a5aa93a825453db8f
MorphoVenue        tx 0xdaa80f542ae23e1d490cd1373feae36d38db645cdadc41ca1cfb584c6e0416c7
                   both together   gas 3,229,004   cost 0.0000647 ETH
HelicoMandateSwap  redeploy
HelicoOracleBoard  redeploy
```

**Deployer** `0x6DCd7485aB17e0CBD0723b8435a35bb8d029439E`, balance `0.0077045` → `0.0075673`.
All four cost **0.000137 ETH** together, at around 0.02 gwei.

### The check that mattered most, and it was at deploy rather than at first use

The deploy script reads `baseToken()` off Comet and `asset()` off the vault and refuses unless
both answer the **same** USDC the Aave venue uses. Arbitrum carries exactly the trap that check
exists for: `cUSDCv3` is native USDC and `cUSDCev3` is the bridged `USDC.e`. A venue over the
wrong one would deploy cleanly, answer every read, and make the enclave compare positions
denominated in two different tokens as though they were one — with nothing reverting.

It also asserts, after the broadcast, that each venue answers Aave's `UNDERLYING_ASSET_ADDRESS()`
spelling and names **itself** as its own receipt. Both are load-bearing: `_requireReceiptFor` in
either Aqua app refuses a venue that fails the first, and `_cover` cannot burn without the second.

## 8 September 2026 — the accounts and the Aqua app

| Contract | Address | Answers | Source |
|---|---|---|---|
| `HelicoAccount` (implementation) | [`0x0842BB3f773A8Ee9732b229327b79CCB2Ce54847`](https://arbiscan.io/address/0x0842BB3f773A8Ee9732b229327b79CCB2Ce54847#code) | `UPGRADER()` → `0xaeE1F9d2…` | verified |
| `HelicoAccountFactory` | [`0x01CC7d9FE8da79B61bcc5d3f7e3f0433DCE7E081`](https://arbiscan.io/address/0x01CC7d9FE8da79B61bcc5d3f7e3f0433DCE7E081#code) | `IMPLEMENTATION()` → `0x0842BB3f…` | verified |
| `HelicoMandateSwap` | [`0xA16D313816247628DeB7d89DC7a3Cf4aDb5287Ed`](https://arbiscan.io/address/0xA16D313816247628DeB7d89DC7a3Cf4aDb5287Ed#code) | `AQUA()` → `0x1111113CCf…` | verified |

> ⚠️ **`HelicoMandateSwap` is one feature behind the source in this repository, and cannot
> take a mandate written today.** `ReceiptKind` landed on 9 September in `423edd9` and widened
> `Venue` by a field, so `SwapMandate` is a different tuple now: the deployed app answers
> `mandateHash` at selector `0xbeb513da` and today's struct hashes to `0x5344635d`. The bytecode
> at that address contains the first and not the second, which is asserted rather than assumed —
> `scripts/check-deployed.ts` reads the code back and fails if it ever stops being true.
>
> Nothing is wrong with what is deployed; it is simply older than the tests. But a mandate
> shipped to it today would not revert, it would miss the function, so **this needs redeploying
> before anything ships to it for real**. `check-deployed.ts` deploys the current source onto a
> fork and runs the whole path against it, so the redeploy is the only step that is missing.

```
HelicoAccount         tx 0xc9517828f595dc6e563b3702da51f70f9823497c3790b8fb8130a59ca5039163
                      block 502,979,387   gas 1,963,574
HelicoAccountFactory  tx 0x033277a7101fcd2f9d3a30ebedad467032f82542a169eb28e4916b057630b320
                      block 502,979,401   gas   898,469
HelicoMandateSwap     tx 0x5ea76409ca2172755cb1fb9aff69ee82d5a8a0461a03eda853986744ed09ee1f
                      block 502,979,513   gas 1,728,989
```

**Deployer** `0x6DCd7485aB17e0CBD0723b8435a35bb8d029439E`, and the whole thing cost
**0.0000929 ETH** at 0.02 gwei — the balance went from 0.0079167 to 0.0078237. The figure that
gated this deploy for four days was 0.02 ETH, which is two hundred times what it took.

### What each deployment checked before it was believed

Both scripts assert after broadcasting rather than assuming beforehand, and both printed their
checks. `DeployAccountFactory` additionally proves the property the whole factory exists for: it
predicts an address for an owner, opens it inside a state snapshot, compares, and reverts the
snapshot. A counterfactual address that does not match what the factory produces would be a
quiet lie, and it is checked at the moment of deployment rather than trusted.

### Verified, and checked from the other side

All three carry their source on Arbiscan. Read back from Etherscan's API rather than taken from
`forge verify-contract`'s own report — a tool saying it succeeded is not the same claim as the
explorer serving the source:

```
0x0842BB3f…  HelicoAccount         231,503 chars  v0.8.30+commit.73712a01  optimizer on, 200 runs
0x01CC7d9F…  HelicoAccountFactory  194,621 chars  v0.8.30+commit.73712a01  optimizer on, 200 runs
0xA16D3138…  HelicoMandateSwap      83,601 chars  v0.8.30+commit.73712a01  optimizer on, 200 runs
```

Compiler and optimizer settings match `foundry.toml`'s default profile, which is what makes the
verification mean the bytecode came from the source in this repository rather than from something
that merely compiles to the same thing.

Verification needs `ETHERSCAN_API_KEY` in the source-of-truth `.env`. One key serves every chain
on Etherscan's v2 API, so `--chain-id 42161` is all that points it at Arbiscan.

## 8 September 2026 — the SwapVM router

| Contract | Address | Answers | Source |
|---|---|---|---|
| `HelicoAquaSwapVMRouter` | [`0xb8c9f14d46bf387a6d70d796df30f11a0eb8c3be`](https://arbiscan.io/address/0xb8c9f14d46bf387a6d70d796df30f11a0eb8c3be) | `AQUA()` → `0x1111113CCf…`, `AQUA_YIELD_COVER_OPCODE()` → `34` | verified |

```
tx 0x074ad590cc29214e2a12667f538f8a0fb1d1cb87d39b4a4e878340abfa943ab7
block 502,984,884   gas 4,186,682   cost 0.0000839 ETH
constructor(aqua, weth, rescuer, "Helico SwapVM", "1")
rescuer 0x6DCd7485aB17e0CBD0723b8435a35bb8d029439E
```

The EIP-712 domain reads back as `"Helico SwapVM"` version `"1"`, which is how you tell this
router apart from 1inch's `"1inch SwapVM v1.0"` / `"1.0.2"` at
`0x111111338c5091E8440b67B168bAe16a668AC0De`. **Ship strategies carrying opcode 34 to the address
above, not to that one** — see the runbook for what happens if you do not, and the fork test that
measures it.

### Verifying it took six attempts, and the sixth is the one to remember

Every submission came back `Compiled contract deployment bytecode does NOT match`, while the
other three verified first time with the same compiler and key. The settings were not the
problem — they were copied from the artifact's own metadata and still failed.

**Sourcify named it.** Its rejection carries an error code the Etherscan API does not:

```
extra_file_input_bug
It seems your contract's metadata hashes match but not the bytecodes.
Use the original full standard JSON input file that has all files including
those not needed by this contract.
```

The metadata hash matching while the bytecode does not is the whole diagnosis. **solc's IR
pipeline produces different bytecode depending on which files are in the compilation unit**, even
when the extra files contribute nothing to the contract. Foundry compiles the whole project — 155
sources here — while `forge verify-contract --show-standard-json-input` submits the dependency
closure, 64. Same settings, same solc, 50 bytes of difference.

The fix is to submit what was actually compiled. `out-swapvm/build-info/*.json` carries
`source_id_to_path` for the real unit; rebuilding the standard JSON from all 155 and compiling it
locally reproduced the deployed creation bytecode **exactly**, and Arbiscan then accepted it on
the first try.

This only bites contracts built with `via_ir`, which is why the other three never met it.

### The deployment was faithful, and that was checked before any of this

Worth keeping separate from the verification story, because it is what made it safe to keep
trying rather than assume a bad deploy:

- the creation bytecode in the deploy transaction **starts with the local artifact's exactly**,
  and the tail is the constructor arguments byte for byte;
- the runtime differs by ~377 bytes against **16 declared immutable slots** — 512 bytes of
  placeholder the constructor fills;
- a clean `FOUNDRY_PROFILE=swapvm forge build` from `main` reproduces the deployed creation
  bytecode, checked by deleting `out-swapvm` and rebuilding.

## 9 September 2026 — the oracle board

A second Aqua app, beside `HelicoMandateSwap` rather than replacing it. It exists for the maker
who holds **one** token: their USDC earns in a lending market, and a fill is settled out of it.
The constant-product app cannot quote them at all — its price *is* the ratio of two balances, so a
zero side has no price.

| Contract | Address | Checked | Source |
|---|---|---|---|
| `HelicoOracleBoard` | [`0xeb480C0994A34a81a49C3250C45a9e96eac0C760`](https://arbiscan.io/address/0xeb480C0994A34a81a49C3250C45a9e96eac0C760#code) | `AQUA()` → `0x1111113CCf…`, 15,747 hex of code | verified, first attempt |

```
tx     0x9f93a95a553e98453fd04fdad83bc55839cb53e85f130a1faf5698c7d3ac3a17
gas    1,763,931
cost   0.0000353 ETH
```

The deploy script refuses a chain that is not 42161, refuses an Aqua that does not answer
`rawBalances`, and refuses a feed that does not answer or answers zero — a board quoting zero
hands its inventory away, so that check is at deploy rather than at first fill. It printed the
feed's live answer, `251792069162` at 8 decimals, so the number was compared against a price a
person knows rather than taken on trust.

**The feed is not deployed with it.** A board names its own, so this one deployment serves every
pair Chainlink covers. `ETH_USD_FEED` in the script is
[`0x639Fe6ab…ba612`](https://arbiscan.io/address/0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612),
whose `description()` answers `"ETH / USD"` — read from the chain before it was written down.

**Nothing has shipped a board to it yet.** The contract holds no state of its own; every board
lives in Aqua's ledger keyed by its hash, so an empty deployment is the expected resting state
rather than a sign that something is missing.

## 8 September 2026 — the CRE workflow, and the subgraph it reads

Not a contract of ours, so it sits apart: a workflow registered in Chainlink's
`WorkflowRegistry 2.0.0` on **Ethereum mainnet**, running against Arbitrum.

```
name          helico-production
workflow id   002b3bc0bfea52d8d7b3a617fffdfa0d26c32d303c0c3bec713b3d9036ab0a05
DON family    zone-a
owner         0x6DCd7485aB17e0CBD0723b8435a35bb8d029439E   (the deployer)
schedule      every 5 minutes
```

| | |
|---|---|
| link the owner | [`0xda752a60…`](https://etherscan.io/tx/0xda752a60bbc69c8292ac1d32d838aecafb4845571cb6dd57a51fef289dcbf818) |
| register the workflow | [`0x2b81e564…`](https://etherscan.io/tx/0x2b81e5649c620ad203befdded20daacdd3fdbccc8a23db8165b81249e3ba4959), 803,030 gas |

Read back from the registry rather than from the CLI, which reported *"No workflows found"* about
this same workflow while it was running:

```
isOwnerLinked(deployer)                → true
totalActiveWorkflowsByOwner(deployer)  → 1
getWorkflowById(0x003fbfdc…)           → present, owner 0x6dcd7485…
```

**One secret is in the Vault DON** under namespace `main` — `HELICO_VAULT`, a JSON document
holding all eleven values: the seven policy numbers, the agent key, and three model-router
credentials. The policy is the strategy and is the reason the workflow is a *Confidential* one —
node operators never see it.

It is one item because the DON answers **one secret retrieval per execution**, which is not
documented anywhere we could find and which every earlier deploy ran into. The measurement and
the SDK evidence are in [`deploy-runbook.md`](deploy-runbook.md); created by
[`0x5126f608…`](https://etherscan.io/tx/0x5126f6087ab8f874b03289add69d1afb4f3e73a283f7b80c1b050fa758c43dd8),
0.0000339 ETH.

**What it does today, corrected.** This section previously read *"it holds, every run,
correctly."* That was not true when it was written, and the runs said so: every execution failed
at secret retrieval, and a workflow that never reaches its own logic is not holding — it is
erroring. The line described the code's intent rather than the deployment's behaviour, which is
the one thing a deployment record must not do.

What is true, from `cre execution list`:

```
13:50:02 UTC   SUCCESS
13:45:02 UTC   SUCCESS    ← first run of the one-item binary
13:40:01 UTC   FAILURE
13:35:02 UTC   FAILURE
13:30:02 UTC   FAILURE
```

Two in a row, which is what makes it a fix rather than a coincidence — the failures were
deterministic across two runs of one binary, so a single success would have proved as little as
a single failure did.

So: it reaches its logic and holds, because no account has been opened on mainnet and there is
nothing to manage. The moment somebody opens one and calls `setAgent`, the enclave picks it up —
no redeploy, because the account list comes from the subgraph.

### The subgraph, v0.2.0

`helico-arbitrum-one`, now indexing `HelicoAccountFactory` alongside Aqua, which is what makes the
sentence above true.

```
block 503,020,287 against a chain head of 503,020,302   ·   hasIndexingErrors: false
accounts: 0   ← correct; none opened yet
```

Queried at `…/helico-arbitrum-one/version/latest`, which is what
`config.production.json` names, so a new version is picked up without editing the workflow.

### Deleted rather than left undeployed

- **`HelicoVault` and the Uniswap v4 contracts**, on 8 September 2026. Never deployed, CRE had
  moved to the yield layer, and Uniswap v4 was never a submitted track — so "deliberately not
  deployed" was a standing explanation for code nobody was going to run. The frontend's move off
  `packages/plugins/uniswap` is [#175](https://github.com/0xHelico/helico/issues/175).

### Not done yet

- **No account has been opened on mainnet.** The factory is live and permissionless; nothing has
  used it, and nothing holds anyone's funds. See [the runbook](deploy-runbook.md) for the two
  calls that prove a deployed account can be acted on and escaped from.
