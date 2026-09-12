---
title: Uniswap v4, tested and not submitted
---

*Moved out of the root README on 12 September so that file stays short enough to be read. Nothing
here was rewritten: this is the same text, the same measurements and the same pinned links, in a
place a reader reaches when they want the depth rather than the claim.*

## Uniswap v4: real, tested, not a submitted track

The plugin talks to v4 directly, no aggregator. Every claim has an on-chain transaction behind it
on Base Sepolia, listed in [the plugin's README](../../packages/plugins/uniswap/README.md).
[`FEEDBACK.md`](FEEDBACK.md) records what we ran into building on their stack.

| What | Where |
|---|---|
| Universal Router `execute`, `V4_SWAP`, router-level `SWEEP` | [`swap.ts#L100-L121`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/swap.ts#L100-L121) |
| `SWAP_EXACT_IN_SINGLE` and its settlement pair | [`swap.ts#L148-L170`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/swap.ts#L148-L170) |
| `Quoter` read over `eth_call` | [`quote.ts#L17-L28`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/quote.ts#L17-L28) |
| Pool state through `StateView` | [`pool.ts#L72-L90`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/pool.ts#L72-L90) |
| `PoolId` derivation, matching v4's own | [`pool.ts#L47-L60`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/pool.ts#L47-L60) |
| Addresses from the official SDK | [`addresses.ts#L99-L107`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/addresses.ts#L99-L107) |
| Permit2 approval | [`approval.ts#L93-L110`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/approval.ts#L93-L110) |
| EIP-712 `PermitSingle` typed data | [`approval.ts#L134-L160`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/approval.ts#L134-L160) |
| `PositionManager` mint | [`liquidity.ts#L93-L124`](https://github.com/0xHelico/helico/blob/89054c6fe9fdb8c7cfe7b978e11f9b37a1e42c25/packages/plugins/uniswap/src/liquidity.ts#L93-L124) |

Every link above is a **commit-pinned permalink**, checked against the code it points at by
`scripts/check-readme-links.py` in CI, because a permalink to the wrong lines is worse than none.
It looks checked.
