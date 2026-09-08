# The app tells the truth about what Helico now does

Issue: #175. Written before the code, per `CLAUDE.md`.

## The problem, stated as @ghozzza stated it

The contract side moved to the yield layer on 8 September. The app did not. So a judge who reads
the submission and then opens `app.helico.site` sees two products: one where an agent keeps a
Uniswap v4 range in band, and one where idle capital earns in Aave under an account the agent
can direct but never own.

The landing copy has the same split, and **the order matters**: the copy is accurate *about the
app*. Rewriting the FAQ to describe accounts and Aave while the app still runs the vault would
trade one inconsistency for a worse one — it would promise a visitor something the site cannot
do. So the app moves first and the copy follows it.

## What this plan does not do

- **Not deleting `packages/plugins/uniswap`, and not touching `HelicoVault`.** The v4 work is
  tested and it stays; it is no longer what CRE drives, which is a different statement from it
  being wrong. Deleting it is a separate decision with no deadline pressure behind it.
- **Not rewriting the landing copy.** That is the second half and it belongs after this lands.
- **Not replacing `swap-card.tsx`.** The swap the product now does is an agent trading against an
  Aqua mandate, not a user routing through Uniswap. Changing it needs a backend that does not
  exist yet, and guessing at it three days before the video is how the demo breaks.

## What it does

### 1. `lib/account.ts` — the account, including before it exists

`HelicoAccountFactory.accountFor(owner)` is a `CREATE2` address, so it is knowable before
anything is deployed. That is the single most demonstrable thing in the new architecture and the
app should lead with it.

Reads, all optional and all failing soft:

| | |
|---|---|
| `accountFor(owner)` | the address, whether or not there is code at it |
| `code.length > 0` | whether it has been opened |
| `USDC.balanceOf(account)` | idle |
| `aUSDC.balanceOf(account)` | working |
| `agent()`, `permittedVenue(pool)` | what the agent may reach |

**Nothing is deployed yet, so the honest state is "not deployed" and not a spinner.** The factory
address comes from `NEXT_PUBLIC_ACCOUNT_FACTORY`; unset means the panel says so plainly, the way
the mandate panel already does for the vault.

### 2. The front door says what is true

`GRANTS[0]` is *"Keep a position in range … Re-centre your Uniswap v4 range"* and is the only one
marked `wired`. That sentence is now the previous product.

The wired grant becomes the one CRE actually holds: **put idle capital to work, and take it back
out.** Its detail is the part worth showing, because it is a property of shape rather than of
policy — `supplyIdle` and `withdrawIdle` have no recipient parameter, both ends are the account,
so an agent that is entirely compromised can move capital between markets the owner allow-listed
and cannot send it anywhere.

The re-centring grant stays in the list, unwired, described as what it is.

### 3. `lib/networks.ts` — end four imports of the Uniswap plugin

`addresses` and `networkByChainId` are the only reason `lib/chain.ts`, `lib/vault.ts`,
`e2e/fork-fixture.ts` and `components/mandate-panel.tsx` import `@helico/plugin-uniswap`. They
are constants and a map, not Uniswap logic. Moving them leaves `swap-card.tsx` as the one real
Uniswap surface, which is the honest count and the thing that has to be decided rather than
discovered.

## How it will be checked

- Unit tests on `lib/account.ts` for the three states that look alike from outside: no factory
  configured, factory configured but no code at the account, and an opened account. Each returns
  a different answer, and the test asserts they are different — an unopened account and an
  unconfigured app both render "nothing here" and must not be the same value.
- `bun run check`, `turbo run test typecheck`, and the browser checks in `apps/app/e2e/`.
- The existing check that at most one switch is operable stays true.

## What it deliberately leaves visible

The account panel will say **"no factory deployed"** until one is, and the demo video should show
that rather than a mock. A screen that fakes a deployed contract is the failure the rules name
directly, and the empty state is a smaller cost than the claim.

---

## Addendum, 8 September: the shape is a dashboard

Decided after looking at a portfolio page whose discipline is worth copying. The valuable part is
not the layout — it is that **every list renders four states separately**: pending, error with a
retry, empty with guidance, and data. "Not deployed" is a fifth, and a first-class one rather
than a spinner that never resolves.

That discipline is already in `lib/account.ts` from the first half. This extends it.

`/` becomes: your account, then what may be done to it, then what you can ask. The explanatory
sections stay below rather than being replaced — a visitor with no wallet still needs to be told
what this is.

| Section | Reads | Blocked on |
|---|---|---|
| Your account — total, liquid, working | the factory | a deployment |
| **Your mandates — what the chain cannot list** | **the subgraph** | **nothing** |
| What the agent may do | static, plus the account | a deployment |

Exactly one of those needs nothing deployed, and it is the one that carries a track. That is what
makes tonight's work possible at all, and it is why the mandate table is built first.

### The address field

The table defaults to the connected wallet. It also takes a typed address, because a judge with
no Aqua position would otherwise see a correct and completely empty table, while the chain holds
a maker with 48 live mandates that demonstrates the point immediately.

This is a small widening of "your portfolio" into "this wallet's portfolio", and it is
deliberate: the claim being made is *nothing on chain can list these*, which is true of any
wallet and is more convincing when the reader picks the wallet.
