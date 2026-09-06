# The vault consumes the enclave's verdict

Issue: #37, contract side. The workflow side is `docs/plans/2026-09-05-cre-forwarder-delivery.md`.

## Problem

The enclave computes a verdict and nothing on chain consumes it. The prize wording asks that
the workflow be *"a meaningful part of the application"* and rules out *"an isolated example
that does not contribute"* — and an assessor reading the repo today would be right to call it
isolated. `recenterWithSignature` proves the enclave can authorise; it does not prove the DON
can deliver.

## Approach

One function, one storage slot, no new role.

```
KeystoneForwarder.report(receiver, rawReport, ctx, signatures)
  └─ verifies exactly f + 1 DON signatures            (nothing we can re-check)
       └─ vault.onReport(metadata, report)
            msg.sender == forwarder                   ← the whole boundary
            abi.decode(report, (bool, bytes32, RecenterParams))
            mandateHash == the terms the vault holds now
            _recenter(p)                              ← every existing rule still applies
```

- `address public forwarder`, appended after `nonces`, `__gap` 43 → 42. Zero until an admin
  sets it, which needs no zero check: `msg.sender` is never zero, so an unset forwarder refuses
  every report.
- `setForwarder` is `DEFAULT_ADMIN_ROLE`. A setter rather than an `initialize` argument because
  a demo runs through the CLI's mock forwarder and a deployment through the production one, and
  swapping them should not need a new vault — the collaborator's point on #37.
- The forwarder is **not** given `AGENT_ROLE`, which is what #37 originally proposed. A direct
  `msg.sender` equality is one value anyone can read, rather than an entry in a role set that
  has to be enumerated to be audited. It also keeps the two doors independent: revoking the
  report path does not touch the signature path.
- `_recenter` and `_assertDelivered` move from `calldata` to `memory`, because the params now
  arrive decoded from a report rather than as calldata. Internal signatures only.
- `supportsInterface` gains `type(IReceiver).interfaceId`; `AccessControlUpgradeable` already
  answers ERC-165.

### Stale reports

Chainlink's `IReceiver` documentation puts this on the receiver: the forwarder refuses to
replay a transmission it already attempted, but an old report pushed late still arrives.
Nothing new was added, because three things already answer it and each is tested:

| Defence | Where | Test |
|---|---|---|
| `p.deadline`, inside the signed bytes | `_recenter` | `test_AStaleReportIsRefusedByItsOwnDeadline` |
| the range must contain the tick *now* | `_checkRange` | covered by the existing range suite |
| the cooldown, which cannot be zero | `_recenter` | `test_ASecondReportInsideTheCooldownIsRefused` |

## How to verify

1. `forge test` — 11 new tests in `test/ForwarderReport.t.sol`, 94 total with a fork RPC set.
2. Mutation: deleting the `!act` guard and the `mandateHash` check fails exactly
   `test_AHoldMovesNothing` and `test_AReportAgainstReplacedTermsIsRefused`, and nothing else.
3. `test_DecodesTheReportTheEnclaveEncodes` pins bytes produced by `encodeReport` in
   `packages/plugins/cre`, not by this contract. `RecenterParams` is a static struct, so a
   reordered field decodes to different numbers rather than reverting — this is what catches it.
4. `python3 scripts/check-storage-layout.py` — append-only, 9 slots, snapshot committed.
5. `ForkDeploy` asserts the deploy sequence sets the forwarder while the deployer still holds
   the admin role.

## Not done here

The end-to-end run — a workflow writing a report that moves a real position — needs a deployed
vault, and deployment is the collaborator's. `FORWARDER_ADDRESS` is optional in the deploy
script so the vault can go out before that address is settled.
