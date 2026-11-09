import { Drive } from "@vercel/sandbox";
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";
import config from "./config.json" with { type: "json" };
import { isConsultation } from "./lib/caller";
import { reportComputer } from "./lib/computer";
import {
  BOT_BASE_IMAGE_VERSION,
  checkComputerImage,
  IMAGE_MARKER_PATH,
} from "./lib/computer-image";
import { firesideProfile } from "./lib/fireside";
import { markComputerOpened } from "./lib/lifecycle";

// Drive and sandbox must share a region.
const REGION = "iad1";

// Everything a bot's computer needs (Office, PDF tools, Chrome, agent-desktop, agent-browser and
// the public desktop/browser wrappers) is baked once into this image; creating a bot installs nothing.
// The hub injects its own digest-pinned image into each bot project before the
// deployment build. The placeholder keeps CI's `eve build --skip-sandbox-prewarm`
// self-contained; the hub refuses to start a bot deploy without BOT_BASE_IMAGE.
const BOT_BASE_IMAGE =
  process.env.BOT_BASE_IMAGE?.trim() ?? "busy-base-image-not-configured";
// BOT_BASE_IMAGE_VERSION (lib/computer-image.ts) is the image ABI this code expects: bump it
// together with this digest (images/bot-base/push.sh prints both). Computers created from an older
// image report "stale"/"unknown"; nothing is blocked or reset because of it.

export const environment = VercelSandbox.environment({
  image: BOT_BASE_IMAGE,
  // Captured once in the build snapshot every session starts from; fails the build on a broken image.
  prepare: async (sandbox) => {
    const { exitCode, stderr } = await sandbox.run({
      command:
        // A marker, when present, must be the one this code expects: a digest bumped without
        // BOT_BASE_IMAGE_VERSION (or the reverse) fails the build instead of every session.
        `set -o pipefail && agent-desktop version | grep -F '1.0.2' >/dev/null && browser --version | grep -F '0.41.1' >/dev/null && test -x /usr/local/bin/browser && test -x /usr/local/bin/desktop-browser && test -x /usr/local/bin/desktop-control && test -x /usr/local/bin/desktop && test -x /usr/local/bin/desktop-live && test -x /usr/local/bin/desktop-session && test -x /usr/local/bin/desktop-a11y && { test ! -e ${IMAGE_MARKER_PATH} || grep -qxF '${BOT_BASE_IMAGE_VERSION}' ${IMAGE_MARKER_PATH}; }`,
    });
    if (exitCode !== 0) {
      throw new Error(
        `bot base image is missing the pinned desktop/browser runtime: ${stderr}`
      );
    }
  },
  region: REGION,
});

export default defineSandbox(async (ctx) => {
  const fireside = await firesideProfile(ctx);
  const drive = await Drive.getOrCreate({
    name: `busy-${config.slug}`,
    region: REGION,
  });
  const consulted = isConsultation(ctx.session.auth);
  // A consultation mounts a read-only point-in-time copy: one writer per Drive (spec 4.2).
  let data = consulted
    ? await drive.snapshot()
    : { drive: drive.name, mode: "read-write" as const };
  if (fireside) {
    data = {
      drive: (
        await Drive.getOrCreate({ name: fireside.workspace, region: REGION })
      ).name,
      mode: "read-write" as const,
    };
  }
  const sandbox = await environment.open({
    mounts: {
      "/data": data,
      ...(fireside ? { "/context": await drive.snapshot() } : {}),
    },
    // A consulted bot only reads and answers: no way to send /data anywhere.
    ...(consulted ? { networkPolicy: "deny-all" as const } : {}),
    timeout: 45 * 60 * 1000,
  });
  // eve hands back an existing sandbox by name with the image it was created from; report (never
  // reset) a computer from another image. hooks/computer-image.ts repeats this for sessions that
  // resume without running this selector.
  await checkComputerImage(sandbox, BOT_BASE_IMAGE_VERSION, ctx.session.id);
  // Tells hooks/suspend.ts this session has a computer to stop after each turn.
  markComputerOpened(ctx.session.id);
  // The hub's Live finds the chat's computer by eve's public sandbox name, not by re-deriving eve's
  // private naming (H-18). Not awaited: the hub keeps a fallback, and opening must not wait on it.
  if (!(consulted || fireside)) {
    reportComputer(ctx.session.id, sandbox.name).catch(() => {
      // reportComputer already logs; the derived name stays in use.
    });
  }
  return sandbox;
});
