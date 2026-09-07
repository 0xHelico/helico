# Demo video: script and shot list

Issue: #22. Target **3:30**, inside the 2–4 minute window. 720p or better.

> **Rewritten 7 September**, when the three submitted tracks became **Chainlink, 1inch and The
> Graph**. The previous script opened on *"A Uniswap v4 position only earns while the price is
> inside its range"* and stayed there — a good script for a submission we are no longer making.
> The v4 work is still in the repository and still tested; it is no longer what the video is
> about. Kept in git history rather than deleted, so the change is legible.

## The rules that reject an upload

| Rule | Consequence |
|---|---|
| Under 2:00 or over 4:00 | Upload rejected automatically |
| Below 720p | Upload fails |
| **Sped up** | **Automatic disqualification** |
| Recorded on a phone | Rejected |
| Text-to-speech or AI voiceover | Rejected |
| Music with on-screen text instead of speech | Rejected |

Editing to cut waiting is allowed. Speeding up the footage is not. Where something takes two
minutes, cut to the result — do not accelerate the clip.

## What each shot depends on

The script assumes work that is not all finished. Every shot that depends on something says so,
and each has a fallback that is true today. **Record the fallback version first**: it is the one
that exists, and #22 asks for a full-length take by **11 September** rather than the night before.

| Shot | Needs | Fallback if it is not there |
|---|---|---|
| 3 — the swap | `HelicoMandateSwap` deployed to Arbitrum One | the fork test, `forge test --match-contract ForkMandateSwapTest -vvvv` — **the four `v`s are the shot**, see below |
| 4 — the query | the subgraph deployed and indexing | skip the shot; give its 25 seconds to shot 5 |
| 5 — the enclave | nothing, works today | — |

A shot that has to fall back is not a weaker video. A shot that claims something untrue ends the
submission.

### Pre-flight, run 7 September

Checked so the first take is not spent discovering these. Re-check on the day — the point of the
list is that it changes.

| | State on 7 September |
|---|---|
| `app.helico.site` (shot 0) | 200. The chat path answers: "swap 1000 USDC to WETH" returns the checked intent, same pair the fork test uses |
| `helico.site`, `api.helico.site/healthz` | 200 |
| Shot 3, the swap | **Recordable in full today.** The fork test runs against Aqua at `0x1111113C…` — the address 1inch confirmed in `#partner-1inch` and lists in their README. It was `0x499943E7…` until 8 September, taken from a README that turned out to be five months stale, so check this cell against the code before recording rather than trusting it |
| Shot 3, at `-vv` | **Would have cost a take.** One `[PASS]` line, no balances. Use `-vvvv` |
| Shot 4, the subgraph | Not deployed. Fall back as written |
| Shot 5, the enclave | Runs. A recorded rehearsal with its numbers checked is in [`docs/evidence/2026-09-07-cre-rehearsal.md`](evidence/2026-09-07-cre-rehearsal.md) |
| "Deployed", "live", "in production" | Still says nothing that is deployed except Aqua itself, which is 1inch's |

## Shot list

### 0:00–0:20 — What it is

*Screen: the app's front door, `app.helico.site`.*

> An agent that trades for you has to be trusted with your money. This one does not.
>
> You write the rules on chain. The contract refuses anything outside them. And your tokens
> never leave your own wallet — not into a vault, not into an escrow, not for a moment.

No logo animation, no title card. Under 20 seconds, as the guidance asks.

### 0:20–0:55 — The mandate is the strategy — 1inch

*Screen: `contracts/src/HelicoMandateSwap.sol`, the `SwapMandate` struct.*

> This is built on 1inch Aqua, where liquidity stays in the maker's wallet and the protocol only
> keeps a ledger of what an app may spend.
>
> Aqua never reads these bytes. It files them under their hash, so every rule here is enforced
> in this contract or nowhere. An expiry. One named agent. And a ceiling, per token, on how much
> may leave.

*Scroll to `_settle`, with `AQUA.pull` and `_safeCheckAquaPush` both visible.*

> Payment is verified after delivery, in the same transaction. If the taker does not pay, the
> delivery is undone with it.

### 0:55–1:20 — The question the chain cannot answer — The Graph

*Screen: `lib/aqua/src/Aqua.sol`, the balances mapping and the four events.*

> Before the agent can act, it has to know what it is allowed to do. That turns out to be the
> hard part.
>
> This mapping is private and four levels deep, so nothing can enumerate it. None of these events
> index anything, so logs cannot be filtered by maker. And reading a balance needs a hash you
> already have.

*Screen: the subgraph query, and its result.*

> So "which mandates does this wallet have, and what is left in each" has no on-chain answer at
> all. The Graph is not making this faster. It is the only way to ask.

> **Depends on:** the subgraph deployed and indexing. If it is not, cut this shot and say the
> sentence about the mapping over shot 2 instead — the point is worth keeping even without the
> query on screen.

### 1:20–2:00 — Where the decision happens — Chainlink

*Screen: `packages/plugins/cre/src/index.ts`, `cre.handlerInTee` visible.*

> The decision runs inside a Chainlink CRE confidential workflow — in an enclave. The mandate
> thresholds are secrets released only in there, because they are your strategy, and now the
> Graph query key is a second private input alongside them.
>
> What comes out is a verdict and the hash of the mandate it was decided against. The contract
> refuses any verdict whose hash is not the one it stored.
>
> So the enclave can be wrong and it still cannot move you outside your own terms.

### 2:00–2:50 — Run it

*Screen: terminal.*

Speak over the run. Cut the waiting, never speed it up.

> Here is the whole path against Aqua on Arbitrum One, at the address 1inch publishes.

*Screen: the swap completing — the maker's wallet balances before and after, and the recipient's.*

> **Run it as `forge test --match-test test_ARealSwapMovesTokensStraightOutOfTheMakersWallet -vvvv`.**
> At `-vv` this test prints one green `[PASS]` line and nothing else, which is not the screen this
> shot describes. At `-vvvv` the trace is 83 lines and contains the whole story in the two
> `Transfer` events: `Alice -> Bob, 296147410319118389` for the WETH, and
> `PayingTaker -> Alice, 1000000000` for the thousand USDC. Neither Aqua nor `HelicoMandateSwap`
> appears as a `from` or a `to` on any transfer — which is the sentence below, on screen, checkable
> by a viewer who pauses.

> A thousand USDC in, and the WETH goes straight out of the maker's wallet to the recipient.
> Aqua held nothing. The app held nothing. There was never a moment when anyone else had custody.

*Screen: the same swap one wei over the ceiling, refused by name.*

> Same four `v`s: `forge test --match-test test_TheCeilingStillRefusesOnTheRealChain -vvvv`. The
> line to frame is `MandateCeilingExceeded(0x82aF4944…, 296147410319118389, 296147410319118388)` —
> asked for, then permitted, one wei apart.

> Ask for more than the mandate allows and it is refused — with the number that was asked for and
> the number that was permitted.

### 2:50–3:15 — Why it is safe

*Screen: `contracts/README.md`, the limitations section.*

> A rogue agent can trade inside your terms and nothing else. It cannot exceed the ceiling, it
> cannot act after the expiry, and it was never able to take custody in the first place.
>
> Docking the mandate ends it, needs nobody's permission, and nothing we run can block it.

### 3:15–3:30 — What is and is not done

*Screen: the README's caveat block.*

> Every guard in this contract was deleted one at a time to check a test noticed. Eleven of
> eleven did.
>
> The enclave ran through the simulator, not a real TEE, and Chainlink's own criteria accept
> that. Every number in this video is in the repository with the command that reproduces it.

End on the repo URL. No outro music.

## Before recording

- [ ] `bun install`, `cp apps/cre/.env.example apps/cre/.env` — the run must be warm, so the first
      take is not spent on a dependency download
- [ ] `ARBITRUM_RPC_URL` set, and the fork suite run once beforehand: it forks `latest`, so the
      numbers differ every time and the spoken figures must match the take that ships
- [ ] Terminal font large enough to read at 720p
- [ ] Close anything with a wallet, a key, or a private repository in it
- [ ] One rough full-length take by **11 September**, two days before the deadline

## What must not be said

- **"Deployed", "live", or "in production"** about anything that is not — check each one on the
  day, because this list changes as things land
- **"Audited"** — twelve AI agents reviewed the vault, and that is not an audit
- **"Runs in a TEE"** — it runs in the simulator, which announces that it is not a TEE
- **Anything about Uniswap being one of our tracks** — it is not, and the video should not imply
  a fourth
- Any figure not read off the take being recorded
