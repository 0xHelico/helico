# The landing describes the product the app now runs

Issue: #175, second half. The first half is #186, merged.

## Why now and not before

@ghozzza stopped at the copy deliberately, and the reason was right: **the copy was accurate
about the app.** Rewriting the FAQ to describe accounts and Aave while the app still ran the
vault would have traded one inconsistency for a worse one — promising a visitor something the
site could not do.

#186 moved the app. The blocker is gone.

## What is wrong today, measured rather than remembered

The hero's right-hand canvas is *"behind the chat"*: a line drawing down through the layers each
move crosses. **The shape is already right** — it is the agent's decision trail, not a price
chart, and there is no price chart anywhere in the repository. What is wrong is every word inside
it, and one of the layers.

```
layers drawn:   You (3) · Vault (4) · Enclave (7) · Chain (2)
```

`Vault` is no longer a layer of this product. The four scripted scenarios are Mandate, Re-centre,
Refuse and Hold, and all four are Uniswap v4 range keeping.

**One item is not merely stale, it is false.** `cooldown` appears in `provenance.ts`,
`cycles.ts`, `Enforcement.astro` and `Faq.astro`. There is no cooldown: `decision.ts` says its
absence is deliberate and the deadband does that job. A site explaining a mechanism that does not
exist is worse than one that is out of date.

## What changes

### Layers: `You → Account → Enclave → Aqua`

Each is a thing that can refuse, which is what makes the trail worth drawing:

- **You** set the terms, and are the only one who can widen them
- **Account** holds the capital and refuses any recipient but itself
- **Enclave** decides, over thresholds released only inside it
- **Aqua** moves tokens without ever holding them

### Four scenarios, matching what the product does

| Was | Becomes |
|---|---|
| Mandate — range width, retained liquidity, cooldown | Mandate — how much stays liquid, which markets, which agent |
| Re-centre — burn, swap, mint | Supply — idle capital into a permitted market |
| Refuse — the thresholds did not hash to the mandate | Refuse — **the agent cannot name a recipient**, so there is nothing to refuse *with* |
| Hold — the cooldown is running | Hold — the move does not clear the deadband |

The third is the one worth changing most. A hash mismatch is a policy refusal; "the call has no
recipient parameter" is a refusal by **shape**, which cannot be reconfigured, and it is the
strongest thing this architecture can say.

## Honesty about the numbers

`cycles.ts` already carries a header saying which figures are real and which are scripted. That
stays and gets updated. Real, read today:

- Aave v3 USDC on Arbitrum One: `getReserveData` → `currentLiquidityRate` **2.65% APR**
- pool `0x794a6135…`, aUSDC `0x724dc807…`, Aqua `0x1111113ccf…`, SwapVM `0x111111338c…`

Scripted: the conversations, the account address, the amounts.

## Not in this change

`Faq.astro` and `Enforcement.astro` carry the same split and are the same size again. They follow
in their own change rather than making this one unreviewable. Nothing here touches the app, the
contracts, or `packages/`.
