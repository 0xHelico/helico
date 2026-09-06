# The swap conversation, in the backend

Issue: [#99](https://github.com/0xHelico/helico/issues/99), the half that is not the enclave's.
The re-centre reasoning belongs inside the CRE handler and is #101; this is the other half, a
conversation with a person, which the chain does not enforce and the enclave has no business
holding.

## What it does

One endpoint turns a sentence into a **validated swap intent**, or into a question back.

```
POST /api/swap/intent
{ "message": "swap half an ETH into USDC on arbitrum" }

200
{
  "reply": "Swapping 0.5 ETH into USDC on Arbitrum One.",
  "intent": {
    "chainId": 42161,
    "tokenIn":  { "symbol": "ETH",  "address": "0x0000…0000", "decimals": 18 },
    "tokenOut": { "symbol": "USDC", "address": "0xaf88…5831", "decimals": 6 },
    "amountIn": "0.5",
    "amountInWei": "500000000000000000"
  }
}
```

When something is missing it answers with `intent: null`, a `needs` list, and a reply that asks
for exactly that. It never signs, never sends, and never quotes: the intent is what
`@helico/plugin-uniswap` already takes to build calldata, and that package stays the only thing
that talks to Uniswap.

## The rule that makes it safe

**The model proposes; the backend checks.** That is the same discipline as the vault, and it is
the reason this can be exposed to a person at all.

The model is asked for a small JSON object and nothing else. Then, before anything leaves the
process:

- the chain must be one this repository knows;
- both symbols must resolve in a token registry **committed to the repository**, so an address
  can only ever be one the project put there, never one a model produced;
- the two tokens must differ;
- the amount must parse as a positive decimal within the token's decimals, and convert to an
  integer of base units without loss.

Anything else is a refusal with a reply that says which part failed. A confused model can ask a
clarifying question or be rejected; it cannot invent a token address, and it cannot move money,
because nothing here can move money.

## Cost, which is a real hazard

An unauthenticated endpoint that calls a paid model is a way to spend someone else's money. So:

- the route is **off unless configured**. Without `BE_LLM_API_KEY` it answers `503` the way
  writes do without an admin token. No stub, no fake reply, no pretending.
- a per-IP token bucket, and a process-wide daily ceiling on calls. Both are in memory, which is
  right for one process and honest about what it is: this is a rate limit, not a billing system.
- the deployed instance ships with the feature **off**. Turning it on is a decision about money,
  so it is the owner's, and the README says which variables do it.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `BE_LLM_BASE_URL` | `https://api.openai.com/v1` | any OpenAI-compatible endpoint |
| `BE_LLM_API_KEY` | empty | empty disables the route |
| `BE_LLM_MODEL` | `gpt-4o-mini` | the model asked for the JSON |
| `BE_LLM_TIMEOUT` | `20s` | one call to the model |
| `BE_SWAP_RATE_PER_MIN` | `6` | per IP |
| `BE_SWAP_DAILY_MAX` | `500` | process-wide ceiling |

## Shape

```
internal/swap/tokens.go   the registry: chains, symbols, addresses, decimals
internal/swap/intent.go   the checks above, and base-unit conversion
internal/swap/llm.go      an OpenAI-compatible chat client asking for JSON
internal/swap/service.go  message in, reply and intent or needs out
internal/httpapi          the route, the limiter, the 503 when unconfigured
```

## Verification

Every address in the registry was checked against Arbitrum One before it shipped, with
`symbol()` and `decimals()` over `eth_call`:

| Ticker used | Address | The contract says |
|---|---|---|
| WETH | `0x82aF…Bab1` | `WETH`, 18 |
| USDC | `0xaf88…5831` | `USDC`, 6 |
| USDT | `0xFd08…Cbb9` | **`USD₮0`**, 6 |
| ARB | `0x912C…6548` | `ARB`, 18 |

The one mismatch is real and is written down rather than smoothed over: Tether on Arbitrum
reports `USD₮0`, which nobody types, so `USDT` is the ticker in conversation and the address is
Tether's. `ETH` is the zero address, which is how Uniswap v4 names the native coin.

Table tests over the checks, with a fake model served by `httptest`: a full intent, a missing
amount, an unknown symbol, identical tokens, an amount with too many decimals, junk from the
model, a slow model, the unconfigured 503, and the limiter's 429. Then real calls against an OpenAI-compatible endpoint, with the key from a local file rather
than this repository. Four messages, one process, `gpt-4o-mini`:

| Message | Answer |
|---|---|
| "swap half an ETH into USDC" | intent: 0.5 ETH → USDC, `500000000000000000` base units, USDC's registry address |
| "I want to move some ARB into stablecoins" | no intent; "What amount of ARB do you want to swap?", needs `amount` |
| "swap 2 ETH into mooncoin" | no intent; `"MOON" is not a token I know on Arbitrum One; I know ETH, WETH, USDC, USDT, ARB.` |
| "buy 100 USDC with ether" | no intent; "How much ETH are you giving?", needs `amount` |

The third is the one worth keeping: the model produced a token that does not exist, and the
refusal came from the registry rather than from the model changing its mind.

The fourth shows a limit rather than a fault. This is exact-input only, so "buy 100 USDC" is
answered with a question about the ETH side instead of being turned into an exact-output swap.
That is written in the README rather than smoothed over.

## Prompt, verbatim in translation

- "Continue, you execute." — after a report listing this as the piece of #99 nobody had started,
  with the earlier instruction that the backend exists for the AI side.
