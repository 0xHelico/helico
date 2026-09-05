#!/usr/bin/env python3
"""Verify every commit-pinned code permalink in README.md against the working tree.

Uniswap's fourth qualification requirement is that a reviewer can find the code behind each
claim. A permalink to the wrong lines is worse than none, because it looks checked — and three
of the ten ranges first collected for that table had already drifted by the time anyone read
them back.

Run it after anything that moves code the README points at:

    python3 scripts/check-readme-links.py

It checks that each range starts on a declaration and ends on a closing brace, and that the
pinned commit is the one the working tree is on. It does not fetch the commit: the point is to
catch drift before the pin is updated, not to trust the pin.
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LINK = re.compile(
    r"\]\(https://github\.com/0xHelico/helico/blob/([0-9a-f]{40})/([^\#\)]+)#L(\d+)-L(\d+)\)"
)
OPENERS = ("export ", "function ", "struct ", "Actions.", "const ")
CLOSERS = ("}", "})")


def main() -> int:
    readme = (ROOT / "README.md").read_text()
    links = LINK.findall(readme)
    if not links:
        print("no pinned links found — has the README changed shape?")
        return 1

    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True
    ).stdout.strip()

    problems = 0
    pins = {sha for sha, _, _, _ in links}
    for sha in pins:
        if sha != head:
            print(f"pin {sha[:8]} is not HEAD ({head[:8]}) — re-verify before updating it")

    for sha, rel, start, end in links:
        a, b = int(start), int(end)
        path = ROOT / rel
        if not path.exists():
            print(f"MISSING  {rel}")
            problems += 1
            continue
        lines = path.read_text().split("\n")
        if b > len(lines):
            print(f"PAST EOF {rel}#L{a}-L{b} ({len(lines)} lines)")
            problems += 1
            continue
        first, last = lines[a - 1].strip(), lines[b - 1].strip()
        if not first.startswith(OPENERS) or last not in CLOSERS:
            print(f"DRIFTED  {rel}#L{a}-L{b}")
            print(f"         first: {first[:70]}")
            print(f"         last:  {last[:70]}")
            problems += 1

    print(f"{len(links)} links checked, {problems} need attention")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
