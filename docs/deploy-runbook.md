# Deploy runbook

Written before the deploy rather than during it, because the questions below are the kind that
stop a deploy halfway and are cheapest to answer while nothing is at stake.

Order matters for one reason: **CRE has nothing to read until an account exists.**
`config.production.json` names an account, and the workflow's first act is to read its state.

## The keys, and what they cost

Both live in the source-of-truth `.env`, which is gitignored and untracked. Read as text, never
sourced, and passed to `cast` as `--private-key "$(…)"` at the moment of use — no keystore, no
password to remember.

| | address | holds |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | `0x6DCd7485aB17e0CBD0723b8435a35bb8d029439E` | 0.0149 ETH |
| `AGENT_PRIVATE_KEY` | `0x84C3891a9693c891877aC474a90d17d29075fcAf` | 0.0100 ETH |

Both were at nonce 0 — never used. The agent was funded from the deployer in
[`0xa9282b81…`](https://arbiscan.io/tx/0xa9282b810f04668d2bbea6718344cbf6f7ec88b629c5d5c75cecc079dd5f665c),
block 502,878,733.

### Why the agent needs gas at all

Easy to miss, because it sounds like a key that only signs.

`supplyIdle` and `withdrawIdle` check `msg.sender == agent`, so **the agent address sends its own
transactions**. The EIP-712 statement the enclave produces is the enclave attesting to what it
decided; it is not what authorises the call.

That is a real constraint on the design, not a detail: making these moves relayable would need a
signature-accepting variant of `supplyIdle`, the way `executeWithSignature` works for the owner.
Not today's work, but better known now than discovered when the agent's wallet empties.

At 0.02 gwei — Arbitrum's price while this was written — each move costs on the order of
0.00005 ETH, so the agent's balance covers hundreds of them.

## Still to answer

- [ ] **Is `AGENT_PRIVATE_KEY` also `ACCOUNT_UPGRADER`?** Ghoza's note says it is. That means one
      key both moves idle capital and can replace an account's code, and upgrades are immediate
      because the delay was removed for the hackathon. It is a deliberate concentration and worth
      re-confirming out loud before it is baked into a deployment — the escape hatch is what
      remains if it is ever wrong, and it is in the proxy where no upgrade reaches it.
- [ ] **The production agent key must be the DON's, eventually.** For the hackathon this key is on
      a laptop, which is not what "the key never leaves the enclave" means. Fine for a demo; say so
      rather than implying otherwise.

## Preconditions

- [ ] **#182 merged** — the account contracts are not on `main` until it is
- [ ] **#176 merged** — the workflow that reads the account
- [ ] `forge test`, the fork suite and `check-storage-layout.py` green on `main`
- [ ] Deployer funded on Arbitrum One (chain id 42161)

## 1. The account factory

```bash
cd contracts
KEY=$(python3 -c "import re,pathlib;print(re.search(r'^DEPLOYER_PRIVATE_KEY=(.*)$',pathlib.Path('<source-of-truth>/.env').read_text(),re.M).group(1).strip())")
ACCOUNT_UPGRADER=0x84C3891a9693c891877aC474a90d17d29075fcAf \
forge script script/DeployAccountFactory.s.sol:DeployAccountFactory \
  --rpc-url $ARBITRUM_RPC_URL --broadcast --private-key "$KEY"
```

The script refuses any chain that is not 42161, and after broadcasting it checks two things
rather than assuming them: that the factory points at the implementation just deployed, and that
the address it predicts for an owner is the address it actually produces. A deploy that prints
those two lines has already verified itself.

**Record:** implementation address, factory address.

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

`HelicoMandateSwap` stands outside the chain above: CRE does not read it, and nothing in the open
PRs changes its behaviour. Its source on `main` is byte-identical to the account branch's; the
compiled bytecode differs only in the trailing metadata hash, because `ILendingVenue` gained a
function the swap does not call. So deploying it now is safe, with one wrinkle worth knowing:
Arbiscan would verify it against `main`'s sources, and those move when #182 lands.

## Do not deploy

`HelicoVault` and the Uniswap v4 path. CRE no longer drives it, and the frontend's move off it is
[#175](https://github.com/0xHelico/helico/issues/175).
