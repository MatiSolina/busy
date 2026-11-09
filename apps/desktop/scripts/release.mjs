// Uploads the built zip that `curl …/install | sh` installs and the app updates to, then prints how to publish
// its version and SHA-256 on the selected hub. The hash lives in the hub deployment, never next to the zip in
// Blob: whoever can write to Blob can swap the zip, but the installer and the app will refuse it. The upload is
// always manual; set BUSY_RELEASE_HUB_URL and BUSY_RELEASE_HUB_DIR when publishing a self-hosted release.
// Usage (from apps/desktop, after bumping "version" and `pnpm dist`): node --env-file=../hub/.env.local scripts/release.mjs
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { put } from "@vercel/blob";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const hubUrl =
  process.env.BUSY_RELEASE_HUB_URL?.trim() || "https://app.busybot.dev";
const hubDir =
  process.env.BUSY_RELEASE_HUB_DIR?.trim() ||
  fileURLToPath(new URL("../../hub", import.meta.url));
try {
  const parsedHub = new URL(hubUrl);
  if (!(parsedHub.protocol === "http:" || parsedHub.protocol === "https:")) {
    throw new Error("unsupported protocol");
  }
} catch (error) {
  throw new Error(
    `BUSY_RELEASE_HUB_URL must be an absolute URL, got "${hubUrl}"`,
    {
      cause: error,
    }
  );
}
// The app only compares plain x.y.z (update.mjs).
if (!/^\d+\.\d+\.\d+$/u.test(version)) {
  throw new Error(`package.json version must be x.y.z, got "${version}"`);
}
// The exact name, so a stale build of another version in dist/ never ships.
const zip = `dist/Busy-${version}-arm64-mac.zip`;
if (!existsSync(zip)) {
  throw new Error(`no ${zip}; run pnpm dist first`);
}

// Hash and upload the same bytes.
const bytes = readFileSync(zip);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const blob = await put("releases/Busy-mac-arm64.zip", bytes, {
  access: "private",
  addRandomSuffix: false,
  allowOverwrite: true,
  contentType: "application/zip",
  multipart: true,
});

console.log(`released ${zip} → ${blob.pathname}
version ${version}
sha256  ${sha256}

Until the hub publishes this hash, installs refuse the new zip and apps don't update. Publish it on the selected hub:
  vercel env add BUSY_APP_VERSION production --value ${version} --force --yes --cwd '${hubDir}'
  vercel env add BUSY_APP_SHA256 production --value ${sha256} --force --yes --cwd '${hubDir}'
  vercel redeploy ${hubUrl} --target production --cwd '${hubDir}'
Then check: curl -s ${hubUrl}/api/download/version`);
