# CRE execution evidence — 7 September 2026

> **The script this records no longer exists.** `apps/cre/rehearse.sh` rehearsed the Uniswap v4
> vault path, which CRE stopped driving on 8 September; `HelicoVault` and the two scripts the
> rehearsal called were deleted in #247, and the script itself in the change that added this note.
> The transcript below is kept as the record of a run that happened — it cannot be reproduced from
> this repository, and `apps/cre/rehearse-idle.sh` is the one that can.

Chainlink's prize asks for a successful execution shown through a CRE CLI simulation or a live
deployment. This is the simulation, recorded from `apps/cre/rehearse.sh` — the script in this
repository, not a throwaway project outside it, which is what issue #21 was opened about.

Run at commit `f73f599`, against a local fork of Arbitrum One at block **502695288**.

## Reproducing it

```sh
cd apps/cre
cp .env.example .env    # public anvil keys; the AI secrets can stay as they are, see below
./rehearse.sh
```

Needs `anvil`, `cast`, `forge`, `cre` and `jq` on the path, and an Arbitrum RPC that serves
archive state — the script defaults to `https://arb1.arbitrum.io/rpc`, which does. Several
public endpoints refuse historical state with `metadata is not found` and the fork will fail
in step 1.

Versions this run used:

| | |
|---|---|
| CRE CLI | v1.32.0 |
| `@chainlink/cre-sdk` | 1.19.1 (pinned in both `apps/cre` and `packages/plugins/cre`) |
| anvil / forge | 1.5.1-stable |
| bun | 1.3.14 |

The script forks at chain **head**, so a later run gets a different block, a different pool tick,
and different NFT ids. The digits below are one run's; what has to hold at any height is in
[Checking the numbers](#checking-the-numbers).

## What the run produced

```
== 1/6  fork Arbitrum One on :8546
forked at block 502695288

== 2/6  deploy the vault, pointed at the mock forwarder
vault    0x4168C0d99BF376aDb3cb6A3DbfA562b2c96f3944
forwarder 0xd770499057619C9a76205fD4168161cf94Abc532

== 3/6  fund the owner on the fork
ARB      1000000000000000000000 [1e21]

== 4/6  mint a position that is out of range, and commit the mandate
  tick now       96165
  token id       202992
  range lower    94960
  range upper    95160
  liquidity      86282244714123153414
  0xe43ef21b31ef6c5e044fdaa2661fd1f5061adbbde698cf5cf4c40fb7d52e7be3

== 5/6  point the workflow at what was just deployed
{"vault":"0x4168C0d99BF376aDb3cb6A3DbfA562b2c96f3944","mandateHash":"0xe43ef21b31ef6c5e044fdaa2661fd1f5061adbbde698cf5cf4c40fb7d52e7be3","owner":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","delivery":"forwarder"}

== 6/6  simulate the workflow, broadcasting through the forwarder
✓ Workflow compiled
  Binary hash: 8cc0c0a009726f06fd8ba9fd1c6cb5eb07e26de8f282872382028274c7d566c5
  Config hash: 06ff1eaa8fe119780445851be6dafeee71183c35d70092f60934490136e707da
[SIMULATION] Running trigger trigger=cron-trigger@1.0.0
╭────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ Trigger requested TEE Execution your trigger will run in one of the following Tees:                │
│     - AWS Nitro in us-west-2                                                                       │
│ The simulator is not a real TEE, and is meant to debug.                                            │
╰────────────────────────────────────────────────────────────────────────────────────────────────────╯

✓ Workflow Simulation Result:
"RECENTER 96070..96270 tx 0x6fb4635b1514dbed31f801ea27c220a43a834156fe3cf8222a7ccc4cd642718f"

== what the fork says now
tx         0x6fb4635b1514dbed31f801ea27c220a43a834156fe3cf8222a7ccc4cd642718f
position   202992 -> 202993
owner      0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
liquidity  81336344586474014490 [8.133e19]
vault ETH  0
vault ARB  0

== again, to show the cooldown refuse it
✓ Workflow Simulation Result:
"HOLD (cooldown)"
```

Full log elided only where the CLI repeats its limits banner; nothing else was cut.

## Checking the numbers

The point of writing them down is that a reader can check the workflow obeyed the mandate rather
than took the reader's word for it. The mandate committed in step 4 is the one in
`apps/cre/.env.example`: `SECRET_MANDATE_RANGE_WIDTH_TICKS=200`,
`SECRET_MANDATE_MIN_IMPROVEMENT_BPS=100`, `SECRET_MANDATE_COOLDOWN_SECONDS=3600`,
`SECRET_MANDATE_MIN_RETAINED_BPS=5000`, `SECRET_MANDATE_EXPIRY=1791244800`.

**The position had genuinely drifted.** Tick 96165 against a range of 94960..95160 — above the
upper bound, so the position was earning nothing. That is the condition the workflow exists for,
and step 4 constructs it deliberately rather than waiting for the market to provide it.

**The new range is the one the mandate dictates.** `decision.ts:112` computes
`nearestUsableTick(tick - floor(width / 2), tickSpacing)`: `96165 - 100 = 96065`, rounded to the
pool's tick spacing gives **96070**, and the upper bound is `96070 + 200 = 96270`. The spacing is
not configured — it is read off the pool key on-chain (`chain.ts:50` and `chain.ts:65`, reaching
the decision at `index.ts:145`) — and for this pool it is 10, which is why every tick in the
transcript is a multiple of 10. That is the
range in the result string, to the tick. The width is exactly 200 — the vault rejects any other
(`decision.ts:69`), so an off-by-one here would have reverted rather than mis-executed.

**The re-centre actually landed.** Position 202992 was burned and 202993 minted to the owner, not
to the vault. This is the check that matters most: the forwarder calls the vault inside a `try`,
so a reverting `onReport` is swallowed and the outer transaction still succeeds. Neither the
transaction hash nor a green receipt says anything about whether a position moved — only the
position does, which is why `rehearse.sh:85-94` reads it back and prints the revert reason when
it has not moved.

**The mandate's floor on value was respected.** 81336344586474014490 / 86282244714123153414 =
**9427 bps retained** against a floor of 5000. The ~5.7% lost is the swap crossing the pool to
rebalance the two sides, which is real cost, not rounding.

**The vault kept nothing.** `vault ETH 0`, `vault ARB 0` — everything the burn released went into
the new position. A non-zero balance here would mean value stranded in the contract.

**The cooldown is enforced.** The second run, seconds later, returns `HOLD (cooldown)` against
`COOLDOWN_SECONDS=3600`. The workflow refusing itself is worth as much as the workflow acting.

## `handlerInTee`

Chainlink's checklist requires the workflow to register through `cre.handlerInTee`. It does, at
`packages/plugins/cre/src/index.ts:307`, and the CLI's own banner in the transcript above is the
independent confirmation: the simulator prints *"Trigger requested TEE Execution"* and names
AWS Nitro in us-west-2 only for a trigger registered that way.

## The AI step, and why there is no prose in the result

`config.staging.json` sets `aiUrl`, so the workflow did call the model — and the call failed,
because `.env.example` ships `SECRET_AI_USERNAME`, `SECRET_AI_PASSWORD` and `SECRET_AI_API_KEY`
as placeholders (`replace-me`). That is why the result string is bare, with no ` — because …`
clause after it.

This is the designed behaviour, not a degraded run. The explanation is never load-bearing
(`index.ts:232-237`): a missing or rejected answer changes no decision, and the report goes out
without prose. A judge cloning the repository gets exactly this — the verdict, unexplained — and
that is the honest default, since the credentials are ours to hold.

The confidential HTTP call is what makes the model usable at all. A non-confidential CRE workflow
reaches consensus by comparing observations across nodes, and free text has no median, so the
reasoning can only run inside the enclave. That is the meaningful work Chainlink's second
requirement asks for, not a token gesture.

## What this does not prove

Stated plainly, because claiming more than a run supports is the one thing the rules punish with
disqualification rather than a deduction:

- **The simulator is not a TEE.** It prints the banner and honours the shape, but nothing is
  attested. `handlerInTee` is proven registered, not proven enclaved.
- **The mock forwarder verifies no DON signatures.** `0xd7704990…` accepts any caller. This shows
  the delivery path and the vault's execution under a real report payload; it does not show DON
  authorisation.
- **Nothing is deployed.** `config.production.json` still carries zeroed `vault`, `owner` and
  `mandateHash`. Deployment is tracked in #85 and is not covered here.
- **The AI path is untested in this run**, for the reason above. Its unit tests cover the
  guards; this rehearsal does not exercise a live model.

## Known gap

`rehearse.sh` forks at head, so two runs never produce identical digits. Pinning
`--fork-block-number` would make the transcript byte-reproducible and would cost one flag. Left
alone here because `apps/cre` is not this change's to edit.
