# Onboarding, and moving the front door

**Asked for, in Ghoza's words** (kept verbatim, because the AI rule asks for the prompts and not
only the plans):

> buat onboarding dong buat user yg baru pertama nyoba app jadi tar ada terms and condition gitu
> sama switch buat unlock all limit (default enable/yes) jadi maksud unlock all limit semua fitur
> otomatis terbuka tanpa perlu sign2 atau enable2 in di page limit, tar default page jadi chatbot
> dan limit ga lagi di / tapi /limit

Three things: a first-run screen with terms to agree to, a switch that opens everything at once
rather than one toggle at a time, and `/` becoming the chat with the limits moving to `/limit`.

## The constraint, measured before anything was designed

"Without signing" has a hard floor, and it is worth writing down because the obvious workaround
does not work.

`setAgent` and `permitVenue` are `msg.sender != owner()` reverts. `executeBatch` runs each call
**as the account**, so a batch cannot administer the account it runs on. Proved on a fork of
Arbitrum One rather than reasoned about — `execute(self, setAgent(…))` from the owner:

```
CallFailed(0xBCb6c91358E9cEC312ea47d5CCD02921D616fC77)
```

naming the account's own address, while the same owner calling `setAgent` directly succeeds and
`agent()` reads back. This repeats what #289 already found; the account contract's own comment in
`account-controls.tsx` says so. Nothing in the app can remove that signature, and nothing should:
the owner's signature on those two calls is exactly what makes a compromised agent harmless.

**What can be removed is the number of confirmations, not the fact of one.** The app already
carries an EIP-5792 path (`useSendCalls`): the wallet batches, so every call keeps the owner as
`msg.sender` and both setters pass. On a wallet that supports it, opening the account, nominating
the agent and permitting a market is **one confirmation**. Today that path permits Aave only.

So "unlock all limits" means: one confirmation for the account, the agent, and **every** market —
not zero confirmations, which the contract cannot offer and should not.

## What gets built

### 1. The front door moves

| Route | Before | After |
|---|---|---|
| `/` | the limits page | the chat |
| `/limit` | — | the limits page |
| `/chat` | the chat | redirects to `/` |
| `/chat/[id]` | one conversation | unchanged |
| `/mandate` | redirects to `/` | redirects to `/limit` |

Links that have to move with it: the sidebar's Limits entry and its active state, "New chat",
the chat greeting's "set a mandate", the portfolio's "The limits you set →", `mandate-card.tsx`,
the limits page's own "conversation" link, and the two `Href`s the Go backend ships in its cards
(`/#mandate` and `/`).

### 2. Onboarding, once per wallet

A dialog between the gate and the app, shown when this wallet has not been through it.

- Four short lines saying what this is, whose keys sign, what the agent can and cannot reach, and
  that it is a hackathon build on Arbitrum One with real funds.
- A checkbox — required. `Start` stays disabled until it is ticked, and the dialog does not close
  on an outside click, because terms nobody had to tick are not terms.
- A switch, **Unlock everything, default on**, which says in the same breath what it will do:
  nominate Helico's agent and allow all four markets, in one confirmation if the wallet can batch.
- Stored in `localStorage` under the wallet's own address. Per wallet rather than per browser: the
  agreement is that address's, and a second wallet in the same browser has not agreed to anything.

On `Start`:

- unlock on and the wallet can batch → send it now, one confirmation, and land in the chat.
- unlock on and the wallet cannot batch → **do not** fire six prompts at someone who just arrived.
  Land in the chat and say plainly, once, that the wallet asks per step and where to finish.
- unlock off → land in the chat with nothing set, which is the state the limits page is for.

### 3. `useUnlock`, one implementation of it

`setUp` in `account-controls.tsx` becomes `hooks/use-unlock.ts`, permitting every market in
`MARKETS` rather than Aave alone, and both the limits page and the onboarding call it. Two copies
of a five-call batch is two places to forget a market.

## How it will be checked

Not by reading it back. The browser checks already sign in with an injected EIP-6963 wallet, so:

- the onboarding appears once and not again after a reload,
- `Start` is refused until the checkbox is ticked,
- `/` renders the chat and `/limit` the limits page, and `/chat` lands on `/`,
- the sidebar's active state follows,
- and the unlock sends one batch containing the agent and all four venues.

The existing e2e anchors on the limits heading to decide it is past the gate. That heading no
longer lives at `/`, so the anchor moves to the chat's own — which means the greeting's
"What would you like to do?" becomes an `h1`, where it should have been.

## What is deliberately not done

- No change to `contracts/`. The signature floor above is a property of the account, not a bug.
- No claim, anywhere in the UI, that anything is unlocked "without signing".
