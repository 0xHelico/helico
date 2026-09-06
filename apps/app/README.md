# Helico app

`app.helico.site`: the wallet-connected app. You say what you want in a sentence, the backend
turns it into a checked swap intent, and you sign it yourself.

Wallets connect through [Reown AppKit](https://docs.reown.com/appkit/next/core/installation) on
**Arbitrum One only**, because that is the one chain Helico's vault, pool and positions live on.

## Where things come from

The interface starts from [`vercel/chatbot`](https://github.com/vercel/chatbot) (MIT, see
[`LICENSE`](LICENSE)), kept for its chat components and design system. Everything that template
needed and this app does not — Postgres, Auth.js, blob storage, artifacts, resumable streams —
is removed: **the wallet is the account**, and the thinking happens in
[`apps/be`](https://github.com/0xHelico/helico/tree/main/apps/be), not here.

## Run

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

| Variable | Meaning |
|---|---|
| `NEXT_PUBLIC_PROJECT_ID` | Reown project id; public by design, the browser sends it |
| `BE_API_URL` | the backend, `https://api.helico.site` |

## License

MIT, as the template it starts from. See [`LICENSE`](LICENSE).
