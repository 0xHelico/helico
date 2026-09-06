# The enclave explains itself

Issue: #99. The other half — a swap conversation in `apps/be` — is not this.

## Problem

The workflow decides whether and where to move a position, and says so in a string built by
`switch`: `HOLD (cooldown)`, `RECENTER 94520..94720`. Correct, and unreadable to the person
whose money it is. Nothing tells the owner *why* their liquidity moved.

## Why this can only live in the enclave

From the Chainlink bootcamp, on how CRE handles an HTTP read:

> A **non-confidential** workflow will read the API **10 times and come to a consensus**.
> A **confidential** workflow will read it **once and trust that single result**.

Ten DON nodes asking a language model the same question get ten different answers, and there is
no meaningful mean or median over free text. **A model cannot run in a normal CRE workflow at
all.** `handlerInTee` is not a nicer place to put this; it is the only place it can go.

That also settles what the Confidential Workflow is doing here. It was already reading the
chain and holding the mandate's thresholds. Now it holds a second private input — the model
credentials — and produces something no ordinary workflow could produce.

## Shape

`src/ai.ts`, one function, called after `decide()` and before the report is built.

```
decide()  ->  Outcome            (unchanged, still the only thing that moves money)
   |
   +-> explain(runtime, config, outcome, state, mandate)  ->  string | undefined
```

**The model does not decide anything.** It is handed the verdict and writes prose about it.
Every rule is still checked in `decide()` and again on chain by the vault, and #89 means the
position cannot even be swapped for another. A confused model can produce a confusing sentence
and nothing else — the reason string is not an input to any check.

Transport is the `confidential-http` capability (`ClientCapability.sendRequest`,
`httpRequest(...)` from the SDK's helpers), not `fetch`. Credentials come from
`runtime.getSecrets()`, the same door the mandate thresholds and the agent key already use, so
they exist only inside the enclave.

## The router, measured rather than assumed

`9router.godza.site`, OpenAI-compatible, two auth layers that both want `Authorization`:

| Layer | How |
|---|---|
| nginx | `Authorization: Basic base64(user:pass)` |
| application | `x-api-key: sk-…` |

Sending the app key as `Bearer` overrides the Basic header and everything 401s. That cost an
hour; it is why the header names are in this document.

`"stream": false` is required. Several models stream `data: {...}` SSE by default and a JSON
parser sees garbage.

## Models, chosen by testing all sixteen on two scenarios

Scenario A is a move; scenario B is a hold where the position is **in range** *and* the cooldown
has 40 minutes left — both true, and a good answer names both.

| | Model | Result |
|---|---|---|
| Primary | `ag/claude-opus-4-6-thinking` | The only one to name the ARB-only holding, the 100 bps floor, the 200-tick width, the cooldown **and** the 50 % retention floor. In B, the only one to give cost as the reason for holding. 11 s. |
| Fallback | `ag/gemini-3-flash` | Names range and cooldown in B. 7 s. Used when the primary errors or times out. |

**Rejected on accuracy:** `ag/gpt-oss-120b-medium` invented a rule we do not have — *"the
mandate only triggers changes when the tick exits or approaches the edges of the range"*. A
model that fabricates our own product rules to the user is worse than one that says nothing.

**Rejected as broken:** `ag/gemini-3.5-flash-{high,low,extra-low}` and `ag/gemini-3-flash-agent`
return `Gemini 3.5 Flash is no longer available…` — three of them with `finish_reason: "stop"`
and no completion tokens. A router notice, presented by the API as a successful answer.

## Three guards, each earned today

1. `finish_reason !== 'stop'` → discard. `gemini-pro-agent` spent 207 of 220 tokens thinking and
   returned nine, mid-sentence, with no error.
2. `completion_tokens` missing or zero → discard. That is what the four broken models look like.
3. The text matches a known router notice → discard.

A discarded explanation is not an error. The verdict stands and the report goes out without
prose, because the prose was never load-bearing.

## How to verify

1. `bun test packages/plugins/cre` — the fake runtime answers `sendRequest`, and each guard has
   a test that fails without it.
2. A recorded response from each of the four broken models is a fixture, so the guards are
   tested against what actually came back rather than what I imagine it looks like.
3. `cre workflow simulate` through `apps/cre` with the three secrets set: the log carries a
   sentence about the real position on the fork.

## Not in this change

- The reason string does not go on chain. Bytes cost gas and the vault has no use for prose;
  it belongs in the run log and, later, in whatever the user reads.
- `apps/be` and the swap conversation. Different trust boundary, different owner.
