# The dapp, fully functional

Issue #126, continuing `2026-09-07-app-dapp.md`. That pass built the shell: a wallet
connects and a sentence becomes a checked intent. Nothing could be signed. This pass makes
the intent execute, brings the mandate into the app, and puts the result on a domain.

The owner's instruction: *"while you're at it, make it fully functional and make sure it
is scalable and maintainable."*

## Which chain, settled

The memory of this project still said Robinhood Chain, which was the decision on
2026-09-05. It is no longer true. `contracts/script/Deploy.s.sol` reverts on anything but
chain 42161, and #126 says Arbitrum One. Everything below is Arbitrum One, and the code
reaches it through the plugin's network registry rather than by writing the number down.

## What "maintainable" means here, concretely

Not a style preference. Four rules, each with a reason that has already cost us something:

1. **Protocol code lives in `packages/plugins/uniswap`.** CLAUDE.md requires it, and the
   Uniswap bounty rewards tooling other people can use. A React component that encodes
   calldata is calldata nobody else can reuse and nobody can unit-test.
2. **The vault's surface lives in `packages/core`,** which is an empty placeholder today
   and is exactly what it was reserved for. `@helico/plugin-cre` already carries a `Mandate`
   type and a `mandateHash`. A second copy in the app is a hash that silently disagrees with
   the enclave's, so `packages/core` gets a test that asserts the two produce identical
   bytes. Drift becomes a failing test rather than a rejected transaction.
3. **No address is written into a component.** Addresses come from `addresses(chainId)`,
   from `networkByChainId`, or from the environment. Adding a chain stays one
   `registerNetwork` call.
4. **Logic that can be wrong gets a test beside it.** The React layer holds no arithmetic.

## A. The swap executes

Today the app renders an intent and stops. The gap between that and a sent transaction is
four steps, and the plugin already has three of them.

```
intent (tokenIn, tokenOut, amountInWei)
   │
   ├─ 1. which pool?      ← the one piece missing
   ├─ 2. what comes out?  ← quoteExactInputSingle
   ├─ 3. what needs approving?  ← getAllowances / approvalsNeeded
   └─ 4. the swap calldata      ← encodeSwapExactInSingle
```

**Step 1 is new, and it goes in the plugin.** `bestPoolFor(client, a, b)` reads the
hook-less pools at the standard fee tiers, and returns the one holding the most liquidity,
or nothing when the pair has no pool. It is a function anyone building on v4 needs, which
is the argument for it being in the package rather than in our app. Discovery by scanning
`Initialize` events already exists in `discover.ts`, but that is a script that walks logs;
this reads five known keys and is fast enough to run while someone waits.

**The approvals are two, and people forget the second one.** v4 spends through Permit2, so
an ERC-20 needs an allowance to Permit2 *and* a Permit2 allowance to the Universal Router.
The plugin encodes both. Native ETH needs neither, which the UI must not ask for.

**The app's part is a hook and a panel**: `useSwap(intent)` resolves the pool, quotes,
reads the allowances, and hands back an ordered list of transactions with a label each.
The panel shows the list and sends them one at a time through wagmi. No arithmetic in the
component: the minimum-out comes from `minimumAfterSlippage`, the deadline from
`deadlineFromNow`.

**Slippage** defaults to 50 bps and is shown, not hidden. A quote that moves more than that
between reading and sending should fail rather than fill at any price.

## B. The mandate

The product is not the swap. It is the mandate: a policy the vault enforces, that the
owner can revoke. The app has to show it.

- **Read** `positionOf`, `isActive`, `mandateOf` for the connected address.
- **Write** `setMandate(tokenId, m)` and `revoke()`.
- The vault address comes from `NEXT_PUBLIC_VAULT_ADDRESS`. **Unset means the UI says the
  vault is not deployed yet** and offers nothing to click. It does not pretend.

## C. Deployed at app.helico.site

The pattern the landing, the docs and the API already use, which is the argument for using
it again: a Dockerfile building the standalone output and running it as a non-root user, a
GHCR image on merge, and the SSH forced command asking Coolify to redeploy. `BE_API_URL`
gets its default inside the Dockerfile, because the landing already taught us that a build
argument passed only by the workflow silently does not arrive.

## How each claim gets proved

CLAUDE.md forbids claiming an integration that is not proven, and the honest problem here
is that the vault is not on a live network. The answer is a fork, not a promise:

| Claim | Proof |
|---|---|
| The plugin bundles into a Next client build | done before this plan was written: `next build` compiled it |
| `bestPoolFor` finds the real ETH/USDC pool | unit test plus a read against Arbitrum One |
| Approvals and swap calldata are correct | anvil forked from Arbitrum One, funded account, the swap actually executed and the balance checked |
| The mandate reads and writes | anvil fork with the vault deployed by `Deploy.s.sol`, which reads `contracts/` and changes nothing in it |
| The app is deployed | the URL answers, over TLS, with a live container |

A fork proves the calldata against real pool state and real router code. It does not prove
a mainnet deployment, and nothing here will say it does. `contracts/` and `apps/cre` are
not modified, and nothing is deployed to a live network from this machine.

## Order, and what blocks what

1. `bestPoolFor` in the plugin, with its test.
2. The vault surface in `packages/core`, with the anti-drift test.
3. The swap hook and panel in the app.
4. The mandate read and write in the app.
5. The container image and the deploy.

Steps 1 and 2 are independent of everything. Step 3 needs 1. Step 4 needs 2 and, to be
verified, an anvil fork. Step 5 needs nothing and can be done in parallel, but the chat is
useless in production until #115 merges, because `POST /api/swap/intent` only exists there.
