# Deployments

Arbitrum One, chain id 42161. Every address below was read back from the chain after the
broadcast, not copied from a script's output — the third column is what the contract answers when
asked about itself.

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
> `scripts/check-mandate.ts` reads the code back and fails if it ever stops being true.
>
> Nothing is wrong with what is deployed; it is simply older than the tests. But a mandate
> shipped to it today would not revert, it would miss the function, so **this needs redeploying
> before anything ships to it for real**. `check-mandate.ts` deploys the current source onto a
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
