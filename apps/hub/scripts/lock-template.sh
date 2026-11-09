#!/usr/bin/env bash
# Regenerates templates/bot/package-lock.json: the exact versions every bot deploy installs.
# Bots deploy as standalone npm projects (bundle-template.mjs ships the lockfile with the
# template), while this repo installs the template with pnpm. So the lock is resolved in a temp
# copy, leaving the pnpm workspace and node_modules alone.
#
# When: after editing templates/bot/package.json and running pnpm install.
# Then: review the diff (versions should match templates/bot/node_modules, which tests and
# `eve build` use), and run `node apps/hub/scripts/bundle-template.mjs`.
set -euo pipefail

bot="$(cd "$(dirname "$0")/../../../templates/bot" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cp "$bot/package.json" "$tmp/"
# Existing pins stay while they still satisfy package.json; only new or changed deps resolve.
if [ -f "$bot/package-lock.json" ]; then cp "$bot/package-lock.json" "$tmp/"; fi
(cd "$tmp" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund)
# Fails when the lock and package.json disagree, like the deploy would.
(cd "$tmp" && npm ci --dry-run --ignore-scripts --no-audit --no-fund > /dev/null)

cp "$tmp/package-lock.json" "$bot/package-lock.json"
echo "wrote $bot/package-lock.json ($(wc -c < "$bot/package-lock.json" | tr -d ' ') bytes)"
