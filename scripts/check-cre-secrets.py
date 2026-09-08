#!/usr/bin/env python3
"""The ids that get packed must be exactly the ids that get read.

`apps/cre/secrets.yaml` declares one secret, `HELICO_VAULT`, holding a JSON document of every
value the workflow needs — see that file for the three measurements that forced one item. The
split-upload check this script used to perform went with the subset files.

What replaced it is the same shape of bug one level down. The packing list lives in
`scripts/pack-cre-vault.py`; the reading list lives in the workflow source, spread across
`POLICY_SECRET_IDS`, `AI_SECRET_IDS` and the `agentKeySecretId` default. Two lists, edited
separately, and neither side fails until a deployed run does:

  - packed, never read   ->  a value sits in the enclave that nothing asks for
  - read, never packed   ->  `HELICO_VAULT has no <ID>`, on the DON, after a paid deploy

Raised by @rifkyeasy reviewing #232 against the split-upload version, and the reasoning carries
over unchanged: the CLI states one limit, the other side states nothing, and the only defence is
a check on the shape rather than on the result.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "apps" / "cre" / "secrets.yaml"
PACKER = ROOT / "scripts" / "pack-cre-vault.py"
SRC = ROOT / "packages" / "plugins" / "cre" / "src"

# `NAME:` at four spaces, which is how every entry under `secretsNames:` is written.
ENTRY = re.compile(r"^    ([A-Z][A-Z0-9_]*):$", re.M)
# `key: 'ID',` inside a SECRET_IDS table.
TABLE_ID = re.compile(r"^\t\w+: '([A-Z][A-Z0-9_]*)',$", re.M)
PACKED_ID = re.compile(r'^    "([A-Z][A-Z0-9_]*)",$', re.M)


def table(path: Path, name: str) -> set[str]:
    text = path.read_text()
    start = text.index(f"export const {name} = {{")
    return set(TABLE_ID.findall(text[start : text.index("} as const", start)]))


def main() -> int:
    for path in (MANIFEST, PACKER):
        if not path.exists():
            print(f"missing: {path}")
            return 1

    declared = set(ENTRY.findall(MANIFEST.read_text()))
    if declared != {"HELICO_VAULT"}:
        print(f"manifest declares {sorted(declared)}; the DON serves one retrieval, so expected")
        print("exactly HELICO_VAULT — see apps/cre/secrets.yaml")
        return 1

    packed = set(PACKED_ID.findall(PACKER.read_text()))
    if not packed:
        print(f"no ids found in {PACKER}; the IDS list moved or changed shape")
        return 1

    index = (SRC / "index.ts").read_text()
    agent_key = re.search(r"agentKeySecretId: z\.string\(\)\.default\('([A-Z_]+)'\)", index)
    if not agent_key:
        print("could not find the agentKeySecretId default in index.ts")
        return 1

    read = table(SRC / "policy.ts", "POLICY_SECRET_IDS") | table(SRC / "ai.ts", "AI_SECRET_IDS")
    read.add(agent_key.group(1))

    if packed != read:
        # Named, both directions. A count would say "one side has more" and stop there.
        for missing in sorted(read - packed):
            print(f"read but never packed: {missing} — a deployed run fails with 'has no {missing}'")
        for extra in sorted(packed - read):
            print(f"packed but never read: {extra}")
        return 1

    print(f"{len(read)} ids, packed and read: {', '.join(sorted(read))}")
    print("manifest declares HELICO_VAULT, and nothing else")
    return 0


if __name__ == "__main__":
    sys.exit(main())
