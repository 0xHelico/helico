# Deploy runbook

Written before the deploy rather than during it, because the questions below are the kind that
stop a deploy halfway and are cheapest to answer while nothing is at stake.

Order matters for one reason: **CRE has nothing to read until an account exists.**
`config.production.json` names an account, and the workflow's first act is to read its state.

## Four keys, four roles, split by blast radius

All in the source-of-truth `.env`, which is gitignored and untracked. Read as text, never sourced,
and passed to `cast` as `--private-key "$(…)"` at the moment of use — no keystore, no password.

| Role | Address | Holds | If this key leaks |
|---|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | `0x6DCd7485aB17e0CBD0723b8435a35bb8d029439E` | 0.0079 | Deploys contracts and spends its gas. Nearly idle once the deploy is done |
| `AGENT_PRIVATE_KEY` | `0x84C3891a9693c891877aC474a90d17d29075fcAf` | 0.0100 | Moves capital between the account and permitted markets. **Cannot take it** — neither call has a recipient parameter |
| `RELAYER_PRIVATE_KEY` | `0x96575074e509DAB29D56D83060c2438730aC582E` | 0.0050 | Opens accounts, which grants nothing, and carries calls the owner already signed. Almost no damage |
| `UPGRADE_PRIVATE_KEY` | `0xaeE1F9d2c23730CA04Dd478830c2acc495536E9C` | 0.0020 | **Replaces an account's code, immediately.** The largest power in the system |

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

## 3. Fill in the workflow's config

`apps/cre/workflow/config.production.json`:

| Field | Value |
|---|---|
| `account` | from step 2 |
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

## What can be deployed before all of this

`HelicoMandateSwap` stands outside the chain above: CRE does not read it, and nothing still open
changes its behaviour. The wrinkle this section used to carry is gone — #182 landed, so `main` is
the source Arbiscan would verify against and it is not about to move underneath a verification.

It is still the one contract that can be deployed while the account questions are open, because
nothing above depends on it and it depends on nothing above.

## Do not deploy

`HelicoVault` and the Uniswap v4 path. CRE no longer drives it, and the frontend's move off it is
[#175](https://github.com/0xHelico/helico/issues/175).
