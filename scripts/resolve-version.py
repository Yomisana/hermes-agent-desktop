#!/usr/bin/env python3
"""Resolve the upstream pin and the overlay version this run should ship.

Three inputs decide the release tag:

* the newest tag on the upstream repository — a new upstream release resets
  the overlay counter to 0, because the binaries are rebuilt from new sources;
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
def _python_version(blob: str) -> str | None:
    match = re.search(r'^__version__\s*=\s*["\'](.+?)["\']', blob, re.MULTILINE)
    return match.group(1) if match else None


def _toml_version(blob: str) -> str | None:
    match = re.search(r'^version\s*=\s*["\'](.+?)["\']', blob, re.MULTILINE)
    return match.group(1) if match else None


def _json_version(blob: str) -> str | None:
    try:
        return json.loads(blob).get("version")
    except json.JSONDecodeError:
        return None


# Tried in order; the first hit wins.
VERSION_SOURCES = (
    ("hermes_cli/__init__.py", _python_version),
    ("pyproject.toml", _toml_version),
    ("apps/desktop/package.json", _json_version),
)

# A fresh upstream tag starts here; +1 per overlay change after that.
OVERLAY_BASE = 0


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


def read_upstream_version(repository: str, tag: str, fallback: str) -> str:
    """Read the product version upstream ships at `tag`, without a full clone.

    apps/desktop/package.json is NOT the source of truth: it has sat at 0.17.0
    across releases while hermes_cli/__init__.py tracked the actual version
    (0.20.4 at v2026.8.18, 0.21.0 at v2026.8.31). Read the Python version first
    and fall back down the chain, so the installer version matches the release
    users think they are getting.
    """
    if not shutil.which("git"):
        return fallback
    workdir = ROOT / ".upstream-probe"
    shutil.rmtree(workdir, ignore_errors=True)
    try:
        run(["git", "clone", "--depth", "1", "--branch", tag, "--filter=blob:none",
             "--no-checkout", repository, str(workdir)])
        for path, extract in VERSION_SOURCES:
            try:
                blob = run(["git", "-C", str(workdir), "show", f"{tag}:{path}"])
            except SystemExit:
                continue  # file absent at this tag; try the next source
            version = extract(blob)
            if version:
                print(f"upstream version {version} (from {path})")
                return version
        print(f"::warning::no version source found at {tag}; keeping {fallback}")
        return fallback
    except SystemExit:
        print(f"::warning::could not read the upstream version at {tag}; keeping {fallback}")
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


def published_overlays(repo_slug: str, tag_version: str) -> set[int]:
    """Overlay numbers already published for this upstream version.

    Drafts are excluded: nobody has downloaded them, so a draft may be
    refreshed in place. Published releases are immutable.
    """
    if not shutil.which("gh"):
        print("::warning::gh is unavailable; skipping the published-release probe")
        return set()
    raw = run(["gh", "release", "list", "--repo", repo_slug, "--limit", "200",
               "--json", "tagName,isDraft"], check=False)
    try:
        releases = json.loads(raw or "[]")
    except json.JSONDecodeError:
        print("::warning::could not list releases; skipping the published-release probe")
        return set()

    prefix = f"v{tag_version}-remote."
    found = set()
    for release in releases:
        if release["isDraft"] or not release["tagName"].startswith(prefix):
            continue
        suffix = release["tagName"][len(prefix):]
        if suffix.isdigit():
            found.add(int(suffix))
    return found


def resolve(args: argparse.Namespace) -> dict[str, str | int]:
    upstream, manifest, overlay = load_state()

    tag = upstream["tag"]
    tag_object_sha = upstream["tagObjectSha"]
    commit_sha = upstream["commitSha"]
    # desktopPackageVersion is the old key name, still honoured for hand-edited pins.
    upstream_version = upstream.get("upstreamVersion") or upstream.get("desktopPackageVersion")
    if not upstream_version:
        raise SystemExit("upstream.json needs an upstreamVersion")
    overlay_version = int(upstream["overlayVersion"])
    upstream_changed = False

    if args.refresh_upstream:
        found = latest_upstream_tag(upstream["repository"])
        if found and tag_sort_key(found[0]) > tag_sort_key(tag):
            tag, tag_object_sha, commit_sha = found
            # New upstream sources: the overlay counter starts over at 0, so
            # `-remote.0` is the plain rebuild of the new upstream tag and every
            # later number is an overlay change made on top of it.
            overlay_version = OVERLAY_BASE
            upstream_changed = True
            print(f"upstream advanced to {tag}; overlay reset to {OVERLAY_BASE}")

        # Re-read on every refresh, not only when the tag moves: a pin written
        # before this probe existed can carry a stale version.
        upstream_version = read_upstream_version(
            upstream["repository"], tag, upstream_version
        )

    if not upstream_changed and args.count_local_commits and has_local_commits_since_last_bump():
        overlay_version += 1
        print(f"local commits since the last bump; overlay -> {overlay_version}")

    tag_version = tag[1:]
    if args.probe_releases:
        taken = published_overlays(
            args.repo_slug or os.environ.get("GITHUB_REPOSITORY", ""), tag_version
        )
        if overlay_version in taken:
            # A published tag is immutable, and its binaries are already out
            # there. Land above the highest one rather than filling a gap, so
            # the numbers stay monotonic for anyone reading the release list.
            overlay_version = max(taken) + 1
            print(f"overlay already published; overlay -> {overlay_version}")

    changed = (
        tag != upstream["tag"]
        or commit_sha != upstream["commitSha"]
        or overlay_version != upstream["overlayVersion"]
        or upstream_version != upstream.get("upstreamVersion")
    )
    if changed and args.write:
        upstream.pop("desktopPackageVersion", None)
        upstream.update({
            "tag": tag,
            "tagObjectSha": tag_object_sha,
            "commitSha": commit_sha,
            "upstreamVersion": upstream_version,
            "overlayVersion": overlay_version,
        })
        # Keep the file in a stable, readable order regardless of what the
        # previous pin looked like.
        order = ["repository", "tag", "tagObjectSha", "commitSha",
                 "upstreamVersion", "overlayVersion"]
        upstream = {k: upstream[k] for k in order if k in upstream} | {
            k: v for k, v in upstream.items() if k not in order
        }
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
        "upstream_version": upstream_version,
        "desktop_build_version": f"{upstream_version}-remote.{overlay_version}",
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
