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

# Payable and known to be harmless, because `multicall` cannot forward value to them.
EXPECTED_PAYABLE = {"upgradeToAndCall"}


def main() -> int:
    if not ARTIFACT.exists():
        print(f"no artifact at {ARTIFACT} — run `forge build` in contracts/ first")
        return 1

    abi = json.loads(ARTIFACT.read_text())["abi"]
    problems = 0

    multicall = next((e for e in abi if e.get("name") == "multicall"), None)
    if multicall is None:
        print("multicall is not in the ABI — if Multicall was removed on purpose, remove this check")
        problems += 1
    elif multicall.get("stateMutability") == "payable":
        print("multicall is PAYABLE, which reopens the msg.value double-count on every batched")
        print("payable function. Make it non-payable, or stop inheriting Multicall.")
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
        print("harmless while multicall is not payable; re-read the reasoning before adding value.")

    if problems == 0:
        print(f"multicall is not payable; {len(payable)} payable function(s), all unreachable by batch")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
