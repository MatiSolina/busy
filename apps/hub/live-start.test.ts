import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { liveBrowserState, START_LIVE } from "./lib/live";

const ROOTED_PATHS = /\/(?:etc|tmp)\//gu;

describe("liveBrowserState", () => {
  it.each([
    ['{"ok":true,"screen":"ready","browser":"ready"}\n', "ready"],
    ['noise\n{"ok":true,"screen":"ready","browser":"busy"}\n', "busy"],
    // Images whose desktop-live prints nothing: no claim either way.
    ["", undefined],
    ["not json", undefined],
    ['{"ok":false,"browser":"ready"}', undefined],
    ['{"ok":true,"browser":"maybe"}', undefined],
  ])("reads %j as %s", (stdout, expected) => {
    expect(liveBrowserState(stdout)).toBe(expected);
  });
});

// START_LIVE runs under bash with stubs for desktop-live, pkill and pgrep. The image marker and the
// runtime dir are rewritten into a temp dir; the closing port probe is cut so no real port is touched.
describe("START_LIVE", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "start-live-"));
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, "etc"));
    mkdirSync(join(root, "tmp", "desktop-runtime", "live"), {
      recursive: true,
    });
    const stub = (name: string, body: string) =>
      writeFileSync(
        join(root, "bin", name),
        `#!/bin/sh\necho "${name} $*" >> "$ROOT/calls.log"\n${body}\n`,
        { mode: 0o755 }
      );
    stub("pkill", "exit 0");
    stub("pgrep", "exit 1");
    stub(
      "desktop-live",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this fixture intentionally preserves shell parameter expansion literally
      'printf \'%s\\n\' \'{"ok":true,"screen":"ready","browser":"busy"}\'; exit "${DESKTOP_LIVE_EXIT:-0}"'
    );
  });
  afterEach(() => rmSync(root, { force: true, recursive: true }));

  const script = () => {
    const cut = START_LIVE.slice(
      0,
      START_LIVE.indexOf("for _ in $(seq 50); do\n  (exec")
    );
    // One pass: a temp root that itself contains /tmp/ must not be rewritten a second time.
    return `${cut}exit 0`.replace(ROOTED_PATHS, (dir) => `${root}${dir}`);
  };
  const run = (env: Record<string, string> = {}) =>
    spawnSync("bash", ["-c", script(), "desktop-live", "tok", "ctl", "view"], {
      encoding: "utf8",
      env: {
        NODE_ENV: "test",
        PATH: `${join(root, "bin")}:/usr/bin:/bin`,
        ROOT: root,
        ...env,
      },
    });
  const calls = () =>
    existsSync(join(root, "calls.log"))
      ? readFileSync(join(root, "calls.log"), "utf8").trim().split("\n")
      : [];

  it("still clears an old image's x11vnc for new passwords", () => {
    expect(run().status).toBe(0);
    expect(calls()).toContain("pkill -x x11vnc");
  });

  it("leaves x11vnc to a current image's desktop-live, which stops only its own", () => {
    writeFileSync(join(root, "etc", "busy-image-version"), "bot-base-abi-9\n");
    const r = run();
    expect(r.status).toBe(0);
    expect(calls()).toEqual(["desktop-live tok ctl view"]);
    expect(liveBrowserState(r.stdout)).toBe("busy");
  });

  it("keeps desktop-live's exit code (75: x11vnc still stopping, retry)", () => {
    writeFileSync(join(root, "etc", "busy-image-version"), "bot-base-abi-9\n");
    expect(run({ DESKTOP_LIVE_EXIT: "75" }).status).toBe(75);
  });
});
