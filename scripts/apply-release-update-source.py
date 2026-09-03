#!/usr/bin/env python3
"""Point desktop update checks at this repo's releases instead of a git checkout.

Upstream's checkUpdates() bails out with "isn't a git checkout — desktop
self-update only runs against a source install" whenever the backend's hermes
root has no .git. Packaged overlay builds are always in that state, so the
update panel shows an error where a status belongs. Swap that branch for a
lookup against our own GitHub releases (report only, never self-update).

String-anchored like the other overlay patches: fails loudly rather than
half-applying. Must run AFTER apply-patch.py — it anchors on the import that
patch inserts, so a silent ordering change is caught here.
"""
import sys

REMOTE_ONLY_IMPORT = (
    "import { shouldSkipAutoBootstrap, bootstrapSkippedError } "
    "from './remote-bootstrap-policy'\n"
)

NOT_A_CHECKOUT = """  if (!directoryExists(gitDir)) {
    return {
      supported: false,
      reason: 'not-a-git-checkout',
      message: `${updateRoot} isn't a git checkout — desktop self-update only runs against a source install.`,
      hermesRoot: updateRoot,
      branch
    }
  }
"""

RELEASE_LOOKUP = """  if (!directoryExists(gitDir)) {
    // Overlay: this build ships as an installer, so there is no source checkout
    // to git-pull. Report against the releases this build actually comes from.
    return await checkReleaseUpdate({
      currentVersion: app.getVersion(),
      hermesRoot: updateRoot,
      branch
    })
  }
"""


def apply(path: str) -> None:
    with open(path, encoding="utf-8") as f:
        src = f.read()

    edits = [
        (
            REMOTE_ONLY_IMPORT,
            REMOTE_ONLY_IMPORT
            + "import { checkReleaseUpdate } from './release-update-source'\n",
        ),
        (NOT_A_CHECKOUT, RELEASE_LOOKUP),
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
    print("release-update-source patch applied OK")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: apply-release-update-source.py <main.ts>")
    apply(sys.argv[1])
