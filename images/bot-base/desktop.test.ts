import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, it as test } from "vitest";

// `desktop` (images/bot-base/desktop.sh) runs for real here, under bash and dash (the image's
// /bin/sh), against stub daemons that only record what they were asked to do.
//
// The script hardcodes /tmp paths (its runtime dir, Xvfb's /tmp/.X99-lock, the daemon logs), so each
// test runs a copy with every `/tmp/` rewritten into its own mkdtemp dir, and HOME points there too.
// The first test below guards that rewrite: if the script grows another absolute path, update the
// rewrite before trusting these tests. Nothing is written outside the temp dir, and the only
// processes ever signalled are the test's own (its spawned process group, after an 8 s hang).
//
// BUSY_DESKTOP_SH lets a mutation check run this suite against an edited copy of the script.
const SOURCE = readFileSync(
  process.env.BUSY_DESKTOP_SH ?? new URL("./desktop.sh", import.meta.url),
  "utf8"
);
const PROFILE = readFileSync(
  process.env.BUSY_DESKTOP_PROFILE ??
    new URL("./desktop-profile.sh", import.meta.url),
  "utf8"
);

const SHELLS = [
  ["bash", "/bin/bash"],
  ["dash", "/bin/dash"],
] as const;

// ---------------------------------------------------------------------------------------------
// Stubs. Each records its call in $STUB/log; daemons also record whether they inherited fd 9.

const LIB = [
  'log() { printf "%s\\n" "$*" >> "$STUB/log"; }',
  'fd9() { if (: >&9) 2>/dev/null; then echo open; else echo closed; fi >> "$STUB/fd9.$1"; }',
  'fd7() { if (: >&7) 2>/dev/null; then echo open; else echo closed; fi >> "$STUB/fd7.$1"; }',
  'wait_release() { i=0; while [ ! -e "$STUB/release" ] && [ $i -lt 500 ]; do /bin/sleep 0.01; i=$((i+1)); done; }',
  'screen() { if [ -e "$STUB/display" ]; then echo up; else echo down; fi; }',
];

const STUBS: Record<string, string[]> = {
  "agent-desktop": [
    'log "agent-desktop $*"',
    "fd9 agent-desktop",
    "fd7 agent-desktop",
    'echo $# > "$STUB/argc"',
    'printf "%s\\0" "$@" > "$STUB/argv"',
    '/usr/bin/env > "$STUB/env"',
    'echo $$ > "$STUB/agent.pid"',
    'screen >> "$STUB/agent.screen"',
    'if [ -n "$AD_HOLD" ]; then : > "$STUB/agent-started"; wait_release; fi',
    'if [ -n "$AD_STDIN" ]; then cat; fi',
    'if [ -n "$AD_ERR" ]; then printf "%s" "$AD_ERR" >&2; fi',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this fixture intentionally preserves shell parameter expansion literally
    'if [ -n "${AD_OUT+set}" ]; then printf "%s" "$AD_OUT"; else printf "%s" "{\\"ok\\":true}"; fi',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this fixture intentionally preserves shell parameter expansion literally
    'exit "${AD_EXIT:-0}"',
  ],
  "dbus-daemon": [
    'log "dbus-daemon $*"',
    "fd9 dbus-daemon",
    'echo "dbus stdout chatter"',
    'if [ "$DBUS" = fail ]; then echo "dbus-daemon: failed to bind" >&2; exit 1; fi',
    'for a in "$@"; do case "$a" in --address=unix:path=*) sock=$(printf "%s" "$a" | sed "s/^--address=unix:path=//") ;; esac; done',
    '/usr/bin/perl -MSocket -MIO::Socket::UNIX -e \'IO::Socket::UNIX->new(Type => SOCK_STREAM, Local => $ARGV[0], Listen => 1) or die "bind: $!\\n"\' "$sock"',
  ],
  "dbus-send": ['log "dbus-send $*"', '[ -S "$XDG_RUNTIME_DIR/bus" ]'],
  // `desktop` on PATH, as the image installs it, for commands that call it by name.
  desktop: ['exec "$DESKTOP_SHELL" "$DESKTOP_SCRIPT" "$@"'],
  "desktop-a11y": [
    'log "desktop-a11y $*"',
    "fd9 desktop-a11y",
    'if [ "$A11Y" = slow ]; then /bin/sleep 0.5; fi',
    'printf "%s" "$DBUS_SESSION_BUS_ADDRESS" > "$STUB/a11y.bus"',
    ': > "$STUB/desktop-a11y-running"',
    'printf "%s:\\n" "$$" > "$XDG_RUNTIME_DIR/a11y-ready"',
  ],
  "desktop-session": [
    'log "desktop-session $*"',
    "fd9 desktop-session",
    'screen > "$STUB/session.screen"',
    'if [ "$SESSION" = fail ]; then exit 1; fi',
    // Xvfb dies while the desktop is still starting.
    'if [ "$SESSION" = killx ]; then rm -f "$STUB/display"; fi',
  ],
  // util-linux flock(1) isn't on macOS: the same flock(2) call, on the inherited descriptor.
  flock: [
    'log "flock $*"',
    'exec /usr/bin/perl -MFcntl=:flock -e \'open(my $fh, ">&=", $ARGV[-1]) or die "flock: bad descriptor\\n"; flock($fh, LOCK_EX) or die "flock: $!\\n"\' -- "$@"',
  ],
  openbox: [
    'log "openbox $*"',
    "fd9 openbox",
    'screen > "$STUB/openbox.screen"',
    'printf "%s" "$DISPLAY" > "$STUB/openbox.DISPLAY"',
    'echo "openbox stdout chatter"',
    'echo "openbox stderr chatter" >&2',
    ': > "$STUB/openbox-running"',
  ],
  // pgrep -x NAME: "running" means the daemon's stub left its marker.
  pgrep: [
    'log "pgrep $*"',
    'if [ "$1" = -x ] && [ -e "$STUB/$2-running" ]; then echo 4242; exit 0; fi',
    "exit 1",
  ],
  pkill: [
    'log "pkill $*"',
    'if [ "$2" = desktop-a11y ]; then rm -f "$STUB/desktop-a11y-running" "$XDG_RUNTIME_DIR/a11y-ready"; fi',
    "exit 0",
  ],
  // Fast-forward the Xvfb wait, then preserve pauses for other daemon startup.
  sleep: [
    'log "sleep $*"',
    'if [ -e "$STUB/display" ]; then exec /bin/sleep "$@"; fi',
    'i=0; while [ ! -e "$STUB/display" ] && [ ! -e "$STUB/xvfb-down" ] && [ $i -lt 300 ]; do /bin/sleep 0.01; i=$((i+1)); done',
  ],
  Xvfb: [
    'log "Xvfb $*"',
    "fd9 Xvfb",
    "fd7 Xvfb",
    'echo "Xvfb stdout chatter"',
    'echo "Xvfb stderr chatter" >&2',
    'case "$XVFB" in fail) : > "$STUB/xvfb-down"; exit 1 ;; slow) /bin/sleep 0.2 ;; esac',
    ': > "$STUB/display"',
    'if [ "$XVFB" = hold ]; then wait_release; fi',
  ],
  xdpyinfo: [
    'log "xdpyinfo $*"',
    'echo "name of display: $DISPLAY"',
    'echo "xdpyinfo: chatter" >&2',
    '[ -e "$STUB/display" ]',
  ],
};

/** One executable that acts as whichever stub it was called as (each name is a symlink to it). */
const DISPATCH = [
  "#!/bin/sh",
  ...LIB,
  // biome-ignore lint/suspicious/noTemplateCurlyInString: this fixture intentionally preserves shell parameter expansion literally
  'case "${0##*/}" in',
  ...Object.entries(STUBS).flatMap(([name, body]) => [
    `${name})`,
    ...body.map((l) => `  ${l}`),
    "  ;;",
  ]),
  "esac",
  "",
].join("\n");

// One stub executable for the whole file: macOS checks every freshly written executable the first
// time it runs (about 250 ms each), so it is written once, every stub name is a symlink to it, and
// each test only gets its own state dir ($STUB) next to its rewritten copy of the script.
let ROOT = "";
let BIN = "";
let boxes = 0;
const must = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Expected a present test value");
  }
  return value;
};

beforeAll(async () => {
  ROOT = mkdtempSync(join(tmpdir(), "dt-"));
  BIN = join(ROOT, "bin");
  mkdirSync(BIN);
  writeFileSync(join(BIN, "stub"), DISPATCH, { mode: 0o755 });
  for (const name of Object.keys(STUBS)) {
    symlinkSync("stub", join(BIN, name));
  }
  const warm = join(ROOT, "warm");
  mkdirSync(warm);
  await new Promise((done) =>
    spawn(join(BIN, "pgrep"), [], { env: { STUB: warm }, stdio: "ignore" }).on(
      "close",
      done
    )
  );
});
afterAll(() => {
  if (ROOT) {
    rmSync(ROOT, { force: true, recursive: true });
  }
});

// ---------------------------------------------------------------------------------------------
// A box: the rewritten script, a fake HOME, the script's /tmp and the stubs' state, in one temp dir.

interface Box {
  env: Record<string, string>;
  home: string;
  root: string;
  runtime: string;
  script: string;
  state: string;
  tmp: string;
}

function box(home = "home"): Box {
  boxes += 1;
  const root = join(ROOT, `box-${boxes}`);
  const b = {
    home: join(root, home),
    root,
    runtime: join(root, "tmp", "desktop-runtime"),
    script: join(root, "desktop"),
    state: join(root, "s"),
    tmp: join(root, "tmp"),
  };
  for (const dir of [b.tmp, b.home, b.state]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(b.script, rewrite(SOURCE, b.tmp));
  return {
    ...b,
    env: {
      HOME: b.home,
      LANG: "C",
      PATH: `${BIN}:/usr/bin:/bin`,
      STUB: b.state,
    },
  };
}

function rewrite(source: string, tmp: string): string {
  const out = source.replaceAll("/tmp/", `${tmp}/`);
  if (out.replaceAll(tmp, "").includes("/tmp")) {
    throw new Error("desktop.sh still points at the real /tmp");
  }
  return out;
}

/** Absolute paths in the script's code, leaving out comments and `$VAR/…` paths. */
function absolutePaths(source: string): string[] {
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/"?\$\{?[A-Za-z_]\w*\}?"?(?:\/[^\s"';|&)]*)*/gu, "VAR");
  return [...code.matchAll(/(?:^|[\s=>"'(])(?<path>\/[^\s"';|&)]*)/gu)].map(
    (m) => must(m.groups?.path)
  );
}

interface Result {
  code: number | null;
  pid: number;
  stderr: string;
  stdout: string;
}
interface RunOptions {
  cwd?: string;
  drain?: boolean;
  env?: Record<string, string>;
  input?: string;
}

const run = (
  b: Box,
  shell: string,
  args: string[] = [],
  opts: RunOptions = {}
) => spawnIn(b, [shell, b.script, ...args], opts);

function spawnIn(
  b: Box,
  commandArgs: string[],
  opts: RunOptions = {}
): Promise<Result> {
  return new Promise((resolve, reject) => {
    // Its own process group, so the test can wait for the daemons it left in the background.
    const child = spawn(must(commandArgs[0]), commandArgs.slice(1), {
      cwd: opts.cwd ?? b.root,
      detached: true,
      env: { ...b.env, ...opts.env },
    });
    const pid = must(child.pid);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d;
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d;
    });
    const killer = setTimeout(() => killGroup(pid), 8000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(killer);
      const done = { code, pid, stderr, stdout };
      if (opts.drain === false) {
        resolve(done);
      } else {
        drain(pid)
          .then(() => resolve(done))
          .catch(reject);
      }
    });
    child.stdin.end(opts.input ?? "");
  });
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits until every process the call started (its whole process group) has exited. */
async function drain(pgid: number, ms = 5000): Promise<void> {
  if (!groupAlive(pgid) || ms <= 0) {
    return;
  }
  await pause(10);
  await drain(pgid, ms - 10);
}

function killGroup(pgid: number) {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // The process group may already have exited.
  }
}

async function until(check: () => boolean, ms = 4000): Promise<boolean> {
  if (check()) {
    return true;
  }
  if (ms <= 0) {
    return check();
  }
  await pause(10);
  return until(check, ms - 10);
}

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, pause(ms).then(() => "timeout" as const)]);

const read = (b: Box, name: string) =>
  existsSync(join(b.state, name))
    ? readFileSync(join(b.state, name), "utf8")
    : "";
const calls = (b: Box) => read(b, "log").split("\n").filter(Boolean);
const started = (b: Box, daemon: string) =>
  calls(b).filter((c) => c === daemon || c.startsWith(`${daemon} `));
const argv = (b: Box) =>
  read(b, "argv")
    .split("\0")
    .slice(0, Number(read(b, "argc")));
const agentEnv = (b: Box) =>
  Object.fromEntries(
    read(b, "env")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
  );

const screenUp = (b: Box) => writeFileSync(join(b.state, "display"), "");
const openboxUp = (b: Box) =>
  writeFileSync(join(b.state, "openbox-running"), "");
function busUp(b: Box) {
  mkdirSync(b.runtime, { mode: 0o700, recursive: true });
  const made = spawnSync("/usr/bin/perl", [
    "-MSocket",
    "-MIO::Socket::UNIX",
    "-e",
    "IO::Socket::UNIX->new(Type => SOCK_STREAM, Local => $ARGV[0], Listen => 1) or die $!",
    join(b.runtime, "bus"),
  ]);
  if (made.status !== 0) {
    throw new Error(`could not make the bus socket: ${made.stderr}`);
  }
}
const everythingUp = (b: Box) => {
  screenUp(b);
  busUp(b);
  openboxUp(b);
};

const chrome = (b: Box) => join(b.home, ".config", "google-chrome");
function chromeProfile(b: Box) {
  mkdirSync(join(chrome(b), "Default"), { recursive: true });
  // What Chrome leaves after the hostname changed: dangling symlinks naming the old host.
  symlinkSync("old-host-4242", join(chrome(b), "SingletonLock"));
  symlinkSync("old-host-socket", join(chrome(b), "SingletonSocket"));
  symlinkSync("1234567890", join(chrome(b), "SingletonCookie"));
  writeFileSync(join(chrome(b), "Default", "Preferences"), "{}");
  writeFileSync(join(chrome(b), "Local State"), "{}");
}
const present = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------------------------

describe("the test harness", () => {
  it("finds only /tmp paths and /dev/null in the script, so the rewrite covers every path it writes", () => {
    const paths = absolutePaths(SOURCE);
    expect(paths.length).toBeGreaterThan(0);
    expect(
      paths.filter(
        (p) =>
          p !== "/dev/null" &&
          p !== "/org/freedesktop/DBus" &&
          !p.startsWith("/proc/") &&
          !p.startsWith("/tmp/")
      )
    ).toEqual([]);
  });
});

describe.each(SHELLS)("desktop under %s", (_, shell) => {
  describe.concurrent("what agent-desktop gets", () => {
    test.for<[string, string[]]>([
      ["no arguments", []],
      [
        "the Chrome launch from the instructions",
        [
          "launch",
          "google-chrome",
          "--arg=--force-renderer-accessibility",
          "--arg=--no-first-run",
          "--arg=--start-maximized",
          "--arg=https://example.com/a?b=1&c=2#x",
        ],
      ],
      ["text with spaces", ["type", "@e3", "hi there, how's it going?"]],
      ["an empty argument", ["type", "@e3", ""]],
      ["leading and trailing blanks", ["type", "@e3", "  two spaces  "]],
      ["glob characters", ["find", "*", "?", "[ab]"]],
      [
        "shell expansions that must stay literal",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell syntax is fixture data, not a JavaScript template
        ["type", "@e1", "$HOME $(id) `id` ${PATH}"],
      ],
      [
        "quotes and backslashes",
        ["type", "@e1", `said "hi" and 'bye' in C:\\temp\\n`],
      ],
      ["a newline inside an argument", ["type", "@e1", "line 1\nline 2"]],
      ["dashes that look like options", ["--", "-v", "--help", "-"]],
      ["accents and emoji", ["type", "@e2", "naïve café 🧉"]],
      [
        "many arguments in order",
        Array.from({ length: 40 }, (_unused, index) => `a${index}`),
      ],
    ])("passes %s through exactly", async ([, args]) => {
      const b = box();
      // Files a glob could expand to, in the directory the call runs from.
      for (const f of ["a", "b", "x.txt"]) {
        writeFileSync(join(b.root, f), "");
      }
      everythingUp(b);
      const r = await run(b, shell, args);
      expect(r.code).toBe(0);
      expect(argv(b)).toEqual(
        args[0] === "type" ? ["--headed", ...args] : args
      );
    });

    test.for<[string, string[], string[]]>([
      ["press", ["press", "return"], ["--headed", "press", "return"]],
      ["type", ["type", "@e3", "hi"], ["--headed", "type", "@e3", "hi"]],
      ["click, which stays semantic", ["click", "@e3"], ["click", "@e3"]],
      [
        "a command that only names press later",
        ["find", "press"],
        ["find", "press"],
      ],
    ])(
      "sends %s as physical keys only where they are keys",
      async ([, args, expected]) => {
        const b = box();
        everythingUp(b);
        await run(b, shell, args);
        expect(argv(b)).toEqual(expected);
      }
    );

    test("hands agent-desktop the cursor overlay session desktop-session saved", async () => {
      const b = box();
      everythingUp(b);
      writeFileSync(join(b.runtime, "agent-session"), "run-17-1-0\n");
      await run(b, shell, ["click", "@e1"]);
      expect(agentEnv(b).AGENT_DESKTOP_SESSION).toBe("run-17-1-0");
      expect(present(join(b.runtime, "agent-session"))).toBe(true);
    });

    test.for([
      ["no session file", null],
      ["an empty one (its start failed)", ""],
    ])("hands agent-desktop no session with %s", async ([, content]) => {
      const b = box();
      everythingUp(b);
      if (content !== null) {
        writeFileSync(join(b.runtime, "agent-session"), content);
      }
      const r = await run(b, shell, ["click", "@e1"], {
        env: { AGENT_DESKTOP_SESSION: "" },
      });
      expect(r.code).toBe(0);
      expect(agentEnv(b).AGENT_DESKTOP_SESSION ?? "").toBe("");
    });

    test("drops the overlay session with the screen it was drawn on", async () => {
      const b = box();
      mkdirSync(b.runtime, { mode: 0o700, recursive: true });
      writeFileSync(join(b.runtime, "agent-session"), "run-old\n");
      await run(b, shell, ["click", "@e1"]);
      expect(present(join(b.runtime, "agent-session"))).toBe(false);
      expect(agentEnv(b).AGENT_DESKTOP_SESSION).toBeUndefined();
    });

    test.for<[string, string]>([
      ["DISPLAY", ":99"],
      ["ACCESSIBILITY_ENABLED", "1"],
      ["GTK_MODULES", "gail:atk-bridge"],
      ["NO_AT_BRIDGE", "0"],
    ])("exports %s=%s", async ([name, value]) => {
      const b = box();
      everythingUp(b);
      await run(b, shell, ["list-apps"]);
      expect(agentEnv(b)[name]).toBe(value);
    });

    test("points XDG_RUNTIME_DIR and the session bus at the runtime dir", async () => {
      const b = box();
      await run(b, shell, ["list-apps"]);
      expect(agentEnv(b).XDG_RUNTIME_DIR).toBe(b.runtime);
      expect(agentEnv(b).DBUS_SESSION_BUS_ADDRESS).toBe(
        `unix:path=${b.runtime}/bus`
      );
    });

    test("uses its own display and bus even when the caller has others", async () => {
      const b = box();
      everythingUp(b);
      await run(b, shell, ["list-apps"], {
        env: {
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/elsewhere",
          DISPLAY: ":0",
          NO_AT_BRIDGE: "1",
        },
      });
      expect(agentEnv(b)).toMatchObject({
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${b.runtime}/bus`,
        DISPLAY: ":99",
        NO_AT_BRIDGE: "0",
      });
    });

    test("keeps the caller's own environment (HOME, PATH, the rest)", async () => {
      const b = box();
      everythingUp(b);
      await run(b, shell, ["list-apps"], { env: { BUSY_MARKER: "kept" } });
      expect(agentEnv(b)).toMatchObject({
        BUSY_MARKER: "kept",
        HOME: b.home,
        PATH: b.env.PATH,
      });
    });

    test.for([0, 1, 42])(
      "exits with agent-desktop's status %i",
      async (status) => {
        const b = box();
        everythingUp(b);
        expect(
          (
            await run(b, shell, ["click", "@e1"], {
              env: { AD_EXIT: String(status) },
            })
          ).code
        ).toBe(status);
      }
    );

    test("becomes agent-desktop (exec), so a kill or timeout reaches it directly", async () => {
      const b = box();
      everythingUp(b);
      const r = await run(b, shell, ["snapshot"]);
      expect(Number(read(b, "agent.pid"))).toBe(r.pid);
    });

    test("hands agent-desktop its stdin", async () => {
      const b = box();
      everythingUp(b);
      const r = await run(b, shell, ["type", "--stdin"], {
        env: { AD_OUT: "", AD_STDIN: "1" },
        input: "long text\nwith lines",
      });
      expect(r.stdout).toBe("long text\nwith lines");
    });

    test("passes agent-desktop's stderr through", async () => {
      const b = box();
      everythingUp(b);
      expect(
        (
          await run(b, shell, ["click", "@e9"], {
            env: { AD_ERR: "ref @e9 not found" },
          })
        ).stderr
      ).toBe("ref @e9 not found");
    });

    test("prints only agent-desktop's output on stdout, booting chatty daemons or finding them running", async () => {
      const b = box();
      const booting = await run(b, shell, ["snapshot", "--json"], {
        env: { AD_OUT: '{"refs":[]}' },
      });
      const running = await run(b, shell, ["snapshot", "--json"], {
        env: { AD_OUT: '{"refs":[1]}' },
      });
      expect(started(b, "Xvfb")).toHaveLength(1);
      expect([booting.stdout, running.stdout]).toEqual([
        '{"refs":[]}',
        '{"refs":[1]}',
      ]);
    });

    test("keeps Xvfb's output in its log", async () => {
      const b = box();
      await run(b, shell, ["list-apps"]);
      const xvfbLog = readFileSync(join(b.tmp, "desktop-xvfb.log"), "utf8");
      expect(xvfbLog).toContain("Xvfb stdout chatter");
      expect(xvfbLog).toContain("Xvfb stderr chatter");
    });

    test("keeps openbox's output in its log", async () => {
      const b = box();
      await run(b, shell, ["list-apps"]);
      expect(
        await until(() =>
          readFileSync(join(b.tmp, "desktop-openbox.log"), "utf8").includes(
            "stderr chatter"
          )
        )
      ).toBe(true);
      expect(
        readFileSync(join(b.tmp, "desktop-openbox.log"), "utf8")
      ).toContain("openbox stdout chatter");
    });
  });

  describe.concurrent("booting the screen", () => {
    test("starts Xvfb on the display it exports, never listening on TCP", async () => {
      const b = box();
      await run(b, shell, ["list-apps"]);
      const [xvfb] = started(b, "Xvfb");
      const display = must(agentEnv(b).DISPLAY);
      expect(xvfb?.split(" ")[1]).toBe(display);
      // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
      expect(xvfb).toMatch(/ -nolisten tcp(?: |$)/u);
    });

    test("gives Xvfb the 1440x900 screen the hub mirrors", async () => {
      const b = box();
      await run(b, shell, ["list-apps"]);
      // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
      expect(started(b, "Xvfb")[0]).toMatch(/ -screen 0 1440x900x\d+(?: |$)/u);
    });

    test("starts a session bus at the address it exports, forked and without a pid file", async () => {
      const b = box();
      await run(b, shell, ["list-apps"]);
      const [dbus] = started(b, "dbus-daemon");
      expect(dbus?.split(" ").slice(1).sort()).toEqual(
        [
          "--fork",
          "--nopidfile",
          "--session",
          `--address=${agentEnv(b).DBUS_SESSION_BUS_ADDRESS}`,
        ].sort()
      );
      expect(lstatSync(join(b.runtime, "bus")).isSocket()).toBe(true);
    });

    test("creates the runtime dir private to the user", async () => {
      const b = box();
      await run(b, shell, ["list-apps"]);
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX mode checks require masking permission bits
      expect(statSync(b.runtime).mode & 0o777).toBe(0o700);
    });

    test("tightens a runtime dir left with looser permissions", async () => {
      const b = box();
      mkdirSync(b.runtime, { recursive: true });
      chmodSync(b.runtime, 0o755);
      await run(b, shell, ["list-apps"]);
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX mode checks require masking permission bits
      expect(statSync(b.runtime).mode & 0o777).toBe(0o700);
    });

    test("waits for a slow Xvfb before starting openbox and agent-desktop", async () => {
      const b = box();
      await run(b, shell, ["list-apps"], { env: { XVFB: "slow" } });
      expect(read(b, "openbox.screen").trim()).toBe("up");
      expect(read(b, "agent.screen").trim()).toBe("up");
    });

    test("starts openbox on the screen's display", async () => {
      const b = box();
      await run(b, shell, ["list-apps"]);
      expect(await until(() => read(b, "openbox.DISPLAY") !== "")).toBe(true);
      expect(read(b, "openbox.DISPLAY")).toBe(agentEnv(b).DISPLAY);
    });

    // Without it, Chrome crashes on the bot's first key press (desktop-a11y.py).
    test("holds the accessibility listener (desktop-a11y) on the session bus it exports, started once", async () => {
      const b = box();
      await run(b, shell, ["list-apps"]);
      await run(b, shell, ["press", "pagedown"]);
      expect(started(b, "desktop-a11y")).toHaveLength(1);
      expect(read(b, "a11y.bus")).toBe(agentEnv(b).DBUS_SESSION_BUS_ADDRESS);
    });

    test("starts desktop-a11y again after a resume killed it", async () => {
      const b = box();
      everythingUp(b);
      await run(b, shell, ["list-apps"]);
      rmSync(join(b.state, "desktop-a11y-running"));
      await run(b, shell, ["press", "pagedown"]);
      expect(started(b, "desktop-a11y")).toHaveLength(2);
    });

    test("waits for a slowly starting accessibility listener", async () => {
      const b = box();
      const r = await run(b, shell, ["list-apps"], { env: { A11Y: "slow" } });
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
      expect(started(b, "desktop-a11y")).toHaveLength(1);
    });

    test("starts the desktop people see (desktop-session) on a ready screen, every call", async () => {
      const b = box();
      await run(b, shell, ["list-apps"]);
      await run(b, shell, ["snapshot"]);
      expect(started(b, "desktop-session")).toHaveLength(2);
      expect(read(b, "session.screen").trim()).toBe("up");
    });

    test("still runs the bot's command when the desktop session fails", async () => {
      const b = box();
      const r = await run(b, shell, ["list-apps"], {
        env: { SESSION: "fail" },
      });
      expect(started(b, "desktop-session")).toHaveLength(1);
      expect(r.code).toBe(0);
      expect(started(b, "agent-desktop")).toHaveLength(1);
    });

    test("gives up on an Xvfb that never comes up after at most 3 s, without claiming readiness or running agent-desktop", async () => {
      const b = box();
      const r = await run(b, shell, ["list-apps"], {
        env: { XVFB: "fail" },
      });
      const waited = calls(b)
        .filter((entry) => entry.startsWith("sleep "))
        .reduce((s, c) => s + Number(c.split(" ")[1]), 0);
      expect(waited).toBeGreaterThan(0);
      expect(waited).toBeLessThanOrEqual(3);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("did not become ready");
      // Nothing that needs X starts on a screen that never answered.
      for (const daemon of [
        "dbus-daemon",
        "openbox",
        "desktop-a11y",
        "desktop-session",
        "agent-desktop",
      ]) {
        expect(started(b, daemon)).toEqual([]);
      }
      expect(existsSync(join(b.runtime, "desktop-ready"))).toBe(false);
    });

    test("drops a ready marker left by an earlier screen when the new one fails", async () => {
      const b = box();
      mkdirSync(b.runtime, { recursive: true });
      writeFileSync(join(b.runtime, "desktop-ready"), "ready\n");
      writeFileSync(join(b.runtime, "agent-session"), "old-session\n");
      const r = await run(b, shell, ["list-apps"], { env: { XVFB: "fail" } });
      expect(r.code).toBe(1);
      expect(existsSync(join(b.runtime, "desktop-ready"))).toBe(false);
      expect(existsSync(join(b.runtime, "agent-session"))).toBe(false);
    });

    test("fails without the ready marker when Xvfb dies while the desktop starts, and the next call rebuilds it", async () => {
      const b = box();
      const r = await run(b, shell, ["list-apps"], {
        env: { SESSION: "killx" },
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("stopped while the desktop started");
      expect(started(b, "agent-desktop")).toEqual([]);
      expect(existsSync(join(b.runtime, "desktop-ready"))).toBe(false);
      const again = await run(b, shell, ["list-apps"]);
      expect(again.code).toBe(0);
      expect(started(b, "Xvfb")).toHaveLength(2);
      expect(started(b, "agent-desktop")).toHaveLength(1);
      expect(readFileSync(join(b.runtime, "desktop-ready"), "utf8")).toBe(
        "ready\n"
      );
    });

    test("fails without running agent-desktop when D-Bus can't start", async () => {
      const b = box();
      const r = await run(b, shell, ["list-apps"], { env: { DBUS: "fail" } });
      expect(r.code).not.toBe(0);
      expect(started(b, "agent-desktop")).toEqual([]);
    });

    test("retries D-Bus on the next call after a failed start", async () => {
      const b = box();
      await run(b, shell, ["list-apps"], { env: { DBUS: "fail" } });
      const r = await run(b, shell, ["list-apps"]);
      expect(r.code).toBe(0);
      expect(started(b, "dbus-daemon")).toHaveLength(2);
      expect(started(b, "agent-desktop")).toHaveLength(1);
    });
  });

  describe.concurrent("starting only what is missing", () => {
    // After a resume every process is gone; within a session most calls find everything running.
    test.for<
      [string, { screen: boolean; bus: boolean; openbox: boolean }, string[]]
    >([
      [
        "a fresh computer",
        { bus: false, openbox: false, screen: false },
        ["Xvfb", "dbus-daemon", "openbox"],
      ],
      ["a running desktop", { bus: true, openbox: true, screen: true }, []],
      [
        "only the screen missing",
        { bus: true, openbox: true, screen: false },
        ["Xvfb"],
      ],
      [
        "only the bus missing",
        { bus: false, openbox: true, screen: true },
        ["dbus-daemon"],
      ],
      [
        "only openbox missing",
        { bus: true, openbox: false, screen: true },
        ["openbox"],
      ],
      [
        "the screen and the bus missing",
        { bus: false, openbox: true, screen: false },
        ["Xvfb", "dbus-daemon"],
      ],
      [
        "the screen and openbox missing",
        { bus: true, openbox: false, screen: false },
        ["Xvfb", "openbox"],
      ],
      [
        "the bus and openbox missing",
        { bus: false, openbox: false, screen: true },
        ["dbus-daemon", "openbox"],
      ],
    ])("with %s, starts %j", async ([, state, expected]) => {
      const b = box();
      if (state.screen) {
        screenUp(b);
      }
      if (state.bus) {
        busUp(b);
      }
      if (state.openbox) {
        openboxUp(b);
      }
      const r = await run(b, shell, ["list-apps"]);
      expect(r.code).toBe(0);
      const daemons = calls(b)
        .map((c) => must(c.split(" ")[0]))
        .filter((name) => ["Xvfb", "dbus-daemon", "openbox"].includes(name));
      expect(daemons.sort()).toEqual([...expected].sort());
      expect(started(b, "agent-desktop")).toHaveLength(1);
    });

    test("starts nothing again on later calls", async () => {
      const b = box();
      expect((await run(b, shell, ["list-apps"])).code).toBe(0);
      expect((await run(b, shell, ["snapshot"])).code).toBe(0);
      expect((await run(b, shell, ["click", "@e1"])).code).toBe(0);
      expect(
        [
          started(b, "Xvfb"),
          started(b, "dbus-daemon"),
          started(b, "openbox"),
        ].map((c) => c.length)
      ).toEqual([1, 1, 1]);
      expect(started(b, "agent-desktop")).toHaveLength(3);
    });
  });

  describe.concurrent("a fresh screen clears what the last machine left", () => {
    test.for([
      ["with the screen down", false, false],
      ["with the screen up", true, true],
    ] as const)(
      "Xvfb's lock for its display, %s: kept=%s",
      async ([, up, kept]) => {
        const b = box();
        if (up) {
          everythingUp(b);
        }
        // The lock Xvfb leaves for the display this script uses (after a resume nothing holds it).
        writeFileSync(join(b.tmp, ".X99-lock"), "  4242\n");
        await run(b, shell, ["list-apps"]);
        expect(agentEnv(b).DISPLAY).toBe(":99");
        expect(present(join(b.tmp, ".X99-lock"))).toBe(kept);
      }
    );

    test("leaves other displays' X locks alone", async () => {
      const b = box();
      for (const other of [".X0-lock", ".X100-lock", ".X9-lock"]) {
        writeFileSync(join(b.tmp, other), "  1\n");
      }
      await run(b, shell, ["list-apps"]);
      expect(
        [".X0-lock", ".X100-lock", ".X9-lock"].filter((f) =>
          present(join(b.tmp, f))
        )
      ).toHaveLength(3);
    });

    test.for(["SingletonLock", "SingletonSocket", "SingletonCookie"])(
      "removes Chrome's dangling %s on a fresh screen",
      async (name) => {
        const b = box();
        chromeProfile(b);
        await run(b, shell, ["list-apps"]);
        expect(present(join(chrome(b), name))).toBe(false);
      }
    );

    test("keeps the rest of Chrome's profile", async () => {
      const b = box();
      chromeProfile(b);
      writeFileSync(join(chrome(b), "NotSingleton"), "");
      await run(b, shell, ["list-apps"]);
      expect(readdirSync(chrome(b)).sort()).toEqual([
        "Default",
        "Local State",
        "NotSingleton",
      ]);
      expect(
        readFileSync(join(chrome(b), "Default", "Preferences"), "utf8")
      ).toBe("{}");
    });

    test("leaves Chrome's locks alone while the screen (and so Chrome) is running", async () => {
      const b = box();
      chromeProfile(b);
      everythingUp(b);
      await run(b, shell, ["list-apps"]);
      expect(
        ["SingletonLock", "SingletonSocket", "SingletonCookie"].filter((n) =>
          present(join(chrome(b), n))
        )
      ).toHaveLength(3);
    });

    test("handles a HOME with spaces", async () => {
      const b = box("home with spaces");
      chromeProfile(b);
      const r = await run(b, shell, ["list-apps"]);
      expect(r.code).toBe(0);
      expect(present(join(chrome(b), "SingletonLock"))).toBe(false);
      expect(present(join(chrome(b), "Local State"))).toBe(true);
    });

    test("boots fine when Chrome was never opened", async () => {
      const b = box();
      const r = await run(b, shell, ["list-apps"]);
      expect(r.code).toBe(0);
      expect(readdirSync(b.home)).toEqual([]);
    });

    test("brings a resumed computer back: files from before, no processes", async () => {
      const b = box();
      // A first boot, then a stop: every process dies, every file stays.
      expect((await run(b, shell, ["list-apps"])).code).toBe(0);
      chromeProfile(b);
      for (const gone of [
        "display",
        "openbox-running",
        "log",
        "agent.screen",
      ]) {
        rmSync(join(b.state, gone), { force: true });
      }
      rmSync(join(b.runtime, "bus"));
      writeFileSync(join(b.tmp, ".X99-lock"), "  4242\n");
      const r = await run(b, shell, ["launch", "google-chrome"]);
      expect(r.code).toBe(0);
      expect(
        [
          started(b, "Xvfb"),
          started(b, "dbus-daemon"),
          started(b, "openbox"),
        ].map((c) => c.length)
      ).toEqual([1, 1, 1]);
      expect(present(join(b.tmp, ".X99-lock"))).toBe(false);
      expect(present(join(chrome(b), "SingletonLock"))).toBe(false);
      expect(present(join(chrome(b), "Default", "Preferences"))).toBe(true);
      expect(read(b, "agent.screen").trim()).toBe("up");
    });
  });

  describe("the start lock", () => {
    it.concurrent.for([
      "Xvfb",
      "dbus-daemon",
      "openbox",
      "desktop-a11y",
      "desktop-session",
      "agent-desktop",
    ])("%s doesn't inherit the lock's descriptor", async (name) => {
      const b = box();
      await run(b, shell, ["list-apps"]);
      expect(await until(() => read(b, `fd9.${name}`) !== "")).toBe(true);
      expect(read(b, `fd9.${name}`).trim().split("\n")).toEqual(["closed"]);
    });

    it.concurrent("lets parallel calls boot the screen once, all of them on a ready screen", async () => {
      const b = box();
      const results = await Promise.all(
        [1, 2, 3, 4].map((i) =>
          run(b, shell, ["call", String(i)], { env: { XVFB: "slow" } })
        )
      );
      expect(results.map((r) => r.code)).toEqual([0, 0, 0, 0]);
      expect(started(b, "Xvfb")).toHaveLength(1);
      expect(started(b, "dbus-daemon")).toHaveLength(1);
      expect(read(b, "agent.screen").trim().split("\n")).toEqual([
        "up",
        "up",
        "up",
        "up",
      ]);
    });

    it.concurrent("doesn't make a call wait for a long-running agent-desktop", async () => {
      const b = box();
      const first = run(b, shell, ["wait", "--for", "window"], {
        env: { AD_HOLD: "1" },
      });
      expect(
        await until(() => existsSync(join(b.state, "agent-started")))
      ).toBe(true);
      const second = await within(run(b, shell, ["snapshot"]), 2500);
      writeFileSync(join(b.state, "release"), "");
      await first;
      expect(second).not.toBe("timeout");
      expect((second as Result).code).toBe(0);
    });

    it.concurrent("doesn't make a call wait for the daemons left running", async () => {
      const b = box();
      const first = await run(b, shell, ["list-apps"], {
        drain: false,
        env: { XVFB: "hold" },
      });
      expect(first.code).toBe(0);
      const second = await within(run(b, shell, ["snapshot"]), 2500);
      writeFileSync(join(b.state, "release"), "");
      await drain(first.pid);
      expect(second).not.toBe("timeout");
      expect(started(b, "Xvfb")).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// /etc/profile.d/desktop.sh: every login shell (eve runs commands with `bash -lc`) joins the screen.

// ---------------------------------------------------------------------------------------------
// The manual-control lease with the real desktop-control (H-20): an environment variable never
// lets a mutating call skip it; only the descriptor desktop-control passes proves it.

const CONTROL_SCRIPT = new URL("./desktop-control.py", import.meta.url)
  .pathname;

function controlledBox() {
  const b = box();
  const bin = join(b.root, "control-bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "desktop-control"),
    `#!/bin/sh\nexec python3 ${CONTROL_SCRIPT} "$@"\n`,
    { mode: 0o755 }
  );
  // desktop re-executes itself under the lease.
  chmodSync(b.script, 0o755);
  b.env = {
    ...b.env,
    BUSY_DESKTOP_RUNTIME: b.runtime,
    PATH: `${bin}:${b.env.PATH}`,
  };
  const control = (...args: string[]) =>
    spawnSync("python3", [CONTROL_SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, BUSY_DESKTOP_RUNTIME: b.runtime },
    });
  return { b, control };
}

describe.each(SHELLS)("desktop's lease under %s (H-20)", (_, shell) => {
  test("runs a mutating call under the lease without leaking it to agent-desktop or the screen", async () => {
    const { b } = controlledBox();
    const r = await run(b, shell, ["click", "@e1"]);
    expect(r.code).toBe(0);
    expect(started(b, "agent-desktop")).toHaveLength(1);
    expect(read(b, "fd7.agent-desktop").trim()).toBe("closed");
    expect(read(b, "fd7.Xvfb").trim()).toBe("closed");
  });

  test.for([
    ["BUSY_DESKTOP_CONTROLLED=1", { BUSY_DESKTOP_CONTROLLED: "1" }],
    ["a lease fd that isn't open", { BUSY_DESKTOP_LEASE_FD: "7" }],
    [
      "a manual-mode marker",
      { BUSY_DESKTOP_LEASE_FD: "7", BUSY_DESKTOP_LEASE_MODE: "manual" },
    ],
  ] as const)(
    "refuses a mutating call during manual control with %s",
    async ([, env]) => {
      const { b, control } = controlledBox();
      expect(control("acquire", "viewer-a").status).toBe(0);
      const r = await run(b, shell, ["click", "@e1"], { env });
      expect(r.code).not.toBe(0);
      expect(r.stdout).toContain("CONTROL_BUSY");
      expect(started(b, "agent-desktop")).toEqual([]);
    }
  );

  test("refuses a mutating call that forges fd 7 on the lock file itself", async () => {
    const { b, control } = controlledBox();
    expect(control("state").status).toBe(0);
    expect(control("acquire", "viewer-a").status).toBe(0);
    const lock = join(b.runtime, "agent-action.lock");
    const r = await spawnIn(
      b,
      [
        "/bin/sh",
        "-c",
        `exec 7<>"${lock}"; exec ${shell} "${b.script}" click @e1`,
      ],
      { env: { BUSY_DESKTOP_CONTROLLED: "1", BUSY_DESKTOP_LEASE_FD: "7" } }
    );
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("CONTROL_BUSY");
    expect(started(b, "agent-desktop")).toEqual([]);
  });

  test("still answers read-only observations during manual control", async () => {
    const { b, control } = controlledBox();
    expect(control("acquire", "viewer-a").status).toBe(0);
    const r = await run(b, shell, ["snapshot"]);
    expect(r.code).toBe(0);
    expect(started(b, "agent-desktop")).toHaveLength(1);
  });
});

const PROFILE_SHELLS = [
  ["bash", ["/bin/bash"]],
  ["dash", ["/bin/dash"]],
  ["bash --posix", ["/bin/bash", "--posix"]],
] as const;

function profileBox() {
  const b = box();
  const path = join(b.root, "desktop-profile.sh");
  writeFileSync(path, PROFILE);
  const source = (shell: readonly string[], then: string, before = "") =>
    spawnSync(
      must(shell[0]),
      [...shell.slice(1), "-c", `${before}. "${path}"; ${then}`],
      { encoding: "utf8", env: b.env, timeout: 5000 }
    );
  return { b, source };
}
const envOf = (out: string) =>
  Object.fromEntries(
    out
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
  );

describe.concurrent("the login profile", () => {
  test.for(PROFILE_SHELLS)(
    "exports the screen to child processes under %s",
    ([, shell]) => {
      const { source } = profileBox();
      const r = source(shell, "/usr/bin/env");
      expect(r.status).toBe(0);
      expect(Object.keys(envOf(r.stdout))).toEqual(
        expect.arrayContaining([
          "DISPLAY",
          "DBUS_SESSION_BUS_ADDRESS",
          "ACCESSIBILITY_ENABLED",
        ])
      );
    }
  );

  test.for(PROFILE_SHELLS)(
    "prints nothing when sourced by %s (it would end up in every command's output)",
    ([, shell]) => {
      const { source } = profileBox();
      const r = source(shell, "true");
      expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
    }
  );

  test.for(PROFILE_SHELLS)(
    "sources cleanly under set -eu in %s",
    ([, shell]) => {
      const { source } = profileBox();
      const r = source(shell, 'echo "$DISPLAY"', "set -eu; ");
      expect([r.status, r.stdout.trim()]).toEqual([0, ":99"]);
    }
  );

  test("runs no commands and creates no files", () => {
    const { b, source } = profileBox();
    expect(source(["/bin/bash"], "true").status).toBe(0);
    expect(calls(b)).toEqual([]);
    expect(readdirSync(b.home)).toEqual([]);
    expect(readdirSync(b.tmp)).toEqual([]);
  });

  test("leaves PATH and HOME alone", () => {
    const { b, source } = profileBox();
    expect(envOf(source(["/bin/bash"], "/usr/bin/env").stdout)).toMatchObject({
      HOME: b.home,
      PATH: b.env.PATH,
    });
  });

  // A command that opens an app directly (not through `desktop`) must land on the same screen and bus.
  test.for(["DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "ACCESSIBILITY_ENABLED"])(
    "sets %s to what desktop gives agent-desktop",
    async (name) => {
      const { b, source } = profileBox();
      await run(b, "/bin/bash", ["list-apps"]);
      const fromDesktop = agentEnv(b)[name]?.replaceAll(b.tmp, "/tmp");
      expect(envOf(source(["/bin/bash"], "/usr/bin/env").stdout)[name]).toBe(
        fromDesktop
      );
    }
  );
});
