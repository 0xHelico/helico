#!/usr/bin/env python3
"""Fail if the batching entry point on `HelicoAccount` ever becomes payable.

The hazard is a payable function that batches calls: `msg.value` is visible in full to every call
in the batch, so one deposit can be spent several times. `HelicoAccount` is exactly the shape
where that bites — `execute` **is** payable, and `executeBatch` **is not**, which is what makes
the value in a batch add up to what was sent rather than to what was sent times the batch length.

That is the invariant, and it is the one worth guarding. A test cannot: from inside Solidity you
can only show that today's `executeBatch` rejects value, which stays true however the contract
changes around it. So the check reads the compiled ABI.

    cd contracts && forge build
    python3 ../scripts/check-no-payable.py

This guarded `HelicoVault.multicall` until 8 September 2026. The vault was deleted — it was never
deployed and CRE had moved off it — and the invariant moved here with the batching, because the
account is the contract that ships and it holds a real user's funds. The check's own text asked
for this: *"if Multicall was removed on purpose, remove this check"*. It was removed on purpose,
and the thing it protected did not go with it.
"""

import json
import sys
from pathlib import Path

ARTIFACT = Path(__file__).resolve().parent.parent / "contracts/out/HelicoAccount.sol/HelicoAccount.json"

# Payable and known to be harmless. `execute` is a single call and forwards its own value, which
# is the point of it. `upgradeToAndCall` is inherited from UUPS and is not reachable from a batch.
# `receive` is excluded separately: any batched call carries calldata, so it can never be reached.
EXPECTED_PAYABLE = {"execute", "upgradeToAndCall"}


def main() -> int:
    if not ARTIFACT.exists():
        print(f"no artifact at {ARTIFACT} — run `forge build` in contracts/ first")
        return 1

    abi = json.loads(ARTIFACT.read_text())["abi"]
    problems = 0

    # The invariant is "no payable function batches calls", not "executeBatch is not payable".
    # Checking one name would pass a second batcher added under any other name — verified once
    # already, when a payable `batch(bytes[])` slipped through an earlier version of this script.
    # So any single-argument array entry point counts, whatever it is called and whatever the
    # element type: `Call[]` today, `bytes[]` if OpenZeppelin's Multicall ever comes back.
    batchers = [
        e for e in abi
        if e["type"] == "function"
        and len(e.get("inputs", [])) == 1
        and e["inputs"][0].get("type", "").endswith("[]")
    ]
    if not batchers:
        print("no array entry point found — if batching was removed on purpose, remove this check")
        problems += 1
    for e in batchers:
        if e.get("stateMutability") == "payable":
            print(f"{e['name']}({e['inputs'][0]['type']}) is PAYABLE. A payable batcher lets one")
            print("msg.value be counted by every call in the batch. Make it non-payable.")
            problems += 1

    payable = {
        e.get("name", e["type"])
        for e in abi
        if e.get("stateMutability") == "payable" and e["type"] != "receive"
    }
    unexpected = payable - EXPECTED_PAYABLE
    if unexpected:
        # Not a failure on its own, but each one is a function that would become dangerous the
        # moment a batcher were made payable, so they are worth naming.
        print(f"new payable functions since this check was written: {', '.join(sorted(unexpected))}")
        print("harmless only while no batcher is payable; re-read the reasoning before adding value.")

    if problems == 0:
        names = ", ".join(f"{e['name']}({e['inputs'][0]['type']})" for e in batchers)
        print(f"{names} not payable; {len(payable)} payable function(s), none reachable by batch")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
