# Helico app

[app.helico.site](https://app.helico.site) — the wallet-connected dapp, on **Arbitrum One only**,
because that is the one chain this product acts on.

Three pages:

| | |
|---|---|
| `/` | Your limits: open your account, nominate the agent, permit a market |
| `/portfolio` | What you hold, what is at work, and the mandates only an indexer can list |
| `/chat` | Say what you want in a sentence; the backend checks it; you sign it |

The wallet is the account — no email, no password. Connecting proves who you are with a
signature, and every write goes from your own wallet to a contract that refuses anything outside
your rules.

## Run

The backend needs to be up first, or the session will not stick:

```bash
cd apps/be && go run ./cmd/be      # :8787
bun run --filter @helico/app dev   # :3000, finds the backend on its own
```

Nothing needs configuring for a local run. Everything below has a working default; set one only
to point somewhere else.

| Variable | Default |
|---|---|
| `NEXT_PUBLIC_BE_API_URL` | `http://localhost:8787` in dev, `https://api.helico.site` in a build |
| `NEXT_PUBLIC_ACCOUNT_FACTORY` | the deployed factory; set it empty to see the not-deployed path |
| `NEXT_PUBLIC_ARBITRUM_RPC_URL` | the chain's public endpoint, which rate-limits under real traffic |
| `NEXT_PUBLIC_PROJECT_ID` | Reown project id — public by design, the browser sends it |

## Checks

```bash
bun run --filter @helico/app e2e   # 31 browser checks; needs apps/be and a build on :3100
```

They are written to fail for the right reason. Three of them unplug our own subgraph cache and
assert the page still answers, because a fallback nobody exercises is a fallback nobody has.

## Where it came from

The interface starts from [`vercel/chatbot`](https://github.com/vercel/chatbot) (MIT, see
[`LICENSE`](LICENSE)) for its chat components and design system. Everything that template needed
and this does not — Postgres, Auth.js, blob storage, artifacts, resumable streams — is gone. MIT,
as the template it starts from.
