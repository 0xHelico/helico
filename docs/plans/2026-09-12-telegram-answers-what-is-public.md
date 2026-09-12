# Telegram, first slice: it answers what is already public

12 September 2026. Design and review in #218; this is the first landable slice of it.

## What is being built, and what is deliberately not

#218 splits the work into three tiers and says tier 1 is the one that could land before the
deadline. This narrows even that.

**In:** a webhook, the Bot API client, and read commands that answer from **public data only** —
an address someone types into the chat. `/portfolio 0x…`, `/moves 0x…`, `/help`.

**Out, and each for a reason:**

- **Linking a Telegram account to a wallet.** It needs a signing page in the dapp, a nonce table
  and a verifier route. All three are straightforward and none of them is ten-hours-before-the-
  deadline work. Until it exists, `/portfolio` with no address says so rather than guessing.
- **Notifications.** They need a scheduler and a record of what has already been said. Getting
  that wrong means messaging somebody repeatedly, which is worse than not messaging them.
- **Tier 3, composing an intent.** It calls a model that costs money and its output is a link to
  the dapp, which is not obviously better than opening the dapp.

## The constraint, unchanged

**No private key reaches this process, and a chat id is not an identity.** The most powerful thing
this slice does is read public chain data and format it. `HelicoAccount._requireOwnerOrAgent`
admits the owner or the nominated agent and nobody else; a Telegram process is neither and stays
neither. Since nothing here is personal, nothing here needs a bind — which is why this slice is
the one that can be built without the auth surface.

## One correction to #218's own file layout

That issue puts the Bot API client in `packages/plugins/telegram/` and the handlers in
`apps/be/internal/telegram/`. **That cannot work: `apps/be` is Go and cannot consume a TypeScript
package.** The plugins rule exists so that protocol knowledge lives in one place an app consumes,
and here the only consumer is the Go backend — so the client belongs beside the handlers, in
`apps/be/internal/telegram/`. The rule is about where knowledge lives rather than about a
directory, which `contracts/` already establishes for the on-chain half.

## Security, as checks rather than intentions

| Invariant | How |
|---|---|
| Only Telegram may call the webhook | `X-Telegram-Bot-Api-Secret-Token`, compared in constant time, like the admin token |
| No token configured means no route | 404, so an unconfigured deployment has no surface at all |
| Group chats answer nothing personal | this slice has nothing personal; groups are still refused, so that stays true when linking lands |
| One user cannot spend the service | the limiter `apps/be` already has, keyed on the Telegram user id rather than an IP — every update arrives from Telegram's addresses, so an IP is the same for everybody |
| A malformed update cannot panic | every field optional, bounded body, and a decode failure answers 200 so Telegram does not retry forever |
| The token is a credential | Coolify, never the repository; `.env.example` carries the name and no value |

## How it is verified

1. Unit tests against a fake Bot API: a command is parsed, a reply is sent to the right chat, an
   unknown command is answered rather than ignored, a group is refused, a malformed update does
   not panic, and the secret token is required.
2. The webhook proven to refuse: no secret, a wrong secret, and a wrong secret of the same length.
3. **Against real Telegram only once a token exists**, which is Ghoza's to create. Until then the
   README says untested against the live Bot API rather than implying otherwise, because a
   half-proven integration described as working is the one thing this repository treats as
   disqualifying.
