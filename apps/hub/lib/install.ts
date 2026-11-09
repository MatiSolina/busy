// The Mac app release the hub vouches for, and the `curl -fsSL …/install | sh` script (spec 4.8).
// The expected SHA-256 lives in this deployment's env (printed by apps/desktop/scripts/release.mjs), never
// next to the zip in Blob: a Blob write token alone must not be enough to run code on the Mac.

type Source = Record<string, string | undefined>;
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/u;
const RELEASE_SHA256 = /^[0-9a-f]{64}$/u;

export interface Release {
  sha256: string;
  version: string;
}

/** The published release, or null when the hub has none (or a malformed one) configured. */
export function release(source: Source = process.env): Release | null {
  const version = source.BUSY_APP_VERSION?.trim() ?? "";
  const sha256 = source.BUSY_APP_SHA256?.trim().toLowerCase() ?? "";
  // Plain x.y.z is what the app compares (apps/desktop/update.mjs); a hex-only hash is also safe to embed in sh.
  if (!(RELEASE_VERSION.test(version) && RELEASE_SHA256.test(sha256))) {
    return null;
  }
  return { sha256, version };
}

// Fail closed: without a hash to check against, nothing gets downloaded or installed.
const NO_RELEASE = `#!/bin/sh
echo "Can't install Busy: the server hasn't published the SHA-256 fingerprint of the current version." >&2
echo "Nothing was downloaded or installed. Try again later." >&2
exit 1
`;

/** curl adds no quarantine flag, so the ad-hoc signed app opens without a Gatekeeper prompt. */
export function installScript(hub: string, rel: Release | null): string {
  if (!rel) {
    return NO_RELEASE;
  }
  return `#!/bin/sh
set -eu
if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "Busy needs a Mac with Apple Silicon." >&2
  exit 1
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Downloading Busy ${rel.version}…"
curl -fL --progress-bar --retry 5 --retry-all-errors -C - "${hub}/api/download" -o "$TMP/Busy.zip"
if [ "$(shasum -a 256 "$TMP/Busy.zip" | cut -d ' ' -f 1)" != "${rel.sha256}" ]; then
  echo "The download doesn't match the published version (SHA-256 mismatch). Nothing was installed." >&2
  echo "Try again in a few minutes. If it keeps failing, the file may have been tampered with." >&2
  exit 1
fi
ditto -x -k "$TMP/Busy.zip" "$TMP/new"
if [ ! -d "$TMP/new/Busy.app" ]; then
  echo "The download doesn't contain Busy.app. Your installed version wasn't touched." >&2
  exit 1
fi
rm -rf /Applications/Busy.app
mv "$TMP/new/Busy.app" /Applications/Busy.app
echo "Done. Opening Busy…"
open /Applications/Busy.app
`;
}
