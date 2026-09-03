#!/usr/bin/env python3
"""Resolve the upstream pin and the overlay version this run should ship.

Three inputs decide the release tag:

* the newest tag on the upstream repository — a new upstream release resets
  the overlay counter, because the binaries are rebuilt from new sources;
* the commits landed in this repository since the last version bump — overlay
  changes that nobody has released yet need a fresh tag;
* the tags already published on this repository — a published tag is immutable,
  so the counter walks forward until it lands on a free one.

Without --refresh-upstream / --probe-releases the script is offline and behaves
purely a reader: it just echoes the values pinned in upstream.json.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
UPSTREAM_JSON = ROOT / "upstream.json"
MANIFEST_JSON = ROOT / "patches" / "manifest.json"
OVERLAY_PATCH_ID = "desktop-remote-only"
# Upstream ships calendar tags (v2026.8.18); anything else is ignored so a
# stray refs/tags/nightly cannot drag the pin forward.
TAG_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
MAX_OVERLAY_PROBE = 50


def run(cmd: list[str], *, check: bool = True) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise SystemExit(f"command failed: {' '.join(cmd)}\n{result.stderr.strip()}")
    return result.stdout


def tag_sort_key(tag: str) -> tuple[int, ...]:
    return tuple(int(part) for part in TAG_RE.match(tag).groups())


def load_state() -> tuple[dict, dict, dict]:
    upstream = json.loads(UPSTREAM_JSON.read_text(encoding="utf-8"))
    manifest = json.loads(MANIFEST_JSON.read_text(encoding="utf-8"))
    overlay = next(p for p in manifest["patches"] if p["id"] == OVERLAY_PATCH_ID)

    if overlay["version"] != upstream["overlayVersion"]:
        raise SystemExit("overlay version differs between upstream.json and patches/manifest.json")
    if not TAG_RE.match(upstream["tag"]):
        raise SystemExit(f"upstream tag must look like v2026.8.18, got {upstream['tag']!r}")
    if len(upstream["commitSha"]) != 40:
        raise SystemExit("upstream commitSha must be a full 40-character SHA")

    return upstream, manifest, overlay


def latest_upstream_tag(repository: str) -> tuple[str, str, str] | None:
    """Return (tag, tagObjectSha, commitSha) for the newest upstream release tag."""
    refs = run(["git", "ls-remote", "--tags", repository], check=False)
    if not refs.strip():
        print("::warning::could not list upstream tags; keeping the pinned tag")
        return None

    objects: dict[str, str] = {}
    peeled: dict[str, str] = {}
    for line in refs.splitlines():
        sha, _, ref = line.partition("\t")
        name = ref.removeprefix("refs/tags/")
        if name.endswith("^{}"):
            peeled[name[:-3]] = sha
        else:
            objects[name] = sha

    candidates = [name for name in objects if TAG_RE.match(name)]
    if not candidates:
        print("::warning::upstream exposes no release tags; keeping the pinned tag")
        return None

    newest = max(candidates, key=tag_sort_key)
    tag_object = objects[newest]
    # Annotated tags peel to the commit; lightweight tags already point at one.
    return newest, tag_object, peeled.get(newest, tag_object)


def upstream_desktop_version(repository: str, tag: str, fallback: str) -> str:
    """Read apps/desktop/package.json at `tag` without a full clone."""
    if not shutil.which("git"):
        return fallback
    workdir = ROOT / ".upstream-probe"
    shutil.rmtree(workdir, ignore_errors=True)
    try:
        run(["git", "clone", "--depth", "1", "--branch", tag, "--filter=blob:none",
             "--no-checkout", repository, str(workdir)])
        blob = run(["git", "-C", str(workdir), "show", f"{tag}:apps/desktop/package.json"])
        return json.loads(blob)["version"]
    except (SystemExit, json.JSONDecodeError, KeyError):
        print(f"::warning::could not read desktop package version at {tag}; keeping {fallback}")
        return fallback
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def has_local_commits_since_last_bump() -> bool:
    """True when this repo moved on after the commit that last set overlayVersion."""
    last_bump = run(["git", "log", "-1", "--format=%H", "--", "upstream.json"], check=False).strip()
    if not last_bump:
        print("::warning::no history for upstream.json; not counting local commits")
        return False
    count = run(["git", "rev-list", "--count", f"{last_bump}..HEAD"], check=False).strip()
    return count.isdigit() and int(count) > 0


def published_tags(repo_slug: str) -> set[str]:
    """Release tags on this repo that are no longer drafts, hence immutable."""
    if not shutil.which("gh"):
        print("::warning::gh is unavailable; skipping the published-release probe")
        return set()
    raw = run(["gh", "release", "list", "--repo", repo_slug, "--limit", "200",
               "--json", "tagName,isDraft"], check=False)
    try:
        return {r["tagName"] for r in json.loads(raw or "[]") if not r["isDraft"]}
    except json.JSONDecodeError:
        print("::warning::could not list releases; skipping the published-release probe")
        return set()


def resolve(args: argparse.Namespace) -> dict[str, str | int]:
    upstream, manifest, overlay = load_state()

    tag = upstream["tag"]
    tag_object_sha = upstream["tagObjectSha"]
    commit_sha = upstream["commitSha"]
    desktop_version = upstream["desktopPackageVersion"]
    overlay_version = int(upstream["overlayVersion"])
    upstream_changed = False

    if args.refresh_upstream:
        found = latest_upstream_tag(upstream["repository"])
        if found and tag_sort_key(found[0]) > tag_sort_key(tag):
            tag, tag_object_sha, commit_sha = found
            desktop_version = upstream_desktop_version(
                upstream["repository"], tag, desktop_version
            )
            # New upstream sources: the overlay counter starts over at 1.
            overlay_version = 1
            upstream_changed = True
            print(f"upstream advanced to {tag}; overlay reset to 1")

    if not upstream_changed and args.count_local_commits and has_local_commits_since_last_bump():
        overlay_version += 1
        print(f"local commits since the last bump; overlay -> {overlay_version}")

    tag_version = tag[1:]
    if args.probe_releases:
        taken = published_tags(args.repo_slug or os.environ.get("GITHUB_REPOSITORY", ""))
        probed = 0
        while f"v{tag_version}-remote.{overlay_version}" in taken:
            overlay_version += 1
            probed += 1
            if probed > MAX_OVERLAY_PROBE:
                raise SystemExit("could not find a free overlay version")
        if probed:
            print(f"skipped {probed} published tag(s); overlay -> {overlay_version}")

    changed = (
        tag != upstream["tag"]
        or commit_sha != upstream["commitSha"]
        or overlay_version != upstream["overlayVersion"]
    )
    if changed and args.write:
        upstream.update({
            "tag": tag,
            "tagObjectSha": tag_object_sha,
            "commitSha": commit_sha,
            "desktopPackageVersion": desktop_version,
            "overlayVersion": overlay_version,
        })
        overlay["version"] = overlay_version
        UPSTREAM_JSON.write_text(json.dumps(upstream, indent=2) + "\n", encoding="utf-8")
        MANIFEST_JSON.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    return {
        "upstream_repo": upstream["repository"],
        "upstream_tag": tag,
        "upstream_sha": commit_sha,
        "overlay_version": overlay_version,
        "upstream_changed": "true" if upstream_changed else "false",
        "state_changed": "true" if changed else "false",
        "desktop_build_version": f"{desktop_version}-remote.{overlay_version}",
        "release_tag": f"v{tag_version}-remote.{overlay_version}",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--github-output", type=Path)
    parser.add_argument("--refresh-upstream", action="store_true",
                        help="look for a newer upstream release tag")
    parser.add_argument("--count-local-commits", action="store_true",
                        help="bump the overlay when this repo moved since the last bump")
    parser.add_argument("--probe-releases", action="store_true",
                        help="skip overlay versions whose release tag is already published")
    parser.add_argument("--repo-slug", help="OWNER/REPO for the release probe")
    parser.add_argument("--write", action="store_true",
                        help="persist the resolved values to upstream.json and the manifest")
    args = parser.parse_args()

    versions = resolve(args)
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as output:
            for key, value in versions.items():
                output.write(f"{key}={value}\n")
    else:
        print(json.dumps(versions, indent=2))


if __name__ == "__main__":
    main()
