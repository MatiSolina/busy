import { defineState } from "eve/context";

// Which bot base image this session's computer was created from. eve keeps a session's sandbox
// across deployments and resumes it by name, so a new BOT_BASE_IMAGE digest only reaches new
// sessions: an older computer keeps its older wrappers and desktop settings. The image writes an
// ABI marker (images/bot-base/image-version, installed as /etc/busy-image-version) and the bot
// compares it with the version it was written for. This only reports: it never resets the
// sandbox, never touches /data and never rewrites the computer's configuration.
export const IMAGE_MARKER_PATH = "/etc/busy-image-version";
// The image ABI this bot's code is written for (images/bot-base/image-version). Lives here, not in
// sandbox.ts, so the turn hook can read it without loading the sandbox definition; bump it together
// with BOT_BASE_IMAGE in sandbox.ts.
export const BOT_BASE_IMAGE_VERSION = "9";

export type ImageStatus = "current" | "stale" | "unknown";
export interface ComputerImage {
  checkedAt: number;
  expected: string;
  /** The marker's content; null when the image has none (images before the marker). */
  found: string | null;
  status: ImageStatus;
}

const imageState = defineState(
  "busy.computer-image",
  (): ComputerImage | null => null
);

export function computerImage(): ComputerImage | null {
  try {
    return imageState.get();
  } catch {
    return null;
  }
}

export function classifyImage(
  found: string | null,
  expected: string
): ImageStatus {
  if (found === null) {
    return "unknown";
  }
  return found === expected ? "current" : "stale";
}

/** Checked once per session and expected version: the image under a sandbox never changes. */
export function needsImageCheck(expected: string): boolean {
  return computerImage()?.expected !== expected;
}

interface MarkerReader {
  readTextFile: (options: { path: string }) => PromiseLike<string | null>;
}

export async function checkComputerImage(
  sandbox: MarkerReader,
  expected: string,
  sessionId: string
): Promise<ComputerImage> {
  let found: string | null = null;
  let status: ImageStatus = "unknown";
  try {
    const raw = await sandbox.readTextFile({ path: IMAGE_MARKER_PATH });
    found = raw?.trim() || null;
    status = classifyImage(found, expected);
  } catch (error) {
    console.warn("computer-image: could not read the image marker", {
      error,
      sessionId,
    });
  }
  const result: ComputerImage = {
    checkedAt: Date.now(),
    expected,
    found,
    status,
  };
  if (status !== "current") {
    console.warn(
      "computer-image: this session's computer comes from another bot image",
      { expected, found, sessionId, status }
    );
  }
  try {
    imageState.update(() => result);
  } catch (error) {
    // Reporting must never break opening the computer.
    console.warn("computer-image: could not record the image status", {
      error,
      sessionId,
    });
  }
  return result;
}

/** What the agent is told about an older computer; null when it matches. */
export function imageNotice(image: ComputerImage | null): string | null {
  if (!image || image.status === "current") {
    return null;
  }
  const found =
    image.found === null ? "an image without a version marker" : image.found;
  return [
    `Your computer was created from an older bot image (${found}; this bot expects ${image.expected}).`,
    "Its desktop, browser and live-screen helpers may behave like that older version.",
    "Do not try to repair, reinstall or reset the computer yourself.",
    "If desktop, browser or live-screen actions misbehave, tell the user that the computer needs a reset: /data is kept, but browser logins may be lost.",
  ].join(" ");
}
