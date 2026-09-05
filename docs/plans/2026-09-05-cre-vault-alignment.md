# CRE: align the enclave with the vault's mandate rules

Issue: #35. Follows #33 (the enclave decision) and #34 (the rewritten vault).

## Problem

The enclave and the vault were written against the same `Mandate` layout but not the same
rules. Three gaps:

1. **Names.** The vault renamed `rangeWidthBps` → `rangeWidthTicks` and `maxNotional` →
   `maxLiquidity`. The layout is unchanged, so the hash still matches, but the plugin's names and
   secret ids now describe the wrong thing.
2. **`minImprovementBps` semantics.** The vault treats it as a relative shrink of the gap between
   the current tick and the range's centre. The enclave treated it as an absolute number of ticks
   outside the old range. A verdict the enclave considers worth acting on could revert with
   `NotEnoughImprovement`.
3. **Confidentiality claim.** `setMandate` takes the thresholds in calldata and `mandateOf`
   returns them, so the mandate is public on-chain. The package README said the thresholds never
   leave the enclave. That sentence has to go.

## Approach

The contract is the source of truth. The enclave keeps its own policy on top, but never emits a
verdict the vault would reject.

- `mandate.ts`: rename the two fields and their secret ids. Same ABI rows, same test vector.
- `decision.ts`: split into two pure functions.
  - `vaultAccepts(...)` mirrors `HelicoVault._checkRange` line for line: ticks ordered and
    aligned to the spacing, width exactly `rangeWidthTicks`, current tick inside the new range,
    `gapNext < gapNow`, and `gapNext * 1e4 <= gapNow * (1e4 - minImprovementBps)`, with the centre
    computed as Solidity does (`int256` division truncates toward zero, so `Math.trunc`).
  - `decideRecentre(...)` keeps the policy (expired, cooldown, in range → hold), proposes
    `tickLower = nearestUsableTick(tick - floor(width / 2))`, `tickUpper = tickLower + width` so
    the width is exact by construction, and then holds unless `vaultAccepts` is true.
- Tests: the existing table, the negative-tick case, and a grid over ticks, spacings, widths, and
  improvement thresholds asserting that every `act = true` verdict passes `vaultAccepts`.
- Docs: the package README states what the enclave keeps confidential now (the decision process
  and the report's consistency with the stored mandate, not the thresholds).

Out of scope: reading `lastActionAt` and the position from the vault, and delivering the verdict
through `onReport`. Both need the vault deployed and the report shape agreed in #34.

## How to verify

1. `bun run --filter @helico/plugin-cre typecheck` and `test`: all green, including the grid.
2. `cre workflow simulate` from the throwaway consumer against the Robinhood Chain Testnet
   ETH/WETH pool with the renamed secrets: the same three outcomes as #33.

## Prompts

The user's instruction for this stretch, in Indonesian, was "cek lagi issue" (check the issues
again) after "lanjutin aja sesuai kemauan temenku ya" (keep going according to what my friend
wants). The collaborator's request is the #34 description: follow the renames, stop converting
bps to ticks. The rest of the plan came from reading `HelicoVault.sol` on `feat/vault-contract`.
