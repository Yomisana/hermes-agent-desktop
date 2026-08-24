#!/usr/bin/env python3
"""Apply explicitly reviewed, SHA-pinned server backports to a clean checkout."""

import argparse
import json
import subprocess
from pathlib import Path


def git(checkout: Path, *args: str, capture: bool = False) -> str:
    result = subprocess.run(
        ["git", "-C", str(checkout), *args],
        check=True,
        text=True,
        capture_output=capture,
    )
    return result.stdout.strip() if capture else ""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("checkout", type=Path, help="Clean Hermes Agent checkout")
    parser.add_argument("manifest", type=Path, help="Reviewed backport manifest")
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    if git(args.checkout, "status", "--porcelain", capture=True):
        raise SystemExit("refusing to apply backports to a dirty checkout")

    actual = git(args.checkout, "rev-parse", "HEAD", capture=True)
    expected = manifest["upstreamCommitSha"]
    if actual != expected:
        raise SystemExit(f"checkout is {actual}; manifest requires {expected}")

    enabled = [item for item in manifest["backports"] if item.get("enabled")]
    if not enabled:
        raise SystemExit("manifest has no enabled, reviewed backports")

    for item in enabled:
        if not item.get("reviewedBy") or not item.get("reviewedAt"):
            raise SystemExit(f'{item["id"]}: reviewedBy and reviewedAt are required')
        head = item.get("pullRequestHeadSha", "")
        if len(head) != 40:
            raise SystemExit(f'{item["id"]}: pullRequestHeadSha must be a full 40-character SHA')
        pull_ref = f'refs/pull/{item["pullRequest"]}/head'
        git(args.checkout, "fetch", "--no-tags", item["sourceRepository"], pull_ref)
        fetched = git(args.checkout, "rev-parse", "FETCH_HEAD", capture=True)
        if fetched != head:
            raise SystemExit(f'{item["id"]}: PR head moved to {fetched}; reviewed head was {head}')
        for commit in item["commits"]:
            if len(commit) != 40:
                raise SystemExit(f'{item["id"]}: every commit must be a full 40-character SHA')
            git(args.checkout, "merge-base", "--is-ancestor", commit, fetched)
            git(args.checkout, "cherry-pick", "-x", commit)

    print(f"applied {len(enabled)} reviewed server backport group(s)")


if __name__ == "__main__":
    main()
