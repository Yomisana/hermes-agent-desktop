#!/usr/bin/env python3
"""Apply the remote-only bootstrap patch to upstream main.ts.

String-anchored (not line-numbered) so it survives upstream drift; fails
loudly if an anchor is missing or ambiguous instead of silently half-applying.
"""
import sys


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


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: apply-patch.py <main.ts>")
    apply(sys.argv[1])
