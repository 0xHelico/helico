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

| Shot | Needs | State on **8 September** |
|---|---|---|
| 3 — the swap | `HelicoMandateSwap` deployed to Arbitrum One | **satisfied.** Deployed and verified at [`0xA16D3138…87Ed`](https://arbiscan.io/address/0xA16D313816247628DeB7d89DC7a3Cf4aDb5287Ed#code). The fork test is no longer the fallback, it is the second angle |
| 4 — the query | the subgraph deployed and indexing | **satisfied.** Deployed, synced, serving the canonical Aqua |
| 5 — the enclave | nothing, works today | — |

A shot that has to fall back is not a weaker video. A shot that claims something untrue ends the
submission.

### Pre-flight, re-run 9 September

The table below supersedes the 8 September one wherever they disagree. Two rows moved in opposite
directions, which is the pair worth reading rather than skimming: one would have put a false claim
in the video, the other would have given away a requirement we meet.

| | State on 9 September, measured |
|---|---|
| **Deployed, read back from the chain** | Five contracts as of 9 September. `HelicoAccountFactory` `0x01CC7d9F…E081` (3,883 bytes), `HelicoAccount` implementation `0x0842BB3f…4847` (8,779), `HelicoMandateSwap` `0xA16D3138…87Ed` (7,707), `HelicoAquaSwapVMRouter` `0xb8c9f14d…c3be` (18,863), `HelicoOracleBoard` `0xeb480C09…C760`. The router answers `AQUA_YIELD_COVER_OPCODE()` → **34**, which is the sentence about the added instruction being *on chain* rather than in a file |
| **Deployed since the 8 September table** | `HelicoOracleBoard` `0xeb480C09…C760` (verified), the second Aqua app — priced from Chainlink, braked by its own inventory, for a maker holding **one** token. **Nothing has shipped a board to it**, so it is a deployed contract with no positions on it. Say *deployed and verified*; do not say anyone is using it |
| **The workflow is not the simulator** | The deployed workflow runs on Chainlink's DON. See the split rule under *What must not be said* — this is the row that changed what is sayable |
| The four sites | `helico.site`, `app.helico.site`, `api.helico.site/healthz` 200, `docs.helico.site` 308. `bun run --filter @helico/app prod` is now **23 checks** and passes, including the API's own headers |
| **New shot available — the escape hatch** | It had no button at all this morning. Typing *"take everything back to my wallet"* into the chat now offers the sweep, and pressing it empties the account to the owner. For the 2:50 shot this is the product doing the safest thing it can do, on camera, rather than a test asserting it |
| **New shot available — the checks tree** | Each answer now shows the functions that ran to produce it. A refusal ending on `Chain.Token "MOONCOIN" is not in the registry — refused` says more in five seconds than the same refusal as prose |
| **New line available — 1inch** | A concentrated band paid out of a lending position: **10,183 USDC against 8,600 with the band removed**, same account, same trade ([`ForkSwapVMConcentrateCover.t.sol`](../contracts/test/ForkSwapVMConcentrateCover.t.sol)). Fork evidence, so say *"measured on a fork"* |
| The account | **Still none opened on mainnet.** `eth_getLogs` on the factory returns zero. The caveat from the 8th is unchanged and is still the honest sentence |

### Pre-flight, re-run 8 September

Checked so the first take is not spent discovering these. Re-check on the day — the point of the
list is that it changes, and between the 7th and the 8th four rows did.

| | State on 8 September, measured |
|---|---|
| The three sites | `helico.site`, `app.helico.site`, `api.helico.site/healthz` all 200. `bun run --filter @helico/app prod` runs 20 checks against them and passes |
| **"Nothing of ours is deployed"** | **No longer true, and this is the biggest change since the 7th.** Live and verified on Arbitrum One: the account factory `0x01CC7d9F…E081`, the account implementation, `HelicoMandateSwap`, and the SwapVM router. The subgraph is on Studio. The workflow is registered as `helico-production` on DON `zone-a` |
| The caveat that replaces it | **No account has been opened on the live chain**, so the deployed workflow reaches its logic and holds every run. Say that, not "not live" — "not live" is now a false claim rather than a modest one |
| Shot 2, the chain refusing | **New, and worth a take.** `bun scripts/check-subgraph.ts` now asks the chain before it asks the index: it fetches `Shipped` logs and counts the topics. One topic, the signature — so nothing is indexed and nothing can be filtered. That is the shot's own sentence, measured on camera instead of read off a source file |
| Shot 3, at `-vv` | Unchanged: one `[PASS]` line and no balances. Use `-vvvv` |
| Shot 4, the numbers | Re-run `bun scripts/check-subgraph.ts` on the day and read them off that run. As of the 8th: 49 mandates for the busiest maker, 11 still active, five tokens |

### The shot that became possible on the 8th

The app can now open a real account, nominate the agent and permit a market — all from the page,
all owner-only, all on Arbitrum One. `open()` costs **0.00000703 ETH**, and the whole path is
checked against the chain by `bun run --filter @helico/app e2e:account` on a fork.

**Doing it live on camera is the strongest thirty seconds available**, because it is the product
being used rather than described, and because it turns the honest caveat above into a past tense:
the moment the account exists and names the agent, the enclave picks it up on its next run with
no redeploy. If you would rather not send a transaction while recording, open it beforehand and
show the page reading it back — the account is still real either way.

### Pre-flight, run 7 September — kept for the rows that have not moved

The table above supersedes this one wherever they disagree. It stays because most of it is still
true, and because the disagreements are the interesting part.

| | State on 7 September |
|---|---|
| `app.helico.site` (shot 0) | 200. The chat path answers: "swap 1000 USDC to WETH" returns the checked intent, same pair the fork test uses |
| `helico.site`, `api.helico.site/healthz` | 200 |
| Shot 3, the swap | **Recordable in full.** The fork test and `DeployMandateSwap.s.sol` both pin Aqua at `0x1111113CCf…` — the address 1inch confirmed in `#partner-1inch`, exports from `@1inch/aqua-sdk`, and has in the deployed `AquaSwapVMRouter`'s bytecode. It was `0x499943E7…` until 8 September, taken from the README inside the `v1.0.0` tag we vendor — a March snapshot, which is what a tag is; 1inch's `main` README names the right one. That address is a real Aqua with no event since block 451,737,844 ([#165](https://github.com/0xHelico/helico/issues/165)). The sentence *"the Aqua 1inch deployed"* is true on camera now, and was not when this row was first written — check the cell against the constant before recording rather than trusting either |
| Shot 3, at `-vv` | **Would have cost a take.** One `[PASS]` line, no balances. Use `-vvvv` |
| Shot 4, the subgraph | **Recordable.** Deployed and synced 8 September, serving the Aqua 1inch uses: 47 makers, mandates from block 485,793,304. It spent a day pointed at the retired deployment and looked healthy the whole time ([#181](https://github.com/0xHelico/helico/issues/181)), so re-run `bun scripts/check-subgraph.ts` on the day and read the numbers off that run |
| Shot 5, the enclave | Runs. A recorded rehearsal with its numbers checked against the policy is in [`docs/evidence/2026-09-08-idle-capital-rehearsal.md`](evidence/2026-09-08-idle-capital-rehearsal.md). The 7 September file records the vault path the workflow no longer drives |
| "Deployed", "live", "in production" | **Superseded by the 8 September table above.** On the 7th nothing of ours was deployed; on the 8th four contracts, the subgraph and the workflow are |

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

> The decision runs inside a Chainlink CRE confidential workflow — in an enclave. What it decides
> is how much of your capital should be earning and how much has to stay liquid to cover a swap.
> The thresholds are secrets released only in there, because they are your strategy.
>
> What comes out is a signed statement and the call it is about. And the authority that call uses
> has no recipient parameter anywhere in it — the agent can choose where your money works, and has
> no way to send it somewhere else.
>
> So the enclave can be wrong and it still cannot take anything.

*Screen: `HelicoAccount.supplyIdle` — frame the signature, which has no `to`.*

> **The shot is the function signature, not prose about it.** `supplyIdle(address pool, address
> asset, uint256 amount)`. A viewer who pauses can see there is nowhere for a destination to go.

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

*Screen: terminal, `cd apps/cre && ./rehearse-idle.sh`.*

> **This is the one shot that shows the whole product in one command.** It forks Arbitrum,
> deploys the account factory, opens an account at an address computed before it existed, funds it
> with real USDC, and lets the enclave decide.

> Fifty thousand dollars arrives. The enclave decides forty thousand should be earning and ten
> thousand should stay liquid to cover a swap. It signs that, and the call lands.

*Screen: the last three lines of the run.*

> The line to frame is the last one: **the agent's own balance is zero.** A transaction that
> succeeds and moves nothing looks identical in a log to one that worked, so the balances are the
> only thing worth believing.
>
> Read the numbers off the take being recorded — it forks `latest`, so they change every run.

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

*Screen: the chat. Type "take everything back to my wallet".*

> And you can leave whenever you like. This is the product, not a test: the sweep sends every
> token to one address — the one this account was built for — and the call takes no recipient, so
> there is no version of it that sends anywhere else.

*Screen: `test_AnUpgradeCannotTakeTheAccountOrDeleteTheWayOut`, and its `[PASS]` line.*

> And the way out cannot be removed by us either. Every owner's contract can have its code
> replaced — that is how we fix a bug during a hackathon. So the exit does not live in the code
> that gets replaced. It lives in the proxy, and the owner is written into the bytecode.

> This test installs a deliberately hostile version that declares both of those functions and
> answers them in an attacker's favour. Ownership does not move, and the owner still withdraws
> everything.

### 3:15–3:30 — What is and is not done

*Screen: the README's caveat block.*

> Every guard in this contract was deleted one at a time to check a test noticed. Eleven of
> eleven did.
>
> The run you just watched went through the simulator, not a real TEE. The deployed workflow is
> a different thing — it registers a confidential handler and executes on Chainlink's DON every
> five minutes, and it is holding rather than acting because no account exists yet for it to
> manage. Every number in this video is in the repository with the command that reproduces it.

End on the repo URL. No outro music.

## Before recording

- [ ] `bun install`, `cp apps/cre/.env.example apps/cre/.env` — the run must be warm, so the first
      take is not spent on a dependency download
- [ ] `ARBITRUM_RPC_URL` set, and the fork suite run once beforehand: it forks `latest`, so the
      numbers differ every time and the spoken figures must match the take that ships
- [ ] `./rehearse-idle.sh` run once to warm it — it takes about two minutes, and it rewrites
      `apps/cre/workflow/config.staging.json`, so `git checkout` that file between takes
- [ ] An `.env` written before 8 September has the vault's `MANDATE_*` names and none of the
      `IDLE_*` ones. The script checks and names the whole missing list; the CRE CLI names one
      variable at a time
- [ ] Terminal font large enough to read at 720p
- [ ] Close anything with a wallet, a key, or a private repository in it
- [ ] One rough full-length take by **11 September**, two days before the deadline

## What must not be said

- **"Deployed", "live", or "in production"** about anything that is not — check each one on the
  day, because this list changes as things land. As of 9 September **five** contracts are on
  Arbitrum One — the fifth, `HelicoOracleBoard`, landed that morning. The router is among them and
  its opcode reads back from the chain. What is still not deployable-and-used is a different
  sentence: nothing has shipped a board to the oracle app, so *"deployed"* is true of it and
  *"in use"* is not
- **"Audited"** — twelve AI agents reviewed the contracts, and that is not an audit
- **"Runs in a TEE"** — and this rule is now two rules, because the two things it covered came
  apart on 8 September. **The local rehearsal** (`rehearse-idle.sh`, which is what the footage
  shows) runs in the **simulator**, which prints that it is not a TEE, and against a **fork**.
  Never call that a TEE. **The deployed workflow** is a different thing: `helico-production` is
  registered in Chainlink's `WorkflowRegistry 2.0.0` on Ethereum mainnet and executes on DON
  `zone-a` every five minutes, reading a Vault DON secret, with consecutive `SUCCESS` in
  `cre execution list`.

  So do not say *"nothing runs in a TEE"* either — that is now an understatement that hands away
  the Chainlink track's first requirement. The provable sentence is **"the deployed workflow
  registers `handlerInTee` and runs on Chainlink's DON"**. Saying *"it runs in a TEE"* as our own
  claim is still wrong: that is Chainlink's claim about their infrastructure, not a measurement
  of ours
- **Anything about Uniswap being one of our tracks** — it is not, and the video should not imply
  a fourth
- **"The AI decides where your money goes"** — it does not. A model turns the verdict into a
  sentence the owner can read, and the verdict is computed before it is called and never reads its
  answer back. Say *"the enclave decides, and a model explains it"*
- **"It finds the best yield across protocols"** — half true, so say the half that is. It *does*
  compare live rates across the markets the owner permitted and move to the best when the gap
  clears a round-trip bar. Those markets are Aave-family only, and the reason is the interface:
  `ILendingVenue` carries Aave v3's own signatures — `supply(asset, amount, onBehalfOf,
  referralCode)`, `getVirtualUnderlyingBalance`, `getReserveAToken` — which neither Compound v3
  nor Morpho answers. **One half of that blocker is gone as of #296** and the other is not, so do
  not say either the old sentence or a new one: a share-priced receipt now converts correctly, but
  no adapter exists, nothing calls Compound, and `git grep` finds no Compound address anywhere in
  this repository. Say *"across the markets you permitted"*, not *"across protocols"*.
  `0xHelico/helico#179`
- **"The Graph tells the agent what to work on"** — no. What is true, and sayable: *the workflow
  asks The Graph how much the maker's mandates could demand, and sizes the liquid buffer to it.*
  It still reads the account's own balances over RPC. The distinction is small and a judge who
  knows the stack will hear it
- Any figure not read off the take being recorded
