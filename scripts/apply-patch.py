#!/usr/bin/env python3
"""Apply the remote-only desktop overlay to a pinned upstream checkout.

String-anchored (not line-numbered) so it survives upstream drift; fails
loudly if an anchor is missing or ambiguous instead of silently half-applying.
"""
import json
import sys
from pathlib import Path


def apply(path: str) -> None:
    with open(path, encoding="utf-8") as f:
        src = f.read()

    edits = [
        (
            "import { createFirstRunSetupGate } from './first-run-setup-gate'\n",
            "import { createFirstRunSetupGate } from './first-run-setup-gate'\n"
            "import { shouldSkipAutoBootstrap, bootstrapSkippedError } from './remote-bootstrap-policy'\n"
            "import { seedRemoteConnectionIfMissing } from './remote-seed-connection'\n",
        ),
        (
            "  void ensureLoginShellPath()\n",
            "  void ensureLoginShellPath()\n"
            "\n"
            "  // Remote-only build: seed a company remote connection (if shipped with this\n"
            "  // build) before anything reads connection.json. No-op on stock/official builds.\n"
            "  seedRemoteConnectionIfMissing({\n"
            "    connectionConfigPath: DESKTOP_CONNECTION_CONFIG_PATH,\n"
            "    resourcesPath: process.resourcesPath,\n"
            "    log: rememberLog\n"
            "  })\n",
        ),
        (
            "    rememberLog('[bootstrap] no Hermes install found; starting first-launch bootstrap')\n",
            "    rememberLog('[bootstrap] no Hermes install found; starting first-launch bootstrap')\n"
            "\n"
            "    // Remote-only builds never auto-install a local runtime.\n"
            "    if (shouldSkipAutoBootstrap()) {\n"
            "      const err = bootstrapSkippedError(backend.activeRoot)\n"
            "      bootstrapFailure = err\n"
            "      throw err\n"
            "    }\n",
        ),
    ]

    for anchor, replacement in edits:
        n = src.count(anchor)
        if n != 1:
            sys.exit(
                f"anchor not found or ambiguous ({n}x) in {path}: {anchor[:60]!r}"
            )
        src = src.replace(anchor, replacement)

    with open(path, "w", encoding="utf-8") as f:
        f.write(src)
    print("patch applied OK")


def include_seed_resource(package_json_path: str) -> None:
    path = Path(package_json_path)
    package = json.loads(path.read_text(encoding="utf-8"))
    resources = package["build"]["extraResources"]
    seed = {"from": "build-resources/connection.seed.json", "to": "connection.seed.json"}

    matching = [item for item in resources if item.get("to") == seed["to"]]
    if matching:
        if matching != [seed]:
            sys.exit("connection.seed.json extraResource exists with an unexpected source")
        print("seed resource already included")
        return

    resources.append(seed)
    path.write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")
    print("seed resource included OK")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: apply-patch.py <main.ts> <package.json>")
    apply(sys.argv[1])
    include_seed_resource(sys.argv[2])
