import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// desktop-live.sh runs for real under sh, with stubs for what it drives (desktop, desktop-browser,
// websockify, xdpyinfo, pgrep). x11vnc is a real background process (perl) that publishes a fake
// /proc entry (stat with a start time, cmdline, a socket descriptor) and a LISTEN row in a fake
// /proc/net/tcp, so the script's ownership checks and its TERM go to real PIDs the test owns.
// Its /tmp and /proc paths are rewritten into a temp dir, so a test never touches the real /tmp,
// the real /proc or anyone else's process.
const SOURCE = readFileSync(
  new URL("./desktop-live.sh", import.meta.url),
  "utf8"
);

const WRITES_PROC = />\s*"?\/proc\//u;

let root = "";
const state = () => join(root, "state");
const log = () =>
  existsSync(join(root, "calls.log"))
    ? readFileSync(join(root, "calls.log"), "utf8").trim().split("\n")
    : [];
const liveDir = () => join(root, "tmp", "desktop-runtime", "live");

const STUB = (name: string, body: string) =>
  `#!/bin/sh\necho "${name} $*" >> "$ROOT/calls.log"\n${body}\n`;

const BROWSER_OK =
  '{"ok":true,"cdp":{"port":9222,"http_endpoint":"http://127.0.0.1:9222","websocket_url":"ws://127.0.0.1:9222/devtools/browser/test"}}';
const browserStub = (line: string, code = 1) =>
  STUB("desktop-browser", `printf '%s\\n' '${line}'; exit ${code}`);

// A fake x11vnc daemon: argv[0] is the test root, the rest are x11vnc's arguments.
const FAKE_X11VNC = String.raw`
use strict; use warnings; use Time::HiRes qw(time sleep); use File::Path qw(remove_tree);
my ($root, @args) = @ARGV;
my $pid = $$; my $start = int(time() * 1e6);
my $dir = "$root/proc/$pid";
mkdir $dir; mkdir "$dir/fd";
open(my $st, '>', "$dir/stat") or die; print $st "$pid (x11vnc) S" . (" 1" x 18) . " $start 0 0\n"; close $st;
open(my $cl, '>', "$dir/cmdline") or die; print $cl join("\0", "x11vnc", @args) . "\0"; close $cl;
open(my $reg, '>>', "$root/state/daemons"); print $reg "$pid\n"; close $reg;
my %opt; for (my $i = 0; $i < @args; $i++) { $opt{$args[$i]} = $args[$i + 1] if $args[$i] =~ /^-/ }
open(my $pw, '>', "$root/state/passwd.$pid"); print $pw "$opt{'-passwd'} $opt{'-viewpasswd'}"; close $pw;
my $listens = ! -e "$root/state/port-taken" && ($opt{'-rfbport'} // '') eq '5900';
if ($listens) {
  symlink "socket:[$pid]", "$dir/fd/3";
  open(my $tcp, '>', "$root/proc/net/tcp"); print $tcp "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:170C 00000000:0000 0A 00000000:00000000 00:00000000 00000000   501        0 $pid 1\n"; close $tcp;
}
sub cleanup {
  remove_tree($dir);
  if ($listens) { open(my $tcp, '>', "$root/proc/net/tcp"); close $tcp; }
}
$SIG{TERM} = sub {
  open(my $l, '>>', "$root/calls.log"); print $l "TERM $pid\n"; close $l;
  while (-e "$root/state/hold-term") { sleep 0.05 }
  cleanup(); exit 0;
};
open(my $ready, '>', "$root/state/ready.$pid"); close $ready;
sleep 600; cleanup();
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "desktop-live-"));
  for (const dir of ["bin", "state", "tmp", "proc/net"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, "proc", "net", "tcp"), "");
  writeFileSync(join(root, "fake-x11vnc.pl"), FAKE_X11VNC);
  // fd8: whether the lock's descriptor reached what the script started (it must not: it would hold the lock).
  const fd8 = (name: string) =>
    `if (: >&8) 2>/dev/null; then echo open; else echo closed; fi >> "$ROOT/fd8.${name}"`;
  const stubs: Record<string, string> = {
    desktop: STUB(
      "desktop",
      'if [ -e "$ROOT/state/no-display" ]; then echo "desktop: no screen" >&2; exit 1; fi'
    ),
    // A slow managed-browser launch, so two runs at once would both find no Chrome without the lock.
    "desktop-browser": STUB(
      "desktop-browser",
      `if [ ! -e "$ROOT/state/chrome" ]; then ${fd8("chrome")}; /bin/sleep 0.3; touch "$ROOT/state/chrome"; fi; printf '%s\\n' '${BROWSER_OK}'`
    ),
    // util-linux flock(1) isn't on macOS: the same flock(2) call, on the inherited descriptor.
    flock:
      '#!/bin/sh\nexec /usr/bin/perl -MFcntl=:flock -e \'open(my $fh, ">&=", $ARGV[-1]) or die; flock($fh, LOCK_EX) or die\' -- "$@"\n',
    // pgrep -f PATTERN (websockify only): "running" means a marker exists.
    pgrep: '#!/bin/sh\ntest -e "$ROOT/state/websockify"\n',
    websockify: STUB(
      "websockify",
      `${fd8("websockify")}; touch "$ROOT/state/websockify"; if [ -e "$ROOT/state/display-dies" ]; then touch "$ROOT/state/no-display"; fi`
    ),
    x11vnc: STUB(
      "x11vnc",
      `${fd8("x11vnc")}
[ -e "$ROOT/state/x11vnc-fails" ] && exit 1
/usr/bin/perl "$ROOT/fake-x11vnc.pl" "$ROOT" "$@" </dev/null >/dev/null 2>&1 8>&- &
pid=$!
i=0; while [ ! -e "$ROOT/state/ready.$pid" ] && [ $i -lt 300 ]; do /bin/sleep 0.01; i=$((i+1)); done`
    ),
    xdpyinfo: '#!/bin/sh\ntest ! -e "$ROOT/state/no-display"\n',
  };
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(root, "bin", name), body, { mode: 0o755 });
  }
  writeFileSync(
    join(root, "desktop-live"),
    SOURCE.replaceAll("/tmp/", `${root}/tmp/`).replaceAll(
      "/proc/",
      `${root}/proc/`
    ),
    { mode: 0o755 }
  );
});

const daemons = () =>
  existsSync(join(state(), "daemons"))
    ? readFileSync(join(state(), "daemons"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(Number)
    : [];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function killAll() {
  for (const pid of daemons()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
afterEach(() => {
  killAll();
  rmSync(root, { force: true, recursive: true });
});

const ENV = () => ({ PATH: `${join(root, "bin")}:/usr/bin:/bin`, ROOT: root });
const run = (...args: string[]) =>
  spawnSync("/bin/sh", [join(root, "desktop-live"), ...args], {
    encoding: "utf8",
    env: ENV(),
  });
const runAsync = (...args: string[]) =>
  new Promise<number | null>((resolve) =>
    spawn("/bin/sh", [join(root, "desktop-live"), ...args], {
      env: ENV(),
    }).on("close", resolve)
  );
const calls = (name: string) => log().filter((l) => l.startsWith(`${name} `));
const running = (name: string) => existsSync(join(state(), name));
const identity = () => {
  const file = join(liveDir(), "x11vnc.identity");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
};
const passwords = () => {
  const file = join(liveDir(), "passwords");
  return existsSync(file) ? readFileSync(file, "utf8") : null;
};
const identityPid = () => Number(identity()?.split(" ")[0]);
/** The passwords the x11vnc process recorded in the identity really started with. */
const servedPasswords = () =>
  readFileSync(join(state(), `passwd.${identityPid()}`), "utf8");
const status = (stdout: string) =>
  JSON.parse(stdout.trim().split("\n").at(-1) ?? "null");
/** A process the test owns that looks like somebody else's x11vnc in the fake /proc. */
function foreignX11vnc(args: string[]) {
  const child = spawn(
    "/usr/bin/perl",
    [join(root, "fake-x11vnc.pl"), root, ...args],
    {
      detached: true,
      stdio: "ignore",
    }
  );
  child.unref();
  const pid = child.pid as number;
  return { pid };
}
async function waitFor(check: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    // biome-ignore lint/performance/noAwaitInLoops: polling a condition sequentially is the point
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
}

// Every run spawns sh and freshly written stubs, which on macOS can take a second or two to start, and
// some tests run it two or three times: under a parallel suite they went past the default 5 s.
describe("desktop-live", { timeout: 30_000 }, () => {
  it("never writes outside its temp dir (the script's only absolute paths are /tmp ones, plus /proc reads)", () => {
    const code = SOURCE.split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(
      [...code.matchAll(/(?<![\w$])\/(?!tmp\/|proc\/)[\w./-]+/gu)]
        .map((m) => m[0])
        .filter((p) => !p.startsWith("/dev/"))
    ).toEqual([]);
    // /proc is only ever read.
    expect(code).not.toMatch(WRITES_PROC);
  });

  it.each([
    [[]],
    [["tok"]],
    [["tok", "ctl"]],
    [["tok", "ctl", "view", "extra"]],
  ])("refuses %j: it needs a token and two passwords", (args) => {
    const r = run(...args);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: desktop-live");
    expect(log()).toEqual([]);
  });

  describe("on a computer with nothing running", () => {
    let first: ReturnType<typeof run>;
    beforeEach(() => {
      first = run("t0ken", "ctl12345", "view1234");
      // biome-ignore lint/suspicious/noMisplacedAssertion: the setup must fail before any case runs
      expect(first.status).toBe(0);
    }, 30_000);

    it("boots the screen first", () => {
      expect(log()[0]).toBe("desktop version");
    });

    it("opens Chrome through the one managed browser helper", () => {
      expect(calls("desktop-browser")).toContainEqual("desktop-browser ensure");
    });

    it("reports the screen and the browser as ready", () => {
      expect(status(first.stdout)).toEqual({
        browser: "ready",
        ok: true,
        screen: "ready",
      });
    });

    it("shares the screen on localhost only, with a control and a view-only password", () => {
      const [x11vnc] = calls("x11vnc");
      // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
      expect(x11vnc).toMatch(/-display :99 /u);
      // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
      expect(x11vnc).toMatch(/ -localhost /u);
      // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
      expect(x11vnc).toMatch(/ -rfbport 5900 /u);
      // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
      expect(x11vnc).toMatch(/ -passwd ctl12345 -viewpasswd view1234 /u);
    });

    it("records the x11vnc it started, and passwords that match it", () => {
      expect(identityPid()).toBe(daemons()[0]);
      expect(passwords()).toBe("ctl12345 view1234");
      expect(servedPasswords()).toBe("ctl12345 view1234");
    });

    it("lets websockify in on 6080 only with the token", () => {
      expect(calls("websockify")).toEqual([
        `websockify --daemon --token-plugin TokenFile --token-source ${liveDir()}/tokens 6080`,
      ]);
      expect(readFileSync(join(liveDir(), "tokens"), "utf8")).toBe(
        "t0ken: localhost:5900\n"
      );
    });

    it("keeps its secrets in a dir only the bot's user can read", () => {
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX mode checks require masking mode bits
      expect(statSync(liveDir()).mode & 0o777).toBe(0o700);
      for (const name of ["passwords", "tokens", "x11vnc.identity"]) {
        // biome-ignore lint/suspicious/noBitwiseOperators: POSIX mode checks require masking mode bits
        expect(statSync(join(liveDir(), name)).mode & 0o077).toBe(0);
      }
      // Nothing half-written is left behind.
      expect(readdirSync(liveDir()).filter((f) => f.endsWith(".tmp"))).toEqual(
        []
      );
    });
  });

  it("starts nothing twice when run again with the same secrets", () => {
    run("t0ken", "ctl12345", "view1234");
    run("t0ken", "ctl12345", "view1234");
    expect(calls("x11vnc")).toHaveLength(1);
    expect(calls("websockify")).toHaveLength(1);
    expect(calls("TERM")).toEqual([]);
  });

  it("restarts its own x11vnc when the passwords change (it reads them only at start)", () => {
    run("t0ken", "ctl12345", "view1234");
    const old = identityPid();
    run("n3w", "ctlNEW00", "viewNEW0");
    expect(calls("TERM")).toEqual([`TERM ${old}`]);
    expect(alive(old)).toBe(false);
    expect(calls("x11vnc")).toHaveLength(2);
    expect(identityPid()).not.toBe(old);
    expect(passwords()).toBe("ctlNEW00 viewNEW0");
    expect(servedPasswords()).toBe("ctlNEW00 viewNEW0");
    expect(readFileSync(join(liveDir(), "tokens"), "utf8")).toBe(
      "n3w: localhost:5900\n"
    );
    expect(calls("websockify")).toHaveLength(1);
  });

  // Seen on a real computer: the old x11vnc took a moment to exit, and the next one was never started.
  it("restarts x11vnc for new passwords even when the old one takes a moment to exit", async () => {
    run("t0ken", "ctl12345", "view1234");
    writeFileSync(join(state(), "hold-term"), "");
    setTimeout(() => rmSync(join(state(), "hold-term")), 500);
    const code = await runAsync("n3w", "ctlNEW00", "viewNEW0");
    expect(code).toBe(0);
    expect(passwords()).toBe("ctlNEW00 viewNEW0");
    expect(servedPasswords()).toBe("ctlNEW00 viewNEW0");
  });

  it("keeps the old credentials and asks for a retry while its x11vnc outlasts the 5 s stop, then rotates", async () => {
    run("t0ken", "ctl12345", "view1234");
    const old = identityPid();
    const oldIdentity = identity();
    writeFileSync(join(state(), "hold-term"), "");
    const slow = run("n3w", "ctlNEW00", "viewNEW0");
    expect(slow.status).toBe(75);
    expect(slow.stderr).toContain("still stopping");
    // Still the old process, still the old passwords on record: nothing claims the new ones.
    expect(alive(old)).toBe(true);
    expect(identity()).toBe(oldIdentity);
    expect(passwords()).toBe("ctl12345 view1234");
    expect(calls("x11vnc")).toHaveLength(1);
    // Never escalates to SIGKILL on its own.
    expect(calls("TERM")).toEqual([`TERM ${old}`]);
    rmSync(join(state(), "hold-term"));
    expect(await waitFor(() => !alive(old))).toBe(true);
    const retry = run("n3w", "ctlNEW00", "viewNEW0");
    expect(retry.status).toBe(0);
    expect(identityPid()).not.toBe(old);
    expect(passwords()).toBe("ctlNEW00 viewNEW0");
    expect(servedPasswords()).toBe("ctlNEW00 viewNEW0");
  }, 40_000);

  it("never signals somebody else's x11vnc, even one with the same name", () => {
    const foreign = foreignX11vnc(["-display", ":0", "-rfbport", "5901"]);
    run("t0ken", "ctl12345", "view1234");
    run("n3w", "ctlNEW00", "viewNEW0");
    expect(alive(foreign.pid)).toBe(true);
    expect(calls("TERM").filter((c) => c === `TERM ${foreign.pid}`)).toEqual(
      []
    );
    expect(passwords()).toBe("ctlNEW00 viewNEW0");
  });

  it("leaves a foreign process alone when its PID reuses the recorded one", async () => {
    // The recorded x11vnc is gone and its PID now belongs to another process (other start time).
    const reused = foreignX11vnc(["-display", ":99", "-rfbport", "5901"]);
    expect(
      await waitFor(() => existsSync(join(state(), `ready.${reused.pid}`)))
    ).toBe(true);
    mkdirSync(liveDir(), { recursive: true });
    writeFileSync(join(liveDir(), "x11vnc.identity"), `${reused.pid} 1\n`);
    writeFileSync(join(liveDir(), "passwords"), "ctl12345 view1234");
    const r = run("t0ken", "ctl12345", "view1234");
    expect(r.status).toBe(0);
    expect(alive(reused.pid)).toBe(true);
    expect(calls("TERM")).toEqual([]);
    expect(identityPid()).not.toBe(reused.pid);
    expect(servedPasswords()).toBe("ctl12345 view1234");
  });

  it("fails retryably without new credentials when the new x11vnc cannot own the port, and spares whoever holds it", async () => {
    run("t0ken", "ctl12345", "view1234");
    const old = identityPid();
    // Somebody else grabs 5900 between the stop and the new start.
    writeFileSync(join(state(), "port-taken"), "");
    const holder = foreignX11vnc(["-display", ":0", "-rfbport", "5901"]);
    expect(
      await waitFor(() => existsSync(join(state(), `ready.${holder.pid}`)))
    ).toBe(true);
    const r = run("n3w", "ctlNEW00", "viewNEW0");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("did not start listening");
    expect(alive(old)).toBe(false);
    expect(alive(holder.pid)).toBe(true);
    expect(passwords()).toBe("ctl12345 view1234");
    expect(identity()).toBeNull();
    // Once the port is free again the next call finishes the rotation.
    rmSync(join(state(), "port-taken"));
    expect(run("n3w", "ctlNEW00", "viewNEW0").status).toBe(0);
    expect(passwords()).toBe("ctlNEW00 viewNEW0");
    expect(servedPasswords()).toBe("ctlNEW00 viewNEW0");
  });

  it("brings both back after a resume killed every process", async () => {
    run("t0ken", "ctl12345", "view1234");
    const old = identityPid();
    killAll();
    expect(await waitFor(() => !alive(old))).toBe(true);
    rmSync(join(state(), "websockify"));
    expect(run("t0ken", "ctl12345", "view1234").status).toBe(0);
    expect(calls("x11vnc")).toHaveLength(2);
    expect(calls("websockify")).toHaveLength(2);
    // Same passwords and a dead process: nothing to stop, only what the resume took down comes back.
    expect(calls("TERM")).toEqual([]);
    expect(servedPasswords()).toBe("ctl12345 view1234");
  });

  it("opens one Chrome when two viewers open the screen at the same time", async () => {
    const both = await Promise.all([
      runAsync("t0ken", "ctl12345", "view1234"),
      runAsync("t0ken", "ctl12345", "view1234"),
    ]);
    expect(both).toEqual([0, 0]);
    expect(
      calls("desktop-browser").filter((c) => c === "desktop-browser ensure")
    ).toHaveLength(2);
    expect(readFileSync(join(root, "fd8.chrome"), "utf8").trim()).toBe(
      "closed"
    );
    expect(calls("x11vnc")).toHaveLength(1);
    expect(calls("websockify")).toHaveLength(1);
  });

  it.each(["chrome", "x11vnc", "websockify"])(
    "doesn't let %s inherit the lock",
    (name) => {
      run("t0ken", "ctl12345", "view1234");
      expect(readFileSync(join(root, `fd8.${name}`), "utf8").trim()).toBe(
        "closed"
      );
    }
  );

  it("doesn't open a second Chrome", () => {
    writeFileSync(join(state(), "chrome"), "");
    run("t0ken", "ctl12345", "view1234");
    expect(calls("desktop-browser")).toEqual(["desktop-browser ensure"]);
  });

  describe("when the managed browser is not available", () => {
    it("still shares an answering screen while desktop-control is busy, and says the browser is busy", () => {
      writeFileSync(
        join(root, "bin", "desktop-browser"),
        browserStub(
          '{"ok":false,"error":"an agent desktop action is in flight","code":"CONTROL_BUSY"}'
        ),
        { mode: 0o755 }
      );
      const r = run("t0ken", "ctl12345", "view1234");
      expect(r.status).toBe(0);
      expect(status(r.stdout)).toEqual({
        browser: "busy",
        ok: true,
        screen: "ready",
      });
      expect(calls("x11vnc")).toHaveLength(1);
      expect(running("websockify")).toBe(true);
      expect(servedPasswords()).toBe("ctl12345 view1234");
    });

    it("comes back to a ready browser on the next call once the lease is free", () => {
      writeFileSync(
        join(root, "bin", "desktop-browser"),
        browserStub(
          '{"ok":false,"error":"manual control is active","code":"CONTROL_BUSY"}'
        ),
        { mode: 0o755 }
      );
      expect(status(run("t0ken", "ctl12345", "view1234").stdout).browser).toBe(
        "busy"
      );
      writeFileSync(
        join(root, "bin", "desktop-browser"),
        browserStub(BROWSER_OK, 0),
        { mode: 0o755 }
      );
      const again = run("t0ken", "ctl12345", "view1234");
      expect(status(again.stdout).browser).toBe("ready");
      expect(calls("x11vnc")).toHaveLength(1);
    });

    it("does not share the screen when desktop-control is busy but X does not answer", () => {
      writeFileSync(
        join(root, "bin", "desktop-browser"),
        browserStub(
          '{"ok":false,"error":"an agent desktop action is in flight","code":"CONTROL_BUSY"}'
        ),
        { mode: 0o755 }
      );
      // desktop version passed, then the display went away before the check.
      writeFileSync(
        join(root, "bin", "desktop"),
        STUB("desktop", 'touch "$ROOT/state/no-display"'),
        { mode: 0o755 }
      );
      expect(run("t0ken", "ctl12345", "view1234").status).not.toBe(0);
      expect(calls("x11vnc")).toEqual([]);
      expect(calls("websockify")).toEqual([]);
    });

    it.each([
      [
        "BROWSER_UNMANAGED",
        '{"ok":false,"error":"Chrome is already running without a managed CDP endpoint","code":"BROWSER_UNMANAGED"}',
      ],
      [
        "BROWSER_ENDPOINT_INVALID",
        '{"ok":false,"error":"launch returned no verified CDP endpoint","code":"BROWSER_ENDPOINT_INVALID"}',
      ],
      [
        "BROWSER_LAUNCH_FAILED",
        '{"ok":false,"error":"managed Chrome could not be launched","code":"BROWSER_LAUNCH_FAILED"}',
      ],
      ["an unreadable answer", "Traceback (most recent call last):"],
      ["a bare failure", ""],
    ])("fails before sharing on %s", (_, line) => {
      writeFileSync(join(root, "bin", "desktop-browser"), browserStub(line), {
        mode: 0o755,
      });
      const r = run("t0ken", "ctl12345", "view1234");
      expect(r.status).not.toBe(0);
      expect(r.stdout).toBe("");
      expect(calls("x11vnc")).toEqual([]);
      expect(calls("websockify")).toEqual([]);
      expect(passwords()).toBeNull();
    });
  });

  it("fails when the screen can't boot, before sharing anything", () => {
    writeFileSync(join(root, "bin", "desktop"), STUB("desktop", "exit 1"), {
      mode: 0o755,
    });
    expect(run("t0ken", "ctl12345", "view1234").status).not.toBe(0);
    expect(calls("x11vnc")).toEqual([]);
    expect(calls("websockify")).toEqual([]);
  });

  it("does not report the screen shared when X goes away while it starts", () => {
    writeFileSync(join(state(), "display-dies"), "");
    const r = run("t0ken", "ctl12345", "view1234");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("stopped answering");
    expect(r.stdout).toBe("");
  });
});
