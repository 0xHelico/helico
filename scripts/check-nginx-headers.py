#!/usr/bin/env python3
"""Every nginx location that sets a header must also include the security headers.

nginx's `add_header` does not merge. A `location` that sets any header of its own discards every
one inherited from the server block, so a location added for a `Cache-Control` silently drops the
CSP, the framing refusal and the rest — and nothing about the response says what it should have
carried. The loss is invisible until somebody measures production, which is how it was found:
a stylesheet came back with two headers of five.

This is the rule stated once, so the next location cannot forget it quietly.
"""

import re
import sys
from pathlib import Path

CONF = Path(__file__).resolve().parent.parent / "apps/landing/nginx.conf"
SNIPPET = "include /etc/nginx/security-headers.conf;"


def blocks(text: str) -> list[tuple[str, str]]:
    """Every `location …{ … }` as (header line, body). Brace-counted, not regex-matched."""
    found = []
    for match in re.finditer(r"^\s*(location\b[^{]*)\{", text, re.M):
        depth, i = 1, match.end()
        while i < len(text) and depth:
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
            i += 1
        found.append((match.group(1).strip(), text[match.end() : i - 1]))
    return found


def main() -> int:
    text = CONF.read_text()
    problems: list[str] = []

    # The server block itself, for anything reaching no location that adds a header.
    outside = re.sub(r"^\s*location\b[^{]*\{.*?^\s*\}", "", text, flags=re.M | re.S)
    if SNIPPET not in outside:
        problems.append(f"{CONF.name}: the server block does not include the security headers")

    for name, body in blocks(text):
        if "add_header" not in body:
            # Adds nothing, so it inherits the server block's set intact.
            continue
        if SNIPPET not in body:
            problems.append(
                f"{CONF.name}: `{name}` sets a header of its own, so nginx drops every inherited "
                f"one — it must also `{SNIPPET}`"
            )

    # A header written straight into the file is a header that will be missing somewhere else.
    for line_no, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith("add_header") and "Cache-Control" not in stripped:
            problems.append(
                f"{CONF.name}:{line_no}: security headers belong in security-headers.conf, "
                f"where every location gets them: {stripped[:60]}"
            )

    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        return 1
    print(f"{CONF.name}: every location that adds a header includes the security headers")
    return 0


if __name__ == "__main__":
    sys.exit(main())
