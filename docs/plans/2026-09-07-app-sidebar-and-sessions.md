# The sidebar, and the session that makes it mean something

Issue #126. The pruned template lost its sidebar along with the auth, the documents and the
votes it was wired to. The owner's words: *"why is the chatbot so different — earlier there
was a sidebar, below it account, chat history, new chat, and now it's gone."* And:
*"clicking the logo goes back to the landing page"*, which it should not from inside the app.

## The order the owner asked for

*"Let's do it this way: make it the same first, then change it."* So the template's shell comes
back as the template wrote it — `SidebarProvider`, `AppSidebar`, `SidebarInset`, the history
list, the account block, the greeting and the suggested actions — and Helico's changes go on
top of that rather than beside it.

Not everything comes back. The template's composer, message renderer and history are wired to
the AI SDK, an artifact system, documents, votes and a weather tool, and those are the parts
that were pruned for a reason: this chat does not stream from a model in the browser, it asks
`apps/be` for a checked intent. So the **shell** is restored faithfully and the **body** stays
ours — the same `ai-elements` the template uses, saying what our product says.

## What has to be true

A sidebar with New chat, a list of past conversations, and the account at the bottom. A
conversation list is only worth having if it survives a reload, and it must not be visible to
anyone but the wallet that wrote it. That is a session, which is the thing the owner already
decided how to build: *"if it needs a session to save chat, profile and so on, use an EIP-712
signature and set it up in apps/be."*

## Why a signature and not a login

There is no account to log into. The wallet is the identity, and the only thing the backend
needs is proof that the browser in front of it holds the key for an address. An EIP-712
signature is exactly that proof, and it costs no gas and no personal data.

```
browser                         apps/be
   │  GET  /api/session/nonce ────▶  a nonce, single use, two minutes
   │  sign EIP-712 { address, nonce, issuedAt }
   │  POST /api/session ──────────▶  recover the signer, spend the nonce,
   │                                 set an HttpOnly cookie for 7 days
   │  GET  /api/chats ────────────▶  the conversations that cookie's address owns
```

**The nonce is stored and single-use.** Without one, a signature captured once mints sessions
forever. It lives in memory rather than a table: the process is single, and a restart costing
someone a second signature is a better trade than a table that has to be swept.

**The cookie is stateless** — HMAC over the address and the expiry, with a secret from
`BE_SESSION_SECRET`. Unset, the secret is generated at boot and every restart signs everyone
out, which the log says plainly rather than pretending otherwise.

**The browser talks to `apps/be` directly** for the session and the chats, because a cookie
issued by one host cannot be proxied through another without rewriting it. `SameSite=None;
Secure` and the CORS allow-list that already exists. The swap intent keeps going through the
Next route, because that one has a reason to hide where it goes: it costs money per call.

## What the backend gains

`internal/session` — nonce, EIP-712 hashing, signature recovery, the cookie.
`internal/chat` — conversations and their messages, owned by an address.

| Route | Does |
|---|---|
| `GET /api/session/nonce` | a nonce to sign |
| `POST /api/session` | verify the signature, set the cookie |
| `GET /api/session` | which address this cookie is |
| `DELETE /api/session` | forget it |
| `GET /api/chats` | this address's conversations, newest first |
| `POST /api/chats` | start one |
| `GET /api/chats/{id}` | its messages |
| `POST /api/chats/{id}/messages` | append a turn |
| `DELETE /api/chats/{id}` | remove it |

Every chat route reads the address from the cookie and from nowhere else. An id belonging to
another address answers 404, not 403: whether a conversation exists is itself the owner's.

**One dependency.** Recovering a secp256k1 signer is not in the standard library.
`github.com/decred/dcrd/dcrec/secp256k1/v4` is the small, maintained one, and
`golang.org/x/crypto/sha3` gives keccak256. `go-ethereum` would drag a client, a database and
a consensus engine in to do arithmetic.

## What the app gains

The sidebar the template had, wired to those routes: New chat, the list, and the account block
at the bottom holding the connect button. Signing in happens when a wallet connects and the
cookie is missing — one prompt, and the reason for it is written next to it.

Without a wallet, the app still reads and still answers. The sidebar then says so instead of
showing an empty list, because an empty list looks like a bug and an explanation does not.

The logo goes to `/`. Getting back to helico.site is what the footer link is for.

## How it gets proved

The same way as everything else here: by running it. A browser with a wallet injected connects,
signs once, asks two different things, reloads, and finds both conversations still there; then
a second wallet in a clean context sees none of them. Go tests cover the signature path
directly — a signature from the wrong address, a spent nonce, a stale one, a tampered payload.
