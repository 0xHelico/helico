# The model comes through a router, and there are two of them

12 September 2026.

## What changes

The swap conversation asked OpenAI directly. It asks a [9router](https://github.com/decolua/9router)
instance instead, and a second one behind it when the first does not answer.

`BE_LLM_BASE_URL` has always been "any OpenAI-compatible endpoint", so most of this is
configuration rather than code. Two of the three code changes exist because the second endpoint
behaves differently from the first in ways that are not visible until it is tried.

## What was measured before anything was written

Both routers were asked this repository's own system prompt, twice each.

| | Endpoint | Model | Answer | Time |
|---|---|---|---|---|
| First | `ai.ifajar.dev/v1` | `fajar-openai/gpt-4o-mini` | correct | 1.3s, 2.2s |
| Second | `9router.godza.site/v1` | `ag/gemini-pro-agent` | correct | 6.3s, 7.1s |

Both produced the exact JSON shape the prompt asks for, including `amountUsd` for a dollar
amount. Neither needed the prompt changed.

Three things fell out of the measurement.

**The second endpoint sits behind an HTTP basic challenge.** A request carrying only
`Authorization: Bearer` comes back as nginx's own `401` page, before the router sees it. One
`Authorization` header cannot carry Basic and Bearer at once, so where basic credentials exist
they take the header and the key moves to `X-Api-Key`, which is the other place the router looks.

**It streams unless told not to.** Without `stream: false` in the body it answers
`text/event-stream`, and a run of `data:` chunks does not unmarshal into the one object the
client parses. `stream: false` is the OpenAI default, which is exactly why it was never sent.

**The timeouts were sized for the wrong model.** `BE_LLM_TIMEOUT` was 8s and `BE_REQUEST_TIMEOUT`
10s. A model that takes 7s barely fits the first and a chain of two cannot fit the second at all,
so a configured fallback would be cover that never runs. Per attempt is now 12s, the request is
30s, and startup refuses a combination where `timeout × models` does not fit.

## Security, because that is the point of the change

The threat is not the key leaking out of the repository. It is our endpoint being used to spend
the key.

| | Already true | Checked |
|---|---|---|
| Keys in the repository | none; `.env` is gitignored and `.env.example` carries names with empty values | `git check-ignore` |
| Keys in the browser | the chat goes through `apps/be`; the key never reaches a page | `GET /api/swap/config` returns `available` and a family name |
| Keys in a log or an error | the handler logs the upstream's message and answers with one sentence naming no host | both routers made to fail; the log searched for every secret |
| Someone else spending it | per-address token bucket plus a whole-process daily ceiling | seventh request in a minute refused |
| Forging the address counted | only `X-Real-IP`, which our nginx overwrites, and the socket. `X-Forwarded-For` is unused because an appended entry and a forged one are indistinguishable from inside the process | already written down in `limit.go` |

Two new things to keep that way.

**Basic credentials are a header, never part of the URL.** A request that never connects comes
back as a `*url.Error`, which prints the URL it was given. Credentials written into the userinfo
of a base URL therefore reach every log line and error string that value touches, including the
one the handler already refuses to send to a caller for exactly this reason.

**The reported model is the family, not the routing string.** A router's model reads
`fajar-openai/gpt-4o-mini`, and the part before the slash names the account the call is billed to.
Not a credential, and not something a public endpoint has any reason to publish.

## How it is verified

1. Unit tests on the fallback: a dead first endpoint falls through, a working one is not followed
   by a second call, an entry with no key is not an upstream, basic credentials take the header
   while the key moves aside, no basic credentials means an ordinary bearer token and no second
   copy of the key, `stream: false` is in the body, and the reported model is the family name.
   Each was run against a deliberately broken implementation to check it can fail.
2. A config test that two models must fit inside the request budget, and that an operator who
   writes a combination that cannot work is told at startup rather than quietly corrected.
3. The real endpoints, end to end, through `POST /api/swap/intent`: four messages against the
   first router, then the same with the first router's key invalidated so the second has to
   answer, then both invalidated to see what a caller is told.
