#!/usr/bin/env python3
"""Pack every CRE secret into the one item the Vault DON will actually serve.

WHY ONE ITEM. Measured three times against the deployed workflow, not inferred:

  - eleven ids in one batch  ->  `batch secret retrieval failed for 11 request(s)`
  - ten in one batch         ->  the same failure, with only the count changed
  - one call per secret      ->  call 0 succeeded, call 1 failed, twice, deterministically

Chainlink's Confidential Workflows reference names one-call-per-secret as the TypeScript shape,
and that is what the third measurement tried. The DON answers one retrieval per execution, so the
only shape all three measurements leave standing is one request carrying one item.

So the eleven values travel as one JSON document under `SECRET_HELICO_VAULT`, and this script is
what builds it. Run it after changing any `SECRET_*` value, then `cre secrets update`.

VALUES ARE NEVER PRINTED. This reads `apps/cre/.env` and writes back to the same file. Nothing
but ids and counts reaches stdout — the file is gitignored and stays that way.
"""

import json
import re
import sys
from pathlib import Path

ENV = Path(__file__).resolve().parent.parent / "apps" / "cre" / ".env"
MANIFEST = Path(__file__).resolve().parent.parent / "apps" / "cre" / "secrets.yaml"
PACKED = "SECRET_HELICO_VAULT"

# The ids the workflow unpacks. Kept beside the manifest check below so the two cannot drift.
IDS = [
    "IDLE_TARGET_WORKING_BPS",
    "IDLE_MIN_IDLE_AMOUNT",
    "IDLE_MIN_MOVE_AMOUNT",
    "IDLE_MIN_MOVE_BPS",
    "IDLE_MIN_SUPPLY_RATE_RAY",
    "IDLE_MAX_MOVE_AMOUNT",
    "IDLE_EXPIRY",
    "AGENT_KEY",
    "AI_USERNAME",
    "AI_PASSWORD",
    "AI_API_KEY",
]

LINE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")


def unquote(raw: str) -> str:
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        return raw[1:-1]
    return raw


def main() -> int:
    if not ENV.exists():
        print(f"missing {ENV}")
        return 1

    lines = ENV.read_text().splitlines()
    env: dict[str, str] = {}
    for line in lines:
        m = LINE.match(line)
        if m and not line.lstrip().startswith("#"):
            env[m.group(1)] = unquote(m.group(2))

    missing = [i for i in IDS if f"SECRET_{i}" not in env]
    if missing:
        # Named, not counted. A count is what made three wrong hypotheses possible.
        print("not set in apps/cre/.env: " + ", ".join(missing))
        return 1

    blob = {i: env[f"SECRET_{i}"] for i in IDS}
    payload = json.dumps(blob, separators=(",", ":"), sort_keys=True)
    if "'" in payload:
        # Single quotes wrap the value in .env, so a value containing one would end it early and
        # the CLI would upload a truncated document that parses as valid JSON right up to the cut.
        print("a value contains a single quote; wrap it differently before packing")
        return 1

    kept = [ln for ln in lines if not LINE.match(ln) or LINE.match(ln).group(1) != PACKED]
    while kept and not kept[-1].strip():
        kept.pop()
    kept += ["", f"# Built by scripts/pack-cre-vault.py — do not edit by hand.", f"{PACKED}='{payload}'"]
    ENV.write_text("\n".join(kept) + "\n")

    # Ids and sizes only.
    print(f"packed {len(IDS)} values into {PACKED} ({len(payload)} bytes)")
    print("  " + ", ".join(IDS))

    declared = set(re.findall(r"^    ([A-Z][A-Z0-9_]*):$", MANIFEST.read_text(), re.M))
    if declared != {"HELICO_VAULT"}:
        print(f"manifest declares {sorted(declared)}, expected exactly HELICO_VAULT")
        return 1
    print("manifest declares HELICO_VAULT, and nothing else")
    return 0


if __name__ == "__main__":
    sys.exit(main())
