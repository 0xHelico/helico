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
| 3 — the swap | `HelicoMandateSwap` deployed to Arbitrum One | **satisfied.** Deployed and verified at [`0x0524a353…6041`](https://arbiscan.io/address/0x0524a353dfab33CD362593ae8e97707764Fb6041#code). The fork test is no longer the fallback, it is the second angle |
| 4 — the query | the subgraph deployed and indexing | **satisfied.** Deployed, synced, serving the canonical Aqua |
| 5 — the enclave | nothing, works today | — |

A shot that has to fall back is not a weaker video. A shot that claims something untrue ends the
submission.

### Pre-flight, re-run 12 September 16:40 UTC, after the money went back to work — **read this one first**

The layer below was written while the account held everything idle, and it says the withdrawal
is the story. It is half of it. Where they disagree, this one wins.

| | State, measured at block 504,453,076 and after |
|---|---|
| **Three moves, three transmitters, one policy hash** | `490081` supplied at block 504,035,561 (11 Sep, [`0x0668c698…`](https://arbiscan.io/tx/0x0668c698cf3d396e622a97bfa3e21016de44fb41863fa7cb69b47bd126f9ed27), `0x3A8dBD6b…`); `490158` withdrawn at 504,414,805 (12 Sep 13:55, [`0x6b37141b…`](https://arbiscan.io/tx/0x6b37141bf0357a7c7b16d7288336bebdb1c091f3f5e40901addfc421fe7fb1b5), `0xba218037…`); **`1487196` supplied at 504,453,076 (12 Sep 16:35, [`0x0beffeee…`](https://arbiscan.io/tx/0x0beffeee97ad8a0f11e19af59e763394d4838440796967357ef578299e1d3435), `0xf0ecfbfc…`)**. `HelicoAgent.Carried` carries `0x84e5626f…` on all three. **Sayable:** *"three moves, three different nodes carried them, and the policy they enforced never changed."* |
| **The withdrawal was the enclave being more careful than the app needed, and that is sayable** | It read the mandate on `HelicoMandateSwap` as a claim on the wallet. It is not one: that app settles a fill out of the venue inside the swap (`_cover`, and the receipt lines on the mandate are its permission). A SwapVM mandate *is* a claim on the wallet, and for those the floor still rises. The build deployed at 16:30 (`0x41d81450…` on Ethereum, workflow id `0x00fa897b…`) tells the two apart, and the next run put the capital back. **Sayable:** *"the first time it saw its own position it pulled the money out to be safe; we taught it that this app can pay from the venue, and it put the money back — with the position still live."* **Not sayable:** that it was a bug in the contracts or the index; both answered correctly, and the replay in `docs/deployments.md` shows the decision to the unit |
| **The account now** | `USDC 10000`, `hmUSDC 743598` shares = `1487196` USDC in Morpho. The mandate on Aqua is unchanged: active, `1497196` on USDC and on each receipt. This is the sentence the product is built on, on screen: **the mandate is live and the money behind it is earning** |
| **Do not wait for a move on camera — still** | The account is at its target split (10,000 liquid, the rest working) and the next runs say `HOLD (already at the target split)`. The evidence is the three transactions. Show the account, then Arbiscan, then the CRE execution page for `b00b1e7c…` whose `WriteReport` is the third one — the execution id is in the forwarder's `ReportProcessed` log, so dashboard and chain are provably the same run |
| **The workflow id changed and the record says so** | `Carried` in the third move carries `0x00fa897b…`, not `0x00f5df97…`. Both are in `docs/deployments.md`; a reader who checks the first two receipts against the third will see two ids, and the deploy record between them is the reason |
| **The yield line still holds** | `490158` back for `490081` in, 5.21% annualised over the first round trip. The third move has earned nothing measurable yet; do not quote a number for it |

What this changes in the shot list: **3:15 says the three moves and what the middle one taught
the enclave**, and the Graph shot keeps its hash — the withdrawal is still the transaction the
index caused. What it adds is the ending the layer below could not have: the money is back at
work and the position is live at the same time.

### Pre-flight, re-run 12 September 16:00 UTC, after the money came back

The layer below was written between the two halves of one round trip, and it names a balance the
screen no longer shows. Where they disagree, this one wins.

| | State, measured at block 504,442,990 |
|---|---|
| **The network moves it both ways, and that is the story now** | Two `IdleCapitalMoved` events exist on the live account and no others. `490081` **supplied** at block 504,035,561 (11 Sep 11:30 UTC, [`0x0668c698…`](https://arbiscan.io/tx/0x0668c698cf3d396e622a97bfa3e21016de44fb41863fa7cb69b47bd126f9ed27), transmitter `0x3A8dBD6b…`); `490158` **withdrawn** at block 504,414,805 (12 Sep 13:55 UTC, [`0x6b37141b…`](https://arbiscan.io/tx/0x6b37141bf0357a7c7b16d7288336bebdb1c091f3f5e40901addfc421fe7fb1b5), transmitter `0xba218037…`). **Sayable, and it is the shot:** *"the network decided to put it to work, and a day later the network decided to take it back out — different node, same workflow, and no key of ours in either transaction."* One direction is what a script can do; both is what an agent does |
| **It earned, and the number is on chain** | `490158` came back for `490081` that went in: **77 base units over 95,099 seconds, 5.21% annualised.** Sayable exactly like that, including that the principal was 0.49 USDC. **Not** sayable: any APY quoted off a rate feed — this is the one figure the two transactions prove by subtraction |
| **Why it came out is all three tracks in one chain, and this is the best thirty seconds available** | 13:54:27 — the owner ships a mandate to `HelicoMandateSwap` on **Aqua**, `1497196` of USDC ([`0x2ed147cf…`](https://arbiscan.io/tx/0x2ed147cfe956fe5f8fc9693acdcd3af2bbd8ce8b8ec3b5669cf5bbb9f219416c)). 13:55:21 — the enclave asks **The Graph** what that maker's live mandates could spend, gets `1497196`, raises the liquid floor to it, and **Chainlink's** DON writes the unwind that covers the shortfall to the unit: `1497196 − 1007038 = 490158`, and `490158` is what came out. **Sayable:** *"nobody told it to do that. It shipped a position on 1inch, and a minute later the network read the index, saw what the position could owe, and pulled the money out of Morpho to cover it."* Three logos, one arrow, two hashes |
| **And the number that moved it has no on-chain answer** | Aqua's `_balances` is `private` and four levels deep, and not one parameter of its four events is `indexed` — so *"what could this maker's mandates still spend?"* is unreachable by `eth_call` and by `eth_getLogs` alike. **Sayable, and it is the whole Graph argument:** *"this is not a dashboard reading the chain more prettily. The number the money moved on cannot be got from the chain at all."* The subgraph's own schema opens with this, so it is quotable on screen |
| **The account holds nothing at work** | `USDC 1497196`, `hmUSDC 0`. The row below saying it holds `10000 USDC and 490081 hmUSDC` is **retired**, and so is its closing line about the enclave *"holding because the account is already at its target split"* — there is no position; everything is idle |
| **Do not wait for a move on camera** | At 1.497196 USDC the vault's liquid floor is what decides, and an account this size sits under any floor worth setting. The evidence is the two transactions that already happened; a take that waits for a third one is a take that ends with the enclave saying `HOLD`. Show the account, then show Arbiscan |
| **The agent is still the contract** | `agent()` → `0x98c3979358A4e5086Da432CfE91F45aE2A854463`, and all four venues answer `permittedVenue → true`. Nothing about the nomination changed; the money moving out did not un-nominate anything |
| **The workflow that carried it is the one the registry holds** | `HelicoAgent.Carried` in the withdraw carries workflow id `0x00f5df9779…4735da40`, which is the id in `docs/deployments.md`. Worth saying, because it is the link between *"a workflow is registered"* and *"this transaction is that workflow"* — and it is readable from the receipt by anyone |

What this changes in the shot list: **3:15 says the round trip**, not the target split, and
**0:55–1:20 gains its proof.** The Graph shot has until now been *"here is a query that answers
what the chain cannot"*, which is true and is an argument. It is now *"here is the query, and
here is the transaction it caused"* — which is the same claim with a hash on the end of it.

The account on screen is idle, and that is the honest picture and a better one than a static
position: the point was never that money sits somewhere, it is that nobody pressed anything
either time.

**One caution on the causal chain.** The ship, the demand, the shortfall, the amount and the
resulting balance are all measured, and `docs/deployments.md` carries each. The enclave's own
*reason* is in its execution log rather than on chain, and the shortfall happened to equal the
whole position — so say *"the network read the index and covered the mandate"*, which the numbers
support, and not *"the enclave's verdict says the buffer came from the subgraph"* until somebody
has read that line.

### Pre-flight, re-run 12 September, after the first move

One thing happened on 11 September at 11:30 UTC that changes what the video is about, and the
layers below were written before it. Where they disagree with this one, this one wins.

| | State, measured 12 September |
|---|---|
| **The workflow has moved real money, and the DON carried it** | Account `0x0acdfa21…4a39` holds **10000 USDC and 490081 hmUSDC** (Morpho receipt, `previewRedeem` ≈ 490,110). The move is [`0x0668c698…`](https://arbiscan.io/tx/0x0668c698cf3d396e622a97bfa3e21016de44fb41863fa7cb69b47bd126f9ed27), block 504,035,561: sent by a **DON transmitter** `0x3a8dbd6b…` to the `KeystoneForwarder`, into `HelicoAgent` `0x98c3979358A4e5086Da432CfE91F45aE2A854463`, which called the account's `supplyIdle`. The account's own `IdleCapitalMoved` log says what moved. **Sayable, and it is the shot:** *"the decision was made in the enclave, the network signed it and wrote it to the chain, and the account's own event says what moved — no key of ours was in that transaction."* |
| **The agent is a contract, not a key** | `agent()` on the live account answers the `HelicoAgent` proxy since 11:25 UTC. The key `0x84C3891a…` never sent a transaction (nonce 0) and is retired from production. Every line below that says *signs* or *the key never leaves* describes the **rehearsal footage** (`config.staging.json` still uses `signature` delivery), not production (`config.production.json`: `delivery: forwarder`). Say so when the footage is on screen |
| **The account's owner is on the team** | Opened through the deployed dapp by a teammate's own wallet (`0x3B4f0135…`). The 11 September row's *"somebody outside the team"* was a guess from the address not being one of the four keys; it was wrong. **Do not say anyone outside the team has used it** |
| **The deployed workflow is the 11 September build** | Workflow id `00f5df97…`, registry tx [`0x34de1bf9…`](https://etherscan.io/tx/0x34de1bf99d1402b0ed1ddb37cc45e49d880ef9b7b8ed01beda31e06cd1f091ab), config hash `3dc52f74…` = `sha256(config.production.json)` on `main`. Four markets, two assets, forwarder delivery. The *"still the 8 September build"* rows below are retired |
| **Fills are queryable** | Subgraph v0.3.0 serves `fills`: 342 of them, `hasIndexingErrors: false`. The *"not sayable: fills"* rows below are retired |
| **Nine contracts, verified** | The 9 September *"five"* and the landing's *"eight"* are both behind: the agent's proxy and implementation landed on the 11th, verified on Arbiscan. Count them off `docs/deployments.md` on the day rather than from any layer of this file |
| **The live-address suite runs again** | `check-deployed.ts` stopped at check 28 on the 12th because the Morpho venue was no longer empty — the DON's own move broke the script's premise. Fixed the same day; **46 ok** on a fresh fork of today's chain |
| **`bun run --filter @helico/app prod`** | **32 checks** today, not 23 |

What this changes in the shot list: **3:15 no longer says "holding because the account is empty"**
— it says the network moved the money and the enclave now holds because the account is already
at its target split. **1:20 and 2:00 keep their footage** (the rehearsal signs and lands the call
on a fork) and add one sentence each that names production's path. Both are rewritten below.

### Pre-flight, re-run 11 September

Five things landed today and one row above stopped being true. The layer below was accurate when
it was written; where the two disagree, this one wins.

| | State, measured 11 September |
|---|---|
| **An account exists on Arbitrum One** | The 10 September row says *"Still none opened on mainnet"* and that is no longer so. `0x0acdfa21…4a39`, owner `0x3B4f0135…85F5`, opened **10 September 17:58 UTC**, **agent set** to `0x84C3891a…fcAf`. The owner is not one of the four addresses this repository uses, so somebody opened it through the deployed dapp. It holds nothing: 0 USDC, 0 WETH, 0 aUSDC. Sayable: *"an account is open on the live chain and the agent is named."* **Not** sayable: that the workflow is managing money |
| **The swap has three venues now, and a live demo will not use Aqua** | `Aqua → 1inch aggregation → Uniswap v4`. On Arbitrum One today **no Aqua position for WETH/USDC will quote at any size** — including the one whose ledger, wallet and allowance all cover the amount; it reverts with no return data. So a swap recorded at `app.helico.site` will route through **1inch aggregation** and the card will say so. Read the card aloud rather than the plan: saying "filled against an Aqua position" over a card that says `1inch aggregation` is the kind of claim that ends a submission |
| **Dollars mean dollars, live** | `Swap $5 ETH to USDC` is a starter button and the backend answers `amountUsd 5` with `amountInWei` empty, priced by a Chainlink read in the wallet that signs. This was **broken in production for ninety minutes today** — a dropped deploy over a prompt bug — so check it on the day: `curl -s -X POST https://api.helico.site/api/swap/intent -H 'content-type: application/json' -d '{"message":"Swap $5 ETH to USDC"}'` must show `amountUsd` set |
| **The account can be the maker** | A new card ships an Aqua position from the *account* rather than the wallet, so one capital earns and is takeable at once. Proven on a fork end to end, read back out of Aqua: `1 Shipped event(s) from` the account, `20 USDC, sentinel 2` under our own app. This is the thesis in one screen and **no shot currently uses it** |
| **A second 1inch surface, and the key is not in the browser** | The aggregation route is live in production through a proxy on our own server: `approve/spender` answers `0x11111112…2a65`, a quote for 0.1 WETH answers 246.60 USDC, `portfolio/v5/anything` answers **404 NOT_ALLOWED**, and so does `quote/../../portfolio`. Twelve swaps on a fork, $25 to $12,000, both directions, **12 of 12 filled at or above the floor the card shows** |
| **Not sayable: fills are queryable** | `Swapped` is indexed in the repository and **not deployed**. The live endpoint has no `fills` field — asking for one returns *"Type `Query` has no field `fills`"*. The subgraph shot is unaffected: mandates, balances and movements all answer as before. Say nothing about fills until a deploy lands |
| **Quotable, and better than our own words** | 1inch's Aqua documentation, under Data & Analytics: *"A hosted subgraph is not currently available. Build a reference indexer over the five registry/router events keyed on `(maker, app, strategyHash)`."* That is the Graph shot's own argument, made by the protocol |

#### A shot that became possible today, if there is room for it

Nothing in the list below shows the dapp doing the thing the product is named for. The terminal
shots are strong evidence and a judge cannot use them; `app.helico.site` is the thing they can open
themselves.

The shortest honest version is three sentences over one screen: type *"Swap $5 ETH to USDC"*, let
the card resolve the dollars to tokens from the feed, and read the route line aloud — whichever of
the three venues answers. It costs about twenty seconds and it is the only shot where the product
is used rather than demonstrated.

Whether that displaces something is Ghoza's call. It is written down here so the option exists on
the day rather than being discovered in the edit.

### Pre-flight, re-run 10 September — **read this one first**

Nothing moved to a new address today. What changed is what the addresses *are*, what one more of
them does, and one row below that stopped being true.

> **The layers below are history, not instructions.** Each one was true when it was written and
> newer layers supersede older ones wherever they disagree — the older rows are kept because the
> difference is the record. A clause that has since expired is struck through where it sits, so a
> reader who lands in the middle of this file is not handed a rule that stopped applying.
> **Where two layers disagree, this one wins.**

| | State, measured 10 September |
|---|---|
| **Both Aqua apps are upgradeable now** | `HelicoMandateSwap` `0x0524a353…6041` and `HelicoOracleBoard` `0xe8515af9…7d39` are **163-byte proxies** — read from the EIP-1967 slot, not assumed — delegating to `0xfdefc345…b557` and `0xc54cf202…b410`. The addresses a maker ships to are unchanged, which is the point of them. Both proxy and implementation are verified |
| **A sixth contract: ETH earns too** | `CompoundVenue` over `cWETHv3` at [`0xb0A125F5…18cD`](https://arbiscan.io/address/0xb0A125F539237b553025e2cb180f9C40B25918cD#code), verified. `symbol()` → `hcWETH`, `decimals()` → 18, rate **125 bps**. No contract changed to get it: the venue derives its name, symbol and decimals from `comet.baseToken()` |
| **Rates, read today** | Aave **274**, `cUSDCv3` **287**, `bbqUSDC` **446**, `cWETHv3` **125** basis points, all in Aave's units. They move; re-read on the day rather than quoting these |
| **New evidence — the deployment, not the source** | `scripts/check-deployed.ts` is **46 checks against the live addresses**. It opens an account through the real factory, reaches Aave, Compound and Morpho from it, and puts five USDC and five dollars of ETH to work in both assets — then moves the clock thirty days and requires both positions to be worth more. Fork evidence, so say *"measured on a fork"* |
| **New evidence — a maker position, filled** | `scripts/rehearse-maker.ts` ships a five-dollar-a-side Aqua position, finds it again through its own `Shipped` event, quotes it, and **has a second wallet fill it**. That had never happened anywhere before, on a fork or a chain. Still a fork |
| **The escape hatch reaches further** | The sweep used to name two tokens and now names every asset and every receipt the account's own logs say it can hold. For the 2:50 shot this matters: an account with capital in Compound now empties completely |
| **Still not sayable: multiple protocols in production** | Two of the three reasons are unchanged — no account exists on Arbitrum One, and `permitVenue` has never been called. `config.production.json` **does** now name four markets and two assets, so that clause is retired. And the deployed workflow is still the **8 September** build: 14 transactions to `WorkflowRegistry` from the deployer, every one on 8 September, the last at 13:42 UTC, checked on Ethereum mainnet |
| The account | **Still none opened on mainnet.** `eth_getLogs` on the factory returns zero events of any kind, cross-checked through `cast` and through a raw JSON-RPC call because `cast logs` has truncated silently before |

### Pre-flight, re-run 9 September, evening

Four contracts went out this evening and **two of them replace addresses the tables below still
name**. A take recorded against the older pair would show a mandate app that cannot accept today's
mandate.

| | State, measured after the broadcast |
|---|---|
| **Two addresses changed** | `HelicoMandateSwap` is now `0x0524a353…6041` and `HelicoOracleBoard` is now `0xe8515af9…7d39`. The pair they replace predate `ReceiptKind` and cannot take a mandate or board carrying today's `Venue` — checked against the deployed bytecode, not assumed. Neither of the old pair had ever been used: `eth_getLogs` returns zero events on both |
| **Two new contracts** | `CompoundVenue` `0x1eC57cE1…BB2E` (`hcUSDC`) and `MorphoVenue` `0xBBa798A6…9A29` (`hmUSDC`), both verified. **These replaced a pair deployed an hour earlier** — see `deployments.md`; the first pair could mint zero shares for a real deposit and never held anything. They let the enclave reach Compound v3 and any ERC-4626 vault — a Morpho vault being the first pointed at |
| **Seven contracts now** | the five from this morning, with two addresses swapped, plus the two venues |
| **Still not sayable: anything about multiple protocols** | ⚠️ **One clause here expired on 10 September — read the layer above.** The venues are deployed and **inert**. Nobody has called `permitVenue` on them, ~~`config.production.json` does not name them~~ (it names four markets and two assets as of 10 September), and the workflow has not been redeployed — so on Arbitrum One the account still reaches Aave and nothing else. See the row under *What must not be said* |
| The account | **Still none opened on mainnet.** Unchanged, and still the honest sentence |

### Pre-flight, re-run 9 September

The table below supersedes the 8 September one wherever they disagree. Two rows moved in opposite
directions, which is the pair worth reading rather than skimming: one would have put a false claim
in the video, the other would have given away a requirement we meet.

| | State on 9 September, measured |
|---|---|
| **Deployed, read back from the chain** | Read again on 10 September, after the apps went behind proxies. `HelicoAccountFactory` `0x01CC7d9F…E081` (3,883 bytes), `HelicoAccount` implementation `0x0842BB3f…4847` (8,779), `HelicoAquaSwapVMRouter` `0xb8c9f14d…c3be` (18,863), and the two Aqua apps at **163 bytes each** — `HelicoMandateSwap` `0x0524a353…6041` and `HelicoOracleBoard` `0xe8515af9…7d39`. 163 is the point rather than a small number: a proxy is a delegatecall and nothing else, and the address a maker ships to is the proxy's. The router answers `AQUA_YIELD_COVER_OPCODE()` → **34**, which is the sentence about the added instruction being *on chain* rather than in a file |
| **Deployed since the 8 September table** | `HelicoOracleBoard` `0xe8515af9…7d39` (verified, proxy **and** implementation), the second Aqua app — priced from Chainlink, braked by its own inventory, for a maker holding **one** token. **Nothing has shipped a board to it**, so it is a deployed contract with no positions on it. Say *deployed and verified*; do not say anyone is using it |
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

*Screen: the query's answer beside Arbiscan on
[`0x6b37141b…`](https://arbiscan.io/tx/0x6b37141bf0357a7c7b16d7288336bebdb1c091f3f5e40901addfc421fe7fb1b5).*

> And this is what it costs to be wrong about it. That number — one million four hundred and
> ninety-seven thousand — is what this wallet's mandate could still spend. Fifty-four seconds
> after it was shipped, the network read it here, saw the account was short, and pulled exactly
> the difference out of Morpho. Nobody asked it to. The number it acted on cannot be read off
> the chain.

> **Added 12 September**, and it is the shot that turns this section from an argument into
> evidence. `docs/deployments.md`, *"Why it withdrew"*, carries all six numbers.

> **Depends on:** the subgraph deployed and indexing. If it is not, cut the second half and keep
> the mapping sentence — the point survives without the query on screen, though it is much weaker
> without the hash.

### 1:20–2:00 — Where the decision happens — Chainlink

*Screen: `packages/plugins/cre/src/index.ts`, `cre.handlerInTee` visible.*

> The decision runs inside a Chainlink CRE confidential workflow — in an enclave. What it decides
> is how much of your capital should be earning and how much has to stay liquid to cover a swap.
> The thresholds are secrets released only in there, because they are your strategy.
>
> What comes out is only the decision. In production it leaves as a report the network signs and
> writes to Arbitrum, into a contract your account names as its agent. And the authority that
> contract uses has no recipient parameter anywhere in it — the agent can choose where your money
> works, and has no way to send it somewhere else.
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
> thousand should stay liquid to cover a swap. On this rehearsal it signs that and a script lands
> the call; on the live chain the network itself wrote the first move, on 11 September.

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
> five minutes. On 11 September it decided to put the account's capital to work, the network
> signed the decision and wrote it to Arbitrum, and the account's own event says what moved. On
> 12 September it decided to take it back out, and a different node carried that one. It came
> back with 77 units more than went in. Every number in this video is in the repository with the
> command that reproduces it.

**Changed twice on 12 September, and the second one matters more.** This line used to end with
*"holding rather than acting because the account on the live chain is empty"*, and before that
*"because no account exists yet"*, and then — for most of today — *"it holds, because the account
is already where the strategy wants it"*. All three are false now, and the last one is the one to
be careful about: it was true when it was written and stopped being true at 13:55 UTC, when the
DON withdrew the position. A hold is a state, so a sentence about a hold expires; a transaction
does not, which is why the line now names the two of them instead. The 11 September layer also said the account was opened *"by somebody outside the team"* —
it was a teammate's wallet, and that phrase must not be said.

End on the repo URL. No outro music.

## Before recording

- [ ] `bun install`, `cp apps/cre/.env.example apps/cre/.env` — the run must be warm, so the first
      take is not spent on a dependency download
- [ ] **Paste a key into the copied `.env`.** Since #472 the example carries no value for
      `CRE_ETH_PRIVATE_KEY`, deliberately, so a fresh copy makes `rehearse-idle.sh` stop with a
      sentence rather than run. Any anvil account does — the first key `anvil` prints at startup.
      Five seconds if you know, a confusing take if you do not
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

- **"Filled against an Aqua position"** over a card that says something else. Added 11 September,
  when the swap gained a third venue. No Aqua position for WETH/USDC on Arbitrum One will quote at
  any size today, so a live swap in the dapp routes through **1inch aggregation** and the card
  names it. Read the route line off the screen rather than off the plan. The Aqua path is real and
  the evidence for it is the fork run and the contract suite, which is where it should be claimed.

  **Amended 12 September — the rule stands and its reason changed.** One of ours is now live:
  the account shipped a mandate to `HelicoMandateSwap` at 13:54 UTC, strategy hash
  `0x01f61bb8…`, and the subgraph serves it. It still will not quote, because it is **one-sided**
  — `1497196` of USDC and zero of WETH — and `HelicoMandateSwap.sol:501` refuses a zero side with
  `DegenerateReserves`, which is the guard that stops a constant product handing over the whole
  opposite reserve for two wei. So *"a position of ours is live on Aqua and the index serves it"*
  is now sayable and worth saying; *"a swap fills against it"* is not, and #468 is a second,
  separate reason the dapp could not fill ours even if it did quote
- ~~**Anything about fills being queryable.**~~ Retired 11 September: v0.3.0 serves `fills`, 342 of
  them. Sayable now, with the number read on the day
- **"Deployed", "live", or "in production"** about anything that is not — check each one on the
  day, because this list changes as things land. As of 11 September **nine** contracts of ours are
  on Arbitrum One, the newest being `HelicoAgent` and its implementation; count them off
  `docs/deployments.md` on the day. (The 9 September count was five.) The router is among them and
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
- **"The enclave signs and the agent key carries it"**, or **"the key never leaves the enclave"**,
  about production. That was the design until 11 September and it is what the rehearsal footage
  shows, because staging still uses `signature` delivery. Production has no agent key: the DON
  writes the report through the `KeystoneForwarder` into `HelicoAgent`, and the owner's `setAgent`
  names that contract. Over rehearsal footage, say *"in this rehearsal it signs"*; over the live
  chain, say *"the network wrote it"*
- **A delivery hash as proof that money moved.** `KeystoneForwarder.route` calls the receiver with
  a low-level call and the transaction succeeds whether or not the receiver did — `writeReport`
  reporting `SUCCESS` says the DON delivered, not that the account moved. The evidence is the
  account's balance and its `IdleCapitalMoved` event, which is what the 12 September row quotes
- **"The AI decides where your money goes"** — it does not. A model turns the verdict into a
  sentence the owner can read, and the verdict is computed before it is called and never reads its
  answer back. Say *"the enclave decides, and a model explains it"*
- **"It finds the best yield across protocols"** — half true, so say the half that is. It *does*
  compare live rates across the markets the owner permitted and move to the best when the gap
  clears a round-trip bar.

  **The reason the wider claim is unsayable changed on 9 September and the sentence did not, so
  read this rather than remembering it.** It used to be that Compound and Morpho could not be
  reached at all: `ILendingVenue` carries Aave v3's own signatures and neither protocol answers
  them.

  That is no longer why, and the reason has now changed three times in three days. Four venues are
  **deployed and verified** — `CompoundVenue` `0x1eC57cE1…BB2E` and `0xb0A125F5…18cD`,
  `MorphoVenue` `0xBBa798A6…9A29`, alongside Aave's own pool — and `check-deployed.ts` drives one
  account across all of them at the live addresses, the four rates landing in one unit: 274, 287,
  446 and 125 basis points on 10 September.

  `config.production.json` now names them too, four markets and two assets, so that clause is
  retired rather than repeated.

  Rewritten 12 September, as the 11 September version promised. An account exists, its owner
  permitted all four markets in the opening transaction, the workflow is the 11 September build,
  and the DON has moved money into **one** of the three protocols — Morpho — on the live chain.
  That is the sentence: *"on the live chain it has put money to work in Morpho; on a fork it
  reaches all three."* *"Across protocols"* unqualified is still a claim about two protocols that
  have held no live capital, and is still not said.
  `0xHelico/helico#179`
- **"The Graph tells the agent what to work on"** — no. What is true, and sayable: *the workflow
  asks The Graph how much the maker's mandates could demand, and sizes the liquid buffer to it.*
  It still reads the account's own balances over RPC. The distinction is small and a judge who
  knows the stack will hear it
- Any figure not read off the take being recorded
