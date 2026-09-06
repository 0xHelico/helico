#!/usr/bin/env python3
"""Fail when HelicoVault's storage layout changes in a way an upgrade could not survive.

The vault is UUPS behind a proxy, so its storage outlives its code. Inserting a variable in the
middle shifts every slot after it, and the upgraded implementation then reads the wrong ones —
silently, and unrecoverably except by another upgrade.

This is not hypothetical here: adding `nonces` mid-declaration moved `poolManager` from slot 4
to slot 5. Nothing was deployed, so nothing broke, but nothing would have noticed either. CI
ran `fmt`, `build` and `test`, none of which sees a layout, and the only upgrade-test target is
`VaultV2 is HelicoVault` — layout-identical by construction, so those tests can never detect a
shift no matter how many are added.

    cd contracts && forge build
    python3 ../scripts/check-storage-layout.py          # verify
    python3 ../scripts/check-storage-layout.py --update # after a deliberate change

The snapshot is `contracts/storage-layout.txt`, and a diff to it belongs in a review.
"""

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTRACTS = ROOT / "contracts"
SNAPSHOT = CONTRACTS / "storage-layout.txt"


def current() -> str:
    out = subprocess.run(
        ["forge", "inspect", "HelicoVault", "storage-layout", "--json"],
        cwd=CONTRACTS,
        capture_output=True,
        text=True,
    )
    if out.returncode != 0:
        print(out.stderr.strip() or "forge inspect failed")
        sys.exit(1)
    entries = json.loads(out.stdout)["storage"]
    lines = [f"{e['slot']:>4}  {e['offset']:>2}  {e['label']}  {e['type']}" for e in entries]
    return "\n".join(lines) + "\n"


def main() -> int:
    now = current()

    if "--update" in sys.argv:
        SNAPSHOT.write_text(now)
        print(f"snapshot updated ({len(now.splitlines())} slots)")
        print("commit it with the change that caused it, so the diff is reviewable")
        return 0

    if not SNAPSHOT.exists():
        print(f"no snapshot at {SNAPSHOT} — create it with --update")
        return 1

    was = SNAPSHOT.read_text()
    if was == now:
        print(f"storage layout unchanged ({len(now.splitlines())} slots)")
        return 0

    print("STORAGE LAYOUT CHANGED\n")
    import difflib

    for line in difflib.unified_diff(
        was.splitlines(), now.splitlines(), "recorded", "current", lineterm="", n=1
    ):
        print(f"  {line}")
    print()
    print("Appending new state at the end is safe behind a proxy. Anything else shifts the")
    print("slots after it, and an upgraded implementation reads the wrong ones.")
    print("If the change is deliberate and append-only, re-run with --update and commit both.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
