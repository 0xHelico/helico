# CRE: sign the sized re-centre inside the enclave

Issue: #47, the enclave side of #41 (option B). Follows #40 and #46.

## Problem

Robinhood mainnet has no CRE forwarder, so a DON report has nowhere to land there and the
workflow's verdict stays advisory: `AGENT_ROLE` on an EOA means the vault trusts a key, not a
decision. The user asked for the workflow to be load-bearing on that chain.

## Approach

The agent key becomes a Vault DON secret, released only into the enclave. On `act`, the
enclave signs an EIP-712 authorisation over exactly what the vault will execute, and that
signature is what leaves the enclave. The vault (contract side, #41) recovers the signer and
requires `AGENT_ROLE`; anyone may relay. Feasibility was proven in the simulator on #41.

- `src/sign.ts`: the typed data. Domain `{ name, version, chainId, verifyingContract: vault }`
  with `name` and `version` in config (defaults `HelicoVault` / `1`). Primary type
  `Recenter(RecenterParams params,bytes32 mandateHash,uint256 nonce)` with the vault's own
  struct nested, so Solidity hashes `params` with one `hashStruct` and the field order stays
  the contract's. `signRecentre` (viem, deterministic RFC 6979) and `recoverRecentreSigner`.
- The handler: `nonces(owner)` joins the first read batch (getter name in config, default
  `nonces`). On `act` with `delivery: 'signature'`, the enclave signs and crosses out with
  the authorisation: the ABI-encoded `(RecenterParams, bytes32 mandateHash, uint256 nonce,
  bytes signature)` as the DON report body, and the same as JSON in the handler's result so the
  simulator prints it. `delivery: 'forwarder'` keeps `writeReport` for chains that have one.
- What never leaves: the key, the reads, the sizing inputs. What leaves: the authorisation,
  which is public by design once relayed.
- `src/relay.ts`: calldata for `recenterWithSignature(params, mandateHash, nonce, signature)`
  so the runnable relayer under `apps/` (collaborator's) has nothing to encode; the function
  name is config until the vault fixes it.

## How to verify

1. `bun run typecheck`, `bun run test`, `bun run check` at the root: the typed-data hash pinned
   to a literal produced independently, the signature against a known key, recovery, and the
   handler test asserting the report body decodes to the signed tuple and that the key never
   appears in anything that crosses out.
2. `cre workflow simulate` with an `AGENT_KEY` secret against a fork or the live pool once the
   vault with `nonces` exists; until then the read of `nonces` is what blocks the simulation.

## Prompts

The user said "cek lagi" (check again) and earlier "ngikut ghozza aja" (follow the
collaborator's decisions). The collaborator accepted the typed struct on #41 and said he would
add the domain and `nonces(owner)` to the vault after the swap leg lands. This plan builds the
enclave side against that agreement, with names as config.

## Revision — 2026-09-06, the chain moved to Arbitrum One (#58)

The project moved from Robinhood Chain to Arbitrum One because Arbitrum has both Uniswap v4 (all
addresses from the SDK) and a CRE `KeystoneForwarder`, at a twentieth of the gas. For this plan
that means the forwarder path is back on the critical path: `chainSelectorName:
'ethereum-mainnet-arbitrum-1'`, production forwarder `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`,
and `cre workflow simulate --broadcast` through the `MockKeystoneForwarder`
`0xd770499057619c9a76205fd4168161cf94abc532`. The signature path stays as the chain-independent
design and the reason `AGENT_ROLE` can be a key that exists only inside an enclave. Nothing in
the package changed for the move; this revision records the config and the dependency on the
vault's `onReport` (#37). Tracked in #61.
