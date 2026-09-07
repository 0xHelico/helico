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
2. **The vault's surface has one home, and it is the one that already exists.** The first
   draft of this plan put it in `packages/core`, which is an empty placeholder. That was
   wrong: `@helico/plugin-cre` already carries the `Mandate` type, `mandateHash`, and a test
   pinning both to the Solidity struct. Moving or copying that creates a second definition
   whose only job is to agree with the first. Instead the plugin gained subpath exports
   (`@helico/plugin-cre/abi`, `/mandate`) so a browser bundle can take the two viem-only
   modules and nothing else, the user-facing functions and errors were added to the ABI the
   enclave already reads, and a test now asserts that the ABI's tuple and `mandateHash`
   describe the same struct. Drift is a failing test rather than a rejected transaction.
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

| Claim | Proof | Result |
|---|---|---|
| The plugin bundles into a Next client build | `next build` | compiled, before the rest was written |
| `bestPoolFor` finds the real pools | unit tests plus a read of Arbitrum One | ETH/USDC at the 0.05% tier, ARB/USDC at 0.3%, quotes to match |
| The approvals and calldata are right | anvil fork, funded account, the swap sent | 0.1 ETH bought 248.974068 USDC; half came back as 0.049937 ETH through approve → approve → swap |
| The app swaps | a browser driving the app, wallet injected, against the fork | 0.5 ETH in, 1244.280761 USDC arrived, no console errors |
| The mandate reads and writes | a browser driving `/mandate`, vault deployed by `Deploy.s.sol` on the fork | committed (`isActive` true, `positionOf` the token) and revoked (`isActive` false) |
| The app is deployed | the URL, over TLS | `https://app.helico.site` answers 200 on `/` and `/mandate`, 404 elsewhere, HSTS, certificate to 2026-12-05 |

Two things that cost time and are worth writing down. anvil's default account **has code on
an Arbitrum fork** — a contract at that well-known address forwards its whole balance away,
so the first payment a swap makes to it takes the other 9,999 ETH with it. And `bestPoolFor`
swallowed every read failure, so a browser pointed at a node that was not the fork was told
there was no pool; a revert is now the only failure it treats as "not a candidate".

A fork proves the calldata against real pool state and real router code. It does not prove
a mainnet deployment, and nothing here will say it does. `contracts/` and `apps/cre` are
not modified, and nothing is deployed to a live network from this machine.

## Order, and what blocks what

1. `bestPoolFor` in the plugin, with its test.
2. The vault surface in `packages/core`, with the anti-drift test.
3. The swap hook and panel in the app.
4. The mandate read and write in the app.
5. The container image and the deploy.

All five are done. One thing is not, and it is not ours to finish: **the deployed chat
answers "the swap service is not answering"** until #115 merges, because
`POST /api/swap/intent` only exists on that branch. The mandate page works today and says
the vault is not deployed, which is true until #85.
