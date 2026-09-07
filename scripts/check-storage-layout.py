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
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTRACTS = ROOT / "contracts"
SNAPSHOT = CONTRACTS / "storage-layout.txt"


def _shape(type_name: str) -> str:
    """Drop the compiler's AST ids, keep everything an upgrade depends on.

    `t_struct(Account)10029_storage` and `t_contract(IStateView)12399` carry an AST id that
    shifts whenever anything about the compilation changes — a comment edit is enough — while
    the slot it occupies does not. Those go.

    `t_array(t_uint256)43_storage` looks the same and is not: 43 is the gap's length, and the
    gap shrinking by exactly as much as new state grows is the pattern this check exists to
    make visible. That stays.
    """
    return re.sub(r"(t_(?:struct|contract)\([^)]*\))\d+", r"\1", type_name)


def current() -> str:
    # A stale `out/` makes `forge inspect` answer "storage layout missing from artifact", which
    # reads like a bug in this script. Build first so it never can.
    build = subprocess.run(["forge", "build"], cwd=CONTRACTS, capture_output=True, text=True)
    if build.returncode != 0:
        print(build.stderr.strip() or "forge build failed")
        sys.exit(1)

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
    # The compiler appends an AST id to every generated type name, and those shift whenever
    # anything about the compilation changes — a comment edit is enough. Keeping them would make
    # this warn on changes that move no slot, and a check that cries wolf is one people stop
    # reading. What matters for an upgrade is the slot, the offset, the name, and the shape.
    lines = [
        f"{e['slot']:>4}  {e['offset']:>2}  {e['label']}  {_shape(e['type'])}" for e in entries
    ]
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
