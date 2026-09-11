#!/usr/bin/env python3
"""Verify every commit-pinned code permalink in README.md against the working tree.

Uniswap's fourth qualification requirement is that a reviewer can find the code behind each
claim. A permalink to the wrong lines is worse than none, because it looks checked — and three
of the ten ranges first collected for that table had already drifted by the time anyone read
them back.

Run it after anything that moves code the README points at:

    python3 scripts/check-readme-links.py

It checks that each range starts on a declaration and ends on a closing brace, and that no
referenced file has changed since the pinned commit. A pin older than HEAD is fine on its own —
a docs commit does not move the code — so only a file that actually moved is reported.
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
# `const ` is an opener, and an exported array or arrow constant can never close on a brace — so
# the closers have to admit the ones those produce, or the checker rejects a pin it had already
# agreed was a declaration. It did exactly that for an allowlist pinned as `export const ALLOWED
# = [ … ];`.
CLOSERS = ("}", "})", "];", "] as const;", ");")


def main() -> int:
    readme = (ROOT / "README.md").read_text()
    links = LINK.findall(readme)
    if not links:
        print("no pinned links found — has the README changed shape?")
        return 1

    problems = 0

    # **A permalink is a snapshot, and that is the whole point of pinning one.**
    #
    # The ranges are therefore checked against the file *as it was in the commit each link
    # pins*, not against the working tree. A pin whose lines were right when it was made stays
    # right forever, however much the file moves afterwards.
    #
    # This started out the other way round and it was wrong twice over. It failed CI on `main`
    # every time a merge touched a pinned file, which is a check that fails for doing its job;
    # and it could have passed a genuinely broken pin, because it never looked at what the pin
    # actually points at.
    #
    # A file that has moved since its pin is reported as INFO. It is worth knowing — a pin can
    # go stale enough to mislead even while remaining accurate — but it is a judgement call
    # about freshness, not a defect, so it does not fail.
    def blob(sha: str, rel: str) -> list[str] | None:
        got = subprocess.run(
            ["git", "show", f"{sha}:{rel}"], cwd=ROOT, capture_output=True, text=True
        )
        return None if got.returncode != 0 else got.stdout.split("\n")

    for sha, rel, start, end in links:
        a, b = int(start), int(end)
        lines = blob(sha, rel)
        if lines is None:
            # Either the commit is missing (a shallow clone) or the path did not exist in it.
            # Both mean this pin cannot be trusted, and both are worth failing on.
            print(f"UNRESOLVED {rel}#L{a}-L{b} at {sha[:8]} — fetch the commit, or the pin is wrong")
            problems += 1
            continue
        if b > len(lines):
            print(f"PAST EOF  {rel}#L{a}-L{b} at {sha[:8]} ({len(lines)} lines in that commit)")
            problems += 1
            continue
        first, last = lines[a - 1].strip(), lines[b - 1].strip()
        if not first.startswith(OPENERS) or last not in CLOSERS:
            print(f"BROKEN    {rel}#L{a}-L{b} at {sha[:8]} does not bracket a declaration")
            print(f"          first: {first[:68]}")
            print(f"          last:  {last[:68]}")
            problems += 1

    # Freshness, reported and not enforced. Grouped per pin so that re-pinning one file does not
    # report every other pin as stale.
    by_sha: dict[str, set[str]] = {}
    for sha, rel, _, _ in links:
        by_sha.setdefault(sha, set()).add(rel)
    stale = 0
    for sha, referenced in sorted(by_sha.items()):
        moved = subprocess.run(
            ["git", "diff", "--name-only", sha, "HEAD", "--", *sorted(referenced)],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        if moved.returncode == 0 and moved.stdout.strip():
            for changed in moved.stdout.strip().split("\n"):
                print(f"INFO      {changed} has moved since its pin {sha[:8]} — link still valid")
                stale += 1

    suffix = f", {stale} pin(s) older than the file" if stale else ""
    print(f"{len(links)} links checked, {problems} broken{suffix}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
