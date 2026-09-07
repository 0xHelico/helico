# Chainlink CRE workflows

> **The workflow's job changed on 8 September, and part of this directory has not caught up.**
>
> CRE used to re-centre a Uniswap v4 position through `HelicoVault`. It now decides how much of
> an account's idle capital should be earning in a lending market and moves it — see
> [`docs/plans/2026-09-08-cre-manages-idle-capital.md`](../../docs/plans/2026-09-08-cre-manages-idle-capital.md).
>
> `@helico/plugin-cre` is rewritten for that, and **`rehearse-idle.sh` runs the new path end to
> end** — deploys the factory, opens an account at an address predicted before it exists, funds it
> with real USDC taken from a whale on the fork, lets the enclave decide and sign, and carries the
> signed call to the chain. A recorded run, 8 September: 50,000 USDC in,
> `SUPPLY 40000000000 to 0x794a…14ad`, and the account ends holding 39,999.999999 aUSDC against a
> 10,000 USDC buffer. The agent's own balance is zero at the end, which is the half worth checking.
>
> **`config.pools` is a list, and this script's has one entry.** The workflow compares the live
> `currentLiquidityRate` at every market the owner permitted and moves capital to the best of
> them; Aave v3 is the only market on Arbitrum we found answering that interface for USDC, so the
> script exercises the choice with a list of one. Choosing between several, and the round-trip bar
> a migration has to clear, are covered by the unit tests rather than by this script.
>
> `rehearse.sh` is the old one and still drives the vault path. Kept working rather than deleted,
> because `Deploy.s.sol` still deploys the vault.
>
> **If your `.env` predates 8 September it has the vault's `MANDATE_*` names and none of the
> `IDLE_*` ones.** `rehearse-idle.sh` checks and names the whole missing list; the CRE CLI names
> one variable at a time.
>
> The frontend still imports the retiring ABIs, which is why they are kept exported. That is
> tracked in #175.

The runnable CRE project. The workflow itself is
[`@helico/plugin-cre`](../../packages/plugins/cre/); this directory is what the CRE CLI needs
to compile, simulate and deploy it, plus a script that reproduces a whole run on a local fork.

Keeping the logic in a package rather than in `workflow/main.ts` is deliberate: it is how 116
unit tests can cover the enclave's decision without the CLI in the loop.

## Run it

```bash
bun install
cp apps/cre/.env.example apps/cre/.env
cd apps/cre && ./rehearse.sh
```

`rehearse.sh` needs `anvil`, `cast`, `forge`, `cre` and `jq`, and about two minutes. It forks
Arbitrum One on `127.0.0.1:8546`, deploys the vault onto the fork pointed at the mock
forwarder, funds an owner, mints a position whose range sits below the market so it holds one
token, commits a mandate, writes the vault's address and the mandate hash into
`workflow/config.staging.json`, and runs the workflow twice.

It rewrites `workflow/config.staging.json` in place. `git checkout` restores it.

To simulate without the fork setup — useful once a vault exists somewhere — fill in
`workflow/config.staging.json` yourself and run `bun run --filter @helico/cre simulate`.

## What a run proves, and what it does not

**`rehearse-idle.sh`** proves the whole path for the workflow this package now runs. The
workflow compiles for the CRE runtime, reads an account's state from inside the handler, decides
against thresholds released only there, signs an EIP-712 statement, and the signed call lands and
moves real USDC into the real Aave v3 pool at its real depth. A recorded run: 50,000 USDC funded,
`SUPPLY 40000000000 to 0x794a6135…`, and the account ends holding 39,999.999999 aUSDC against a
10,000 buffer.

The last thing it checks is the agent's own balance, which is zero. That is the assertion that
matters, for the reason the section below gives about transaction hashes.

It does **not** prove authorisation by a decentralised oracle network. The simulator is not a TEE
— it says so itself when it runs, and names the enclave it would use in production. It is also a
fork, not a live network.

**`rehearse.sh`** is the older script and still drives the Uniswap v4 vault path, which the
workflow no longer touches. Kept working rather than deleted, because `Deploy.s.sol` still
deploys the vault.

## ⚠️ A transaction hash is not evidence here

`KeystoneForwarder` calls the receiver inside a `try`. **If `onReport` reverts, the forwarder
swallows it and the transaction still succeeds.** So the workflow prints
`RECENTER … tx 0x…`, the receipt says `status 1`, and nothing moved.

This is not hypothetical: it is what the first run of this script did. So the script reads
`positionOf` **before and after**, and only a position that actually changed counts as a
re-centre. When it has not, the script replays the transaction with `cast run` to show what the
vault refused, and exits non-zero.

**Never quote a transaction hash from this path as proof that a re-centre happened.** Not the
hash, and not the receipt status either — the receipt said `status 1` for a run in which
nothing moved.

That check is what found [#78](https://github.com/0xHelico/helico/issues/78).

## The files

| | |
|---|---|
| `project.yaml` | RPC per target. `staging-settings` is the local fork; `production-settings` is Arbitrum One |
| `secrets.yaml` | Vault DON secret ids. Six of the mandate's seven fields, plus the agent key |
| `workflow/workflow.yaml` | Workflow name and artefact paths per target |
| `workflow/main.ts` | The entry point. Four lines around `@helico/plugin-cre` |
| `workflow/config.staging.json` | Public config for the fork. Rewritten by `rehearse.sh` |
| `workflow/config.production.json` | Public config for Arbitrum One. Vault and owner to be filled after a deployment |
| `.env.example` | The private half of the mandate, and the keys. Copy to `.env`, which is gitignored |
| `rehearse.sh` | The whole run, end to end |

## What is confidential, and what is not

The **policy** is a Vault DON secret, read only inside the enclave: what share of the capital
should be earning, how much must stay liquid to cover a swap, how large a difference is worth
paying gas to correct, and the rate below which supplying is not worth it. That is the strategy,
and it is the thing a competitor would want.

The account, the markets and the asset are public, because they are on chain and anyone can read
them.

**Nothing on chain holds the policy, and that is a deliberate difference from the vault.**
`HelicoAccount` enforces the *shape* of what an agent may do — capital moves between the account
and a market the owner allowlisted, with no recipient anywhere in the call — and leaves *how
much* and *when* to the enclave. So a wrong secret produces a wrongly-sized move, never a stolen
one. The check against that is `policyHash` in the config: publish the hash and the enclave
refuses any secrets that do not produce it. Leave it zero and there is nothing to disagree with.

The workflow binary is not confidential. Chainlink's own template says so, and so does this:
the logic is in a public package, and that is the point. What stays inside the enclave is the
data, the RPC traffic, and the intermediate values.

## Chainlink prize requirements

The workflow **must** register and use a confidential TEE handler. It does:
[`packages/plugins/cre/src/index.ts`](../../packages/plugins/cre/src/index.ts), `initWorkflow`,
`cre.handlerInTee(...)`.

The Confidential Workflow must run a meaningful part of the application, not a token gesture.
The enclave makes the only decision the product has: whether and where to move the position.

Evidence may be *"either a Confidential Workflow simulation using the CRE CLI or a live
deployment on the CRE network"* — the simulation qualifies, which is what `rehearse.sh`
produces. A deployment additionally needs Confidential Workflows beta access, which is a
Chainlink gate, not a hackathon requirement.

## Official references

| Source |
|---|
| https://docs.chain.link/cre |
| https://docs.chain.link/cre-templates/hello-confidential-workflows |
| https://github.com/smartcontractkit/cre-templates |
