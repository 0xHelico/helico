#!/usr/bin/env python3
"""Fail if `multicall` on HelicoVault ever becomes payable.

The known hazard with OpenZeppelin's `Multicall` is a payable function batched with itself:
`msg.value` is visible in full to every `delegatecall`, so one deposit can be counted several
times. What makes that impossible here is not the absence of payable functions — the vault has
one, `upgradeToAndCall`, inherited from UUPS — but that **`multicall` itself is not payable**,
so `msg.value` is zero for the whole batch and there is nothing to count twice.

That is the invariant, and it is the one worth guarding. A test cannot: from inside Solidity you
can only show that today's `multicall` rejects value, which stays true however the contract
changes around it. So the check reads the compiled ABI.

    cd contracts && forge build
    python3 ../scripts/check-no-payable.py
"""

import json
import sys
from pathlib import Path

ARTIFACT = Path(__file__).resolve().parent.parent / "contracts/out/HelicoVault.sol/HelicoVault.json"

# Payable and known to be harmless, because no batcher can forward value to them. `receive` is
# excluded separately: a delegatecall always carries calldata, so a batch can never reach it.
EXPECTED_PAYABLE = {"upgradeToAndCall"}


def main() -> int:
    if not ARTIFACT.exists():
        print(f"no artifact at {ARTIFACT} — run `forge build` in contracts/ first")
        return 1

    abi = json.loads(ARTIFACT.read_text())["abi"]
    problems = 0

    # The invariant is "no payable function batches calls", not "multicall is not payable".
    # Checking the name only would pass a second batcher added under any other one — verified,
    # a payable `batch(bytes[])` slipped through the earlier version of this script.
    batchers = [
        e for e in abi
        if e["type"] == "function"
        and len(e.get("inputs", [])) == 1
        and e["inputs"][0].get("type") == "bytes[]"
    ]
    if not batchers:
        print("no bytes[] entry point found — if Multicall was removed on purpose, remove this check")
        problems += 1
    for e in batchers:
        if e.get("stateMutability") == "payable":
            print(f"{e['name']}(bytes[]) is PAYABLE. A payable batcher lets one msg.value be")
            print("counted by every delegatecall in the batch. Make it non-payable.")
            problems += 1

    payable = {
        e.get("name", e["type"])
        for e in abi
        if e.get("stateMutability") == "payable" and e["type"] != "receive"
    }
    unexpected = payable - EXPECTED_PAYABLE - {"multicall"}
    if unexpected:
        # Not a failure on its own, but each one is a function that would become dangerous the
        # moment `multicall` were made payable, so they are worth naming.
        print(f"new payable functions since this check was written: {', '.join(sorted(unexpected))}")
        print("harmless only while no batcher is payable; re-read the reasoning before adding value.")

    if problems == 0:
        names = ", ".join(f"{e['name']}(bytes[])" for e in batchers)
        print(f"{names} not payable; {len(payable)} payable function(s), none reachable by batch")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
