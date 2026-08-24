#!/usr/bin/env bash
# One-time setup: fork hermes-agent, apply the remote-only patch, create the
# remote-only branch, and push. Run this once from your own machine
# (with your GitHub fork already created via the GitHub UI).
#
# Usage:
#   ./setup-fork.sh git@github.com:your-org/hermes-agent.git
set -euo pipefail

FORK_URL="${1:?Usage: setup-fork.sh <your-fork-git-url>}"
UPSTREAM_URL="https://github.com/NousResearch/hermes-agent.git"
WORKDIR="hermes-agent"

if [ ! -d "$WORKDIR" ]; then
  git clone "$UPSTREAM_URL" "$WORKDIR"
fi

cd "$WORKDIR"
git remote remove origin 2>/dev/null || true
git remote add origin "$FORK_URL"
git remote remove upstream 2>/dev/null || true
git remote add upstream "$UPSTREAM_URL"

git checkout -b remote-only main

# Copy the policy file into the checkout
cp ../apps/desktop/electron/remote-bootstrap-policy.ts apps/desktop/electron/

echo ""
echo "Now manually apply the ~8-line diff in patches/0001-skip-bootstrap.patch"
echo "to apps/desktop/electron/main.ts (locate 'ensureRuntime' and 'bootstrap-needed'),"
echo "since exact line numbers drift between releases and a blind 'git apply' is likely"
echo "to fail on a moving target file. After editing:"
echo ""
echo "  git add apps/desktop/electron/remote-bootstrap-policy.ts \"
echo "          apps/desktop/electron/main.ts"
echo "  git commit -m 'feat(remote): skip local Agent bootstrap on remote-only builds'"
echo "  git push -u origin remote-only"
echo ""
echo "Then copy .github/workflows/sync-and-build.yml into this repo's .github/workflows/"
echo "No gateway URL or token is stored in this public repository."
