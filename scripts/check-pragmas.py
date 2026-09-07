#!/usr/bin/env python3
"""Every Solidity file must pin the compiler the build actually uses.

This exists because main stopped building on 7 September and no PR was wrong. One branch moved
the whole tree from 0.8.28 to 0.8.30 for Aqua; another, cut before it, added a new test file
carrying the old pin. Both were green on their own, and the break appeared only once both were
merged -- which is exactly the failure CI on a branch cannot see.

Comparing each file against `solc` in foundry.toml catches it on whichever of the two lands
second, rather than on whoever pulls main next.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTRACTS = ROOT / "contracts"
PRAGMA = re.compile(r"^pragma solidity ([^;]+);", re.M)


def main() -> int:
    toml = (CONTRACTS / "foundry.toml").read_text()
    pinned = re.search(r'^solc\s*=\s*"([^"]+)"', toml, re.M)
    if not pinned:
        print("foundry.toml has no `solc` pin — nothing to check against")
        return 1
    want = pinned.group(1)

    problems = 0
    checked = 0
    # Only the three source trees. `broadcast/` contains *directories* named `Deploy.s.sol`,
    # which a bare glob happily hands you as if they were files, and `lib/` is other people's
    # code that pins whatever it likes.
    for tree in ("src", "test", "script"):
        for path in sorted((CONTRACTS / tree).glob("**/*.sol")):
            if not path.is_file():
                continue
            found = PRAGMA.findall(path.read_text())
            if not found:
                print(f"NO PRAGMA  {path.relative_to(ROOT)}")
                problems += 1
                continue
            checked += 1
            for got in found:
                if got.strip() != want:
                    print(
                        f"MISMATCH   {path.relative_to(ROOT)}: "
                        f"pragma {got.strip()}, foundry.toml {want}"
                    )
                    problems += 1

    print(f"{checked} files checked against solc {want}, {problems} need attention")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
