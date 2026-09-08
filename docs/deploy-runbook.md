# Deploy runbook

Written before the deploy rather than during it, because the questions below are the kind that
stop a deploy halfway and are cheapest to answer while nothing is at stake.

Order matters for one reason: **CRE has nothing to read until an account exists.**
`config.production.json` names an account, and the workflow's first act is to read its state.

## Answer these first

- [ ] **Which wallet holds the gas?** The deploy scripts document `--account helico-deployer`, and
      `cast wallet list` does not show one. Whatever the keystore is actually called, the same name
      has to go in every command below.
- [ ] **What address does CRE sign with in production?** In the rehearsal the agent is anvil's
      second account, released as `SECRET_AGENT_KEY`. In production that key lives in the Vault DON
      and never leaves the enclave — so it has to be generated, stored as a DON secret, and its
      **address** written into `config.production.json` as `agent`. The account is then told to
      trust that address. Nothing else in the deploy can be done twice as cheaply as this one, so
      settle it first.
- [ ] **Who is `ACCOUNT_UPGRADER`?** Defaults to zero, which means only owners can ever change
      their own account's code. Setting it hands that power to a key. Ghoza decided CRE may
      upgrade automatically ([`2026-09-08-one-account-per-owner.md`](plans/2026-09-08-one-account-per-owner.md));
      if that still holds, this is the same enclave address as `agent`.

## Preconditions

- [ ] **#182 merged** — the account contracts are not on `main` until it is
- [ ] **#176 merged** — the workflow that reads the account
- [ ] `forge test`, the fork suite and `check-storage-layout.py` green on `main`
- [ ] Deployer funded on Arbitrum One (chain id 42161)

## 1. The account factory

```bash
cd contracts
ACCOUNT_UPGRADER=<enclave address, or omit for none> \
forge script script/DeployAccountFactory.s.sol:DeployAccountFactory \
  --rpc-url $ARBITRUM_RPC_URL --broadcast --account <keystore>
```

The script refuses any chain that is not 42161, and after broadcasting it checks two things
rather than assuming them: that the factory points at the implementation just deployed, and that
the address it predicts for an owner is the address it actually produces. A deploy that prints
those two lines has already verified itself.

**Record:** implementation address, factory address.

## 2. Open an account, and give it its rules

```bash
cast call  $FACTORY 'accountFor(address)(address)' $OWNER --rpc-url $ARBITRUM_RPC_URL
cast send  $FACTORY 'open(address)' $OWNER --rpc-url $ARBITRUM_RPC_URL --account <keystore>
```

The address printed by the first command must equal the one the second produces. That is the
whole promise of a counterfactual factory, and it costs one comparison to check.

Then, **as the owner**:

```bash
cast send $ACCOUNT 'permitVenue(address,bool)' 0x794a61358D6845594F94dc1DB02A252b5b4814aD true \
  --rpc-url $ARBITRUM_RPC_URL --account <owner keystore>
cast send $ACCOUNT 'setAgent(address)' $AGENT \
  --rpc-url $ARBITRUM_RPC_URL --account <owner keystore>
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
| `agent` | the enclave's address, the same one `setAgent` was given |
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
