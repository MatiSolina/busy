import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// desktop-session.sh runs for real under sh. Its settings come from this repo (images/bot-base/desktop,
// what the image copies to /usr/local/share/busy-desktop), its /tmp logs go to a temp dir, and tint2,
// pcmanfm, agent-desktop and pgrep are stubs that record how they were started.
const SOURCE = readFileSync(
  new URL("./desktop-session.sh", import.meta.url),
  "utf8"
);
const SHARE = fileURLToPath(new URL("./desktop", import.meta.url));
const present = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Expected a present test value");
  }
  return value;
};

let root = "";
const home = () => join(root, "home");
const state = () => join(root, "state");
const log = () =>
  existsSync(join(root, "calls.log"))
    ? readFileSync(join(root, "calls.log"), "utf8").split("\n").filter(Boolean)
    : [];
const calls = (name: string) => log().filter((l) => l.startsWith(`${name} `));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "desktop-session-"));
  for (const d of ["bin", "state", "home", "tmp/desktop-runtime"]) {
    mkdirSync(join(root, d), { recursive: true });
  }
  const stubs: Record<string, string> = {
    // What agent-desktop 1.0.2 prints for `session start` (compact JSON), or a failure.
    "agent-desktop":
      '#!/bin/sh\necho "agent-desktop DISPLAY=$DISPLAY $*" >> "$ROOT/calls.log"\n[ -z "$AD_FAIL" ] || exit 1\nprintf \'{"version":"2.5","ok":true,"command":"session","data":{"cursor_overlay":{"enabled":true},"name":"busy","session_id":"run-1793556670736-3383-0"}}\\n\'\n',
    pcmanfm:
      '#!/bin/sh\necho "pcmanfm DISPLAY=$DISPLAY $*" >> "$ROOT/calls.log"; touch "$ROOT/state/pcmanfm"\n',
    pgrep: '#!/bin/sh\ntest -e "$ROOT/state/$2"\n',
    // Daemons start in the background: they mark themselves running once they recorded their call.
    tint2:
      '#!/bin/sh\necho "tint2 TZ=$TZ DISPLAY=$DISPLAY $*" >> "$ROOT/calls.log"; touch "$ROOT/state/tint2"\n',
    "xdg-mime": '#!/bin/sh\necho "xdg-mime $*" >> "$ROOT/calls.log"\n',
  };
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(root, "bin", name), body, { mode: 0o755 });
  }
  writeFileSync(
    join(root, "desktop-session"),
    SOURCE.replaceAll("/tmp/", `${root}/tmp/`).replaceAll(
      "/usr/local/share/busy-desktop",
      SHARE
    ),
    { mode: 0o755 }
  );
});
afterEach(() => rmSync(root, { force: true, recursive: true }));

/** Runs it and waits for the background daemons it started to record themselves. */
async function run(env: Record<string, string> = {}) {
  const starting = ["tint2", "pcmanfm"].filter(
    (name) =>
      !existsSync(join(state(), name)) && existsSync(join(root, "bin", name))
  );
  const r = spawnSync("/bin/sh", [join(root, "desktop-session")], {
    encoding: "utf8",
    env: {
      HOME: home(),
      PATH: `${join(root, "bin")}:/usr/bin:/bin`,
      ROOT: root,
      ...env,
    },
  });
  await vi.waitFor(
    () => {
      const missing = starting.filter(
        (name) => !existsSync(join(state(), name))
      );
      if (missing.length > 0) {
        throw new Error(`Desktop fixtures not ready: ${missing.join(", ")}`);
      }
    },
    { interval: 10, timeout: 3000 }
  );
  return r;
}

describe("desktop-session", () => {
  it("only touches its home, its logs and the settings it ships (no other absolute paths)", () => {
    const code = SOURCE.split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    // A path right after `${…}` is inside that variable's directory, not an absolute one.
    const paths = [...code.matchAll(/(?<![\w$}])\/[\w./-]+/gu)]
      .map((m) => m[0])
      .filter((p) => !p.startsWith("/dev/"));
    expect(
      paths.filter(
        (p) =>
          !(
            p.startsWith("/tmp/") ||
            p.startsWith("/usr/local/share/busy-desktop")
          ) && p !== "/data"
      )
    ).toEqual([]);
  });

  describe("on a computer's first boot", () => {
    beforeEach(async () => {
      // biome-ignore lint/suspicious/noMisplacedAssertion: the setup must fail before any case runs
      expect((await run()).status).toBe(0);
    });

    it("installs the shipped settings into ~/.config", () => {
      expect(readdirSync(join(home(), ".config")).sort()).toEqual(
        readdirSync(join(SHARE, "config")).sort()
      );
      for (const f of [
        "tint2/tint2rc",
        "pcmanfm/default/desktop-items-0.conf",
        "libfm/libfm.conf",
      ]) {
        expect(readFileSync(join(home(), ".config", f), "utf8")).toBe(
          readFileSync(join(SHARE, "config", f), "utf8")
        );
      }
    });

    it("puts the bot's files on the desktop", () => {
      const link = join(home(), "Desktop", "Bot files");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe("/data");
    });

    it("starts the taskbar on the bot's screen, with the clock on Mati's time", () => {
      expect(calls("tint2")).toEqual([
        "tint2 TZ=America/Argentina/Buenos_Aires DISPLAY=:99 ",
      ]);
    });

    it("starts the file manager's desktop on the bot's screen", () => {
      expect(calls("pcmanfm")).toEqual(["pcmanfm DISPLAY=:99 --desktop"]);
    });
  });

  it("keeps settings someone changed: they're installed once", async () => {
    await run();
    writeFileSync(
      join(home(), ".config", "libfm", "libfm.conf"),
      "[config]\nterminal=xterm -e %s\n"
    );
    rmSync(join(state(), "tint2"));
    await run();
    expect(
      readFileSync(join(home(), ".config", "libfm", "libfm.conf"), "utf8")
    ).toContain("xterm");
  });

  // A computer created from an older image keeps its own PCManFM settings after the image changes:
  // the bot reports the older image (H-19) instead of rewriting the person's desktop.
  it("never overwrites an older computer's PCManFM settings", async () => {
    const conf = join(
      home(),
      ".config",
      "pcmanfm",
      "default",
      "desktop-items-0.conf"
    );
    mkdirSync(join(home(), ".config", "pcmanfm", "default"), {
      recursive: true,
    });
    writeFileSync(conf, "[*]\nwallpaper_mode=color\n# from an older image\n");
    await run();
    expect(readFileSync(conf, "utf8")).toBe(
      "[*]\nwallpaper_mode=color\n# from an older image\n"
    );
    expect(existsSync(join(home(), ".config", "libfm"))).toBe(false);
  });

  it("starts only what is missing", async () => {
    writeFileSync(join(state(), "pcmanfm"), "");
    await run();
    expect(calls("tint2")).toHaveLength(1);
    expect(calls("pcmanfm")).toEqual([]);
  });

  it("waits for a background daemon even when XDG setup already logged calls", async () => {
    const tint2 = join(root, "bin", "tint2");
    writeFileSync(
      tint2,
      readFileSync(tint2, "utf8").replace(
        "#!/bin/sh\n",
        '#!/bin/sh\nwhile [ ! -e "$ROOT/release-tint2" ]; do sleep 0.01; done\n'
      )
    );
    let finished = false;
    const execution = run().then(() => {
      finished = true;
    });
    await setImmediate();
    try {
      expect(finished).toBe(false);
    } finally {
      writeFileSync(join(root, "release-tint2"), "");
      // Release and reap the fixture even when the regression assertion fails.
      await vi.waitFor(() => {
        if (!existsSync(join(state(), "tint2"))) {
          throw new Error("tint2 fixture has not finished");
        }
      });
      await execution;
    }
    expect(calls("tint2")).toHaveLength(1);
  });

  it("starts nothing when everything runs", async () => {
    await run();
    const firstLog = log();
    expect(calls("tint2")).toHaveLength(1);
    expect(calls("pcmanfm")).toHaveLength(1);
    expect(calls("agent-desktop")).toHaveLength(1);
    await run();
    expect(log()).toEqual(firstLog);
  });

  describe("the cursor overlay", () => {
    const saved = () => join(root, "tmp", "desktop-runtime", "agent-session");

    it("starts an agent-desktop session with its cursor overlay and saves its id for `desktop`", async () => {
      await run();
      expect(calls("agent-desktop")).toEqual([
        "agent-desktop DISPLAY=:99 session start --name busy --cursor",
      ]);
      expect(readFileSync(saved(), "utf8").trim()).toBe(
        "run-1793556670736-3383-0"
      );
    });

    it("keeps the session it saved", async () => {
      writeFileSync(saved(), "run-1-2-0\n");
      await run();
      expect(calls("agent-desktop")).toEqual([]);
      expect(readFileSync(saved(), "utf8")).toBe("run-1-2-0\n");
    });

    it("tries again on the next call when the start failed, and never fails the call", async () => {
      expect((await run({ AD_FAIL: "1" })).status).toBe(0);
      expect(readFileSync(saved(), "utf8")).toBe("");
      await run();
      expect(calls("agent-desktop")).toHaveLength(2);
      expect(readFileSync(saved(), "utf8").trim()).toBe(
        "run-1793556670736-3383-0"
      );
    });

    it("saves it in the runtime dir `desktop` gives it", async () => {
      const elsewhere = join(root, "runtime");
      mkdirSync(elsewhere);
      await run({ XDG_RUNTIME_DIR: elsewhere });
      expect(
        readFileSync(join(elsewhere, "agent-session"), "utf8").trim()
      ).toBe("run-1793556670736-3383-0");
      expect(existsSync(saved())).toBe(false);
    });
  });

  it("never fails the `desktop` call it runs under, even when a daemon is missing", async () => {
    rmSync(join(root, "bin", "tint2"));
    expect((await run()).status).toBe(0);
  });

  it("installs the managed XDG handler and registers it once per profile", async () => {
    writeFileSync(
      join(root, "bin", "xdg-mime"),
      '#!/bin/sh\necho "xdg-mime $*" >> "$ROOT/calls.log"\n',
      { mode: 0o755 }
    );
    await run();
    const installed = join(
      home(),
      ".local",
      "share",
      "applications",
      "busy-chrome.desktop"
    );
    expect(readFileSync(installed, "utf8")).toBe(
      readFileSync(join(SHARE, "applications", "busy-chrome.desktop"), "utf8")
    );
    expect(calls("xdg-mime")).toEqual([
      "xdg-mime default busy-chrome.desktop x-scheme-handler/http",
      "xdg-mime default busy-chrome.desktop x-scheme-handler/https",
      "xdg-mime default busy-chrome.desktop text/html",
    ]);
    await run();
    expect(calls("xdg-mime")).toHaveLength(3);
  });
});

describe("the shipped settings", () => {
  const read = (f: string) => readFileSync(join(SHARE, f), "utf8");
  const entry = (name: string) =>
    Object.fromEntries(
      read(`applications/${name}`)
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
    );

  it("puts Chrome, Terminal and Files on the taskbar, from launchers the image ships", () => {
    const items = [
      ...read("config/tint2/tint2rc").matchAll(
        /^launcher_item_app = (?<path>.+)$/gmu
      ),
    ].map((m) => present(m.groups?.path));
    expect(
      items.map((p) => p.replace("/usr/local/share/busy-desktop/", ""))
    ).toEqual([
      "applications/busy-chrome.desktop",
      "applications/busy-terminal.desktop",
      "applications/busy-files.desktop",
    ]);
    for (const p of items) {
      expect(
        existsSync(p.replace("/usr/local/share/busy-desktop", SHARE)),
        p
      ).toBe(true);
    }
  });

  it("routes Chrome and XDG URLs through the managed browser helper", () => {
    expect(entry("busy-chrome.desktop").Exec).toBe(
      "desktop-browser human-open %U"
    );
    expect(entry("busy-chrome.desktop").MimeType).toContain(
      "x-scheme-handler/http"
    );
    expect(entry("busy-chrome.desktop").MimeType).toContain(
      "x-scheme-handler/https"
    );
  });

  it.each([
    // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
    ["busy-terminal.desktop", /^lxterminal\b.*\/data/u],
    // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
    ["busy-files.desktop", /^pcmanfm \/data$/u],
  ])("%s opens in the bot's files", (file, exec) => {
    expect(entry(file).Exec).toMatch(exec);
  });

  it("uses icons Adwaita has", () => {
    expect(
      [
        "busy-chrome.desktop",
        "busy-terminal.desktop",
        "busy-files.desktop",
      ].map((f) => entry(f).Icon)
    ).toEqual(["google-chrome", "utilities-terminal", "folder"]);
  });

  it("opens a terminal from the file manager with the terminal it installs", () => {
    expect(read("config/libfm/libfm.conf")).toMatch(
      // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
      /^terminal=lxterminal -e %s$/mu
    );
  });

  it("keeps the taskbar out of maximized windows' way", () => {
    expect(read("config/tint2/tint2rc")).toMatch(
      // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
      /^strut_policy = follow_size$/mu
    );
  });
});
