# CRE: the mandate decision inside the enclave

Issue: [#20](https://github.com/0xHelico/helico/issues/20). Builds on
[`2026-09-05-mandate-enforced-lp.md`](2026-09-05-mandate-enforced-lp.md) and replaces the
template placeholder in `packages/plugins/cre` (see
[`2026-09-05-plugin-cre.md`](2026-09-05-plugin-cre.md)).

## Problem

The confidential handler in `@helico/plugin-cre` still runs the template's `scoreResponse`.
The Chainlink prize needs the enclave to process a sensitive input and contribute to the
application; the product plan says what that input is: the user's mandate thresholds, and the
decision whether to re-centre a Uniswap v4 position.

## Approach

One handler, three inputs, one verdict.

| | Where | What |
|---|---|---|
| Public config | `config.*.json` | pool key and id, the position's `tickLower`/`tickUpper`/`lastActionAt`, the JSON-RPC URL and `StateView` to read from, the committed `mandateHash` |
| Secret, enclave only | Vault DON, one `getSecrets` call | `rangeWidthBps`, `minImprovementBps`, `cooldownSeconds`, `maxNotional`, `expiry` |
| Read, enclave only | `HTTPClient.sendRequest(teeRuntime, …)` | `StateView.getSlot0(poolId)` through `eth_call` on the configured RPC |

Steps, all inside the TEE until the last one:

1. Fetch the five thresholds. Recompute `keccak256(abi.encode(Mandate))` with the same field
   order and widths as the vault's struct. If it differs from the committed hash, refuse to
   act: the enclave was given thresholds the user did not sign.
2. Read the current tick.
3. Decide (`decideRecentre`, pure): expired → hold; cooldown not elapsed → hold; tick inside
   the range → hold; otherwise the drift out of range in ticks (one tick is one basis point of
   price) must reach `minImprovementBps`; then propose a range of `rangeWidthBps` ticks centred
   on the tick, snapped to the pool's tick spacing.
4. `usingTheDons()` and report `(bool act, int24 tickLower, int24 tickUpper, bytes32 mandateHash)`.
   Nothing else crosses: not the thresholds, not the tick, not the RPC response.

`maxNotional` is committed in the hash but enforced by the vault when the agent submits
`recenter(...)` amounts; the enclave has no amounts to check.

### Rejected alternatives

- **CRE's EVM read capability** for the tick. It would work on Robinhood Testnet (CRE lists
  it from SDK 1.19), but it runs on the Workflow DON, outside the enclave, and ties the read to
  CRE's chain list. An `eth_call` over the HTTP capability stays inside the TEE and works on any
  RPC, including Robinhood mainnet, which CRE does not list.
- **Keeping the thresholds in public config.** Then nothing sensitive would be inside the
  enclave and the prize text would not be met; the product plan also makes them private on
  purpose.
- **Gas-priced cost gating inside the enclave.** It needs gas price, pool fees, and position
  size, which the agent has and the enclave does not. `minImprovementBps` is the user's own
  cost floor in price terms; the agent adds gas on top before calling the vault.

## Scope

**In:** `mandate.ts` (struct, hash), `decision.ts` (pure rule), the handler and its config
schema, tests, README, `@chainlink/cre-sdk` 1.18.0 → 1.19.1.

**Out:** the vault contract, the agent that submits `recenter`, `apps/cre` (the runnable
project, #21, not on this side), deployment.

## How to verify

| Step | Command | Pass condition |
|---|---|---|
| 1 | `bun run --filter @helico/plugin-cre typecheck` | clean |
| 2 | `bun run --filter @helico/plugin-cre test` | hash vector, decision table, and a fake `TeeRuntime` run where the report decodes to the four verdict fields and contains none of the threshold values |
| 3 | `cre workflow simulate` from a throwaway project that imports the package | TEE banner, then a verdict against the ETH/WETH pool the Uniswap e2e created on Robinhood Chain Testnet (#14); output committed here |
| 4 | `bun run check` | Biome clean |

## Prompts

> dah isi faucet, form di handle temenku, dan lanjutin aja sesuai kemauan temenku ya

*"Faucet is funded, my friend handles the form, and continue according to my friend's
wishes."* The friend's wishes are issues #20 and #21 and the product plan #31; `apps/` is
explicitly not on this side ("jangan kerjain apps/cre sama apps/be ya").

## Revisions — same day, while implementing

- **SDK 1.19.1.** Bumped from 1.18.0 before writing the handler; `handlerInTee` and the
  handler object shape (`requirements.tee.item`) are unchanged, the existing test still passes.
- **No `z.string().url()` in config.** zod backs it with `new URL()`, which the WASM runtime
  (QuickJS) does not provide: the simulator failed config validation with "Invalid url". A
  regex does the job.
- **Negative `int24` must be a `bigint`.** `encodeAbiParameters` with `-560` as a Number
  threw "not in safe 24-bit signed integer range" under QuickJS only (Bun was fine). The
  verdict encoder passes `BigInt(tick)`; the test suite now includes the negative case.
- **A hash mismatch is still reported**, as `act = false` with the hash the enclave actually
  computed, so the vault sees the mismatch too and the RPC is never called.
- **Cooldown** is skipped when `lastActionAt` is 0 (no action yet), so a fresh position can
  be re-centred immediately.
- The simulation ran against the ETH/WETH pool this team created on Robinhood Chain Testnet
  (poolId `0xea84630b…7fd9c5`, tick −65, no liquidity), because it is the only v4 pool there
  we control. Results are in the package README.
