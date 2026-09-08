#!/usr/bin/env python3
"""The upload files must add up to the manifest, exactly.

`apps/cre/secrets.yaml` is the manifest: `workflow.yaml` names it, and it declares every secret
the workflow may ask for. It is never uploaded, because `cre secrets create` refuses more than ten
items in one payload and there are eleven — the upload runs from the `secrets-upload-*.yaml`
subsets instead.

Two files that must agree and are edited separately will stop agreeing. Both directions cost
something real, and neither is visible until a deployed run fails:

  - in the manifest, not uploaded  →  the DON has no such secret, and the workflow that declared
    it fails at retrieval with `relay quorum unreachable`, which reads like an outage
  - uploaded, not in the manifest  →  a secret sits in the Vault DON that nothing may ask for

Raised by @rifkyeasy reviewing #232, and it is the same shape as the bug that made it necessary:
the CLI states one limit, the other side states nothing, and the only defence is a check on the
shape rather than on the result.
"""

import re
import sys
from pathlib import Path

CRE = Path(__file__).resolve().parent.parent / "apps" / "cre"
MANIFEST = CRE / "secrets.yaml"
UPLOADS = sorted(CRE.glob("secrets-upload-*.yaml"))

# `NAME:` at four spaces, which is how every entry under `secretsNames:` is written.
ENTRY = re.compile(r"^    ([A-Z][A-Z0-9_]*):$", re.M)


def names(path: Path) -> set[str]:
    return set(ENTRY.findall(path.read_text()))


def main() -> int:
    if not MANIFEST.exists():
        print(f"missing manifest: {MANIFEST}")
        return 1
    if not UPLOADS:
        print("no secrets-upload-*.yaml found; the manifest is never uploaded on its own")
        return 1

    manifest = names(MANIFEST)
    uploaded: dict[str, Path] = {}
    duplicated = []
    for path in UPLOADS:
        for name in names(path):
            if name in uploaded:
                duplicated.append((name, uploaded[name].name, path.name))
            uploaded[name] = path

    missing = sorted(manifest - set(uploaded))
    extra = sorted(set(uploaded) - manifest)
    # The limit the split exists for. A file that has grown past it uploads nothing at all.
    oversized = [(p.name, len(names(p))) for p in UPLOADS if len(names(p)) > 10]

    for name in missing:
        print(f"declared but never uploaded: {name}")
    for name in extra:
        print(f"uploaded but not declared:   {name} (in {uploaded[name].name})")
    for name, a, b in duplicated:
        print(f"uploaded twice:              {name} (in {a} and {b})")
    for name, count in oversized:
        print(f"over the ten-item payload limit: {name} has {count}")

    if missing or extra or duplicated or oversized:
        return 1
    print(f"cre secrets: {len(manifest)} declared, all uploaded exactly once")
    return 0


if __name__ == "__main__":
    sys.exit(main())
