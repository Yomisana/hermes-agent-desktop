#!/usr/bin/env python3
"""Validate the pinned upstream release and expose deterministic build versions."""

import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_versions() -> dict[str, str | int]:
    upstream = json.loads((ROOT / "upstream.json").read_text(encoding="utf-8"))
    manifest = json.loads((ROOT / "patches" / "manifest.json").read_text(encoding="utf-8"))
    overlay = next(p for p in manifest["patches"] if p["id"] == "desktop-remote-only")

    if overlay["version"] != upstream["overlayVersion"]:
        raise SystemExit("overlay version differs between upstream.json and patches/manifest.json")
    if not upstream["tag"].startswith("v"):
        raise SystemExit("upstream tag must start with 'v'")
    if len(upstream["commitSha"]) != 40:
        raise SystemExit("upstream commitSha must be a full 40-character SHA")

    tag_version = upstream["tag"][1:]
    overlay_version = upstream["overlayVersion"]
    return {
        "upstream_repo": upstream["repository"],
        "upstream_tag": upstream["tag"],
        "upstream_sha": upstream["commitSha"],
        "desktop_build_version": f'{upstream["desktopPackageVersion"]}-remote.{overlay_version}',
        "release_tag": f"v{tag_version}-remote.{overlay_version}",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args()
    versions = load_versions()

    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as output:
            for key, value in versions.items():
                output.write(f"{key}={value}\n")
    else:
        print(json.dumps(versions, indent=2))


if __name__ == "__main__":
    main()
