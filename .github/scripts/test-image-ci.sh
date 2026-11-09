#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
# The fixture waits for its entire process group to disappear. Reap orphaned
# fixture daemons in containers whose PID 1 does not reap them, as the GHA host does.
exec "$repo_root/.vercel-ci-tools/tini" -s -- pnpm -C "$repo_root" exec vitest run images/bot-base "$@"
