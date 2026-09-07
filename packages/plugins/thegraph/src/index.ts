/**
 * The Graph, for the questions the chain cannot answer.
 *
 * `readChainState` in `@helico/plugin-cre` reads one instant: the tick now, the liquidity now,
 * the range as it stands. Every question worth asking before moving a position is historical, and
 * none of it is on chain — a pool keeps no history, and Aqua's balances live in a private mapping
 * four levels deep whose events carry no indexed parameter, so "which mandates does this maker
 * have?" has no on-chain answer at all.
 *
 * Nothing here decides anything. It returns evidence; the enclave weighs it.
 */
export * from './client'
export * from './mandates'
export * from './pool'
export * from './types'
