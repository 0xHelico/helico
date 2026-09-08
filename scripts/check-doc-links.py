#!/usr/bin/env python3
"""Every relative link in the documentation points at something that exists.

`check-readme-links.py` verifies commit-pinned permalinks, which are snapshots and stay true by
construction. This is its blind spot: an ordinary `[text](../path)` rots the moment the file moves
or is deleted, and nothing notices. #247 deleted 21 files in one change, and the only reason no
link broke is that nobody had pointed at them.

One did break, in a README written the same day: `packages/plugins/thegraph` linked
`../../subgraph/`, which lands in `packages/` rather than at the repository root. A link that
resolves to the wrong place reads as checked, which is the same failure a stale permalink has.

Fenced code is skipped. Solidity's `new bytes[](2)` looks exactly like a markdown link and is
not one — the first version of this script reported two of those and one real defect, and a
checker with a two-thirds false-positive rate is a checker people learn to ignore.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP = {"node_modules", ".next", "dist", "out", "out-swapvm", "lib", ".git"}
FENCE = re.compile(r"^\s*(```|~~~)", re.M)
LINK = re.compile(r"\[[^\]]*\]\((?!https?:|mailto:|#)([^)\s]+)\)")


INLINE = re.compile(r"`[^`\n]*`")


def without_code(text: str) -> str:
    """The document with code blanked, so code that looks like a link is not read as one.

    Both kinds. `new Venue[](0)` inside backticks is as convincing to a regex as a fenced block
    is, and it was the last false positive left after the fences were handled.
    """
    out, fenced = [], False
    for line in text.split("\n"):
        if FENCE.match(line):
            fenced = not fenced
            out.append("")
            continue
        out.append("" if fenced else INLINE.sub("``", line))
    return "\n".join(out)


def main() -> int:
    files = [
        p
        for p in ROOT.rglob("*.md")
        if not SKIP & set(p.relative_to(ROOT).parts)
    ]
    checked = problems = 0
    for path in sorted(files):
        for match in LINK.finditer(without_code(path.read_text(errors="ignore"))):
            target = match.group(1).split("#")[0]
            if not target:
                continue
            checked += 1
            if not (path.parent / target).resolve().exists():
                problems += 1
                print(f"{path.relative_to(ROOT)}: {target} does not exist", file=sys.stderr)

    if problems:
        print(f"\n{problems} of {checked} relative links point at nothing", file=sys.stderr)
        return 1
    print(f"{checked} relative links checked across {len(files)} files, all resolve")
    return 0


if __name__ == "__main__":
    sys.exit(main())
