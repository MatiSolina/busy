// The self-update in main.mjs (checkForUpdate / installUpdate / recoverUpdate) against an in-memory electron.
// os.tmpdir() and userData point at a per-test temp dir, so the real mkdtemp/writeFile land there; execFile/spawn
// are mocked, except in the end-to-end blocks, which extract a real zip with ditto, verify it and then run the
// updater copy it was handed with sh.
// biome-ignore lint/performance/noNamespaceImport: the test replaces selected child_process exports while preserving the rest
import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
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
// biome-ignore lint/performance/noNamespaceImport: the test replaces tmpdir while preserving the rest of node:os
import * as os from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  it as test,
  vi,
} from "vitest";
import { release as hubRelease } from "../hub/lib/install";
import { type FakeElectron, fakeElectron, flush } from "./fake-electron";
import {
  exchangeAvailable,
  infoPlist,
  makeBundle,
  toolsBin,
  withPerlHook,
} from "./update.fixture";
import { UPDATER_FILE, UPDATER_SCRIPT } from "./update.mjs";

const HUB = "https://app.busybot.dev";
const SIX_HOURS = 6 * 60 * 60 * 1000;
const VERSION_URL = `${HUB}/api/download/version`;
const DOWNLOAD_URL = `${HUB}/api/download`;
const present = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Expected a present test value");
  }
  return value;
};
const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");

// A real zip of a fake Busy.app, built once with ditto.
const fixtures = mkdtempSync(join(os.tmpdir(), "busy-main-update-fixtures-"));
function buildZip(
  name: string,
  files: Record<string, string>,
  top = "Busy.app"
) {
  const src = join(fixtures, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(src, top, path, ".."), { recursive: true });
    writeFileSync(join(src, top, path), content, {
      mode: path.startsWith("Contents/MacOS/") ? 0o755 : 0o644,
    });
  }
  const zip = join(fixtures, `${name}.zip`);
  childProcess.execFileSync("/usr/bin/ditto", [
    "-c",
    "-k",
    "--keepParent",
    join(src, top),
    zip,
  ]);
  return new Uint8Array(readFileSync(zip));
}
const ZIP = buildZip("release", {
  "Contents/Info.plist": infoPlist({ version: "0.3.0" }),
  "Contents/MacOS/Busy": "build 0.3.0",
});
const OTHER_ZIP = buildZip("other", {
  "Contents/Info.plist": infoPlist({ version: "0.2.9" }),
  "Contents/MacOS/Busy": "build 0.2.9",
});
const ZIP_SHA = sha(ZIP);

let fake: FakeElectron;
let root: string;
let child: { execFile: Mock; spawn: Mock; unref: Mock };
const savedExecPath = process.execPath;
const savedEnv = process.env.BUSY_URL;

type Routes = Record<string, () => Response | Promise<Response>>;
const published =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status });
const offer = (version = "0.3.0", sha256 = ZIP_SHA): Routes => ({
  [VERSION_URL]: published({ sha256, version }),
  [DOWNLOAD_URL]: () => new Response(ZIP),
});

type ExecFile = (
  file: string,
  args: string[],
  cb: (err: Error | null, stdout?: string, stderr?: string) => void
) => unknown;

async function boot(
  opts: {
    routes?: Routes;
    version?: string;
    packaged?: boolean;
    hub?: string;
    answer?: number;
    execPath?: string;
    execFile?: ExecFile;
  } = {}
) {
  fake = fakeElectron({
    packaged: opts.packaged ?? true,
    paths: { userData: join(root, "userData") },
    version: opts.version ?? "0.2.0",
  });
  const routes = opts.routes ?? {};
  fake.net.fetch.mockImplementation((url: string) => {
    fake.calls.push(`fetch ${url}`);
    return Promise.resolve(
      routes[url]?.() ?? new Response("not found", { status: 404 })
    );
  });
  fake.dialog.showMessageBox.mockImplementation(() => {
    fake.calls.push("showMessageBox");
    return Promise.resolve({
      checkboxChecked: false,
      response: opts.answer ?? 1,
    });
  });
  const unref = vi.fn();
  child = {
    execFile: vi.fn<ExecFile>((file, args, cb) => {
      fake.calls.push("execFile");
      return opts.execFile ? opts.execFile(file, args, cb) : cb(null, "", "");
    }),
    spawn: vi.fn(() => {
      fake.calls.push("spawn");
      return { unref };
    }),
    unref,
  };
  process.execPath =
    opts.execPath ??
    join(root, "Applications", "Busy.app", "Contents", "MacOS", "Busy");
  if (opts.hub === undefined) {
    delete process.env.BUSY_URL;
  } else {
    process.env.BUSY_URL = opts.hub;
  }
  vi.resetModules();
  vi.doMock("electron", () => fake.module);
  vi.doMock("node:child_process", () => ({
    ...childProcess,
    execFile: child.execFile,
    spawn: child.spawn,
  }));
  vi.doMock("node:os", () => ({ ...os, tmpdir: () => root }));
  await import("./main.mjs");
  fake.ready();
  await flush();
  return fake;
}

/** Wait for an accepted update to end, one way or the other. */
const finished = () =>
  vi.waitFor(
    () =>
      // biome-ignore lint/suspicious/noMisplacedAssertion: finished() is a test synchronization helper
      expect(
        fake.app.quit.mock.calls.length +
          fake.dialog.showErrorBox.mock.calls.length
      ).toBeGreaterThan(0),
    {
      interval: 2,
      timeout: 5000,
    }
  );
const fetched = (url: string) =>
  fake.net.fetch.mock.calls.filter((c) => c[0] === url).length;
const updateDirs = () =>
  readdirSync(root).filter((n) => n.startsWith("busy-update-"));
const errorText = () =>
  fake.dialog.showErrorBox.mock.calls.map((c) => `${c[0]}: ${c[1]}`).join("\n");

beforeEach(() => {
  root = mkdtempSync(join(os.tmpdir(), "busy-main-update-"));
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("electron");
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:os");
  process.execPath = savedExecPath;
  if (savedEnv === undefined) {
    delete process.env.BUSY_URL;
  } else {
    process.env.BUSY_URL = savedEnv;
  }
  rmSync(root, { force: true, recursive: true });
});

afterAll(() => rmSync(fixtures, { force: true, recursive: true }));

describe("when it checks", () => {
  it("checks the hub's published version once at startup", async () => {
    await boot();
    expect(fake.net.fetch.mock.calls.map((c) => c[0])).toEqual([VERSION_URL]);
  });

  it("checks only after the window is up", async () => {
    await boot();
    expect(fake.calls.indexOf(`fetch ${VERSION_URL}`)).toBeGreaterThan(
      fake.calls.indexOf("new BrowserWindow")
    );
  });

  it("never checks from an unpackaged dev run, even after a day", async () => {
    await boot({ packaged: false });
    await vi.advanceTimersByTimeAsync(4 * SIX_HOURS);
    expect(fake.net.fetch).not.toHaveBeenCalled();
  });

  it("checks again every six hours, not sooner", async () => {
    await boot();
    await vi.advanceTimersByTimeAsync(SIX_HOURS - 1);
    expect(fetched(VERSION_URL)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetched(VERSION_URL)).toBe(2);
    await vi.advanceTimersByTimeAsync(SIX_HOURS);
    expect(fetched(VERSION_URL)).toBe(3);
  });

  it("asks the hub BUSY_URL points at", async () => {
    await boot({ hub: "https://busy.localhost" });
    expect(fake.net.fetch.mock.calls.map((c) => c[0])).toEqual([
      "https://busy.localhost/api/download/version",
    ]);
  });

  it("keeps checking after a check fails on the network", async () => {
    await boot({
      routes: {
        [VERSION_URL]: () => Promise.reject(new TypeError("fetch failed")),
      },
    });
    await vi.advanceTimersByTimeAsync(SIX_HOURS);
    expect(fetched(VERSION_URL)).toBe(2);
  });

  it("does not stack a second prompt while the first is still open", async () => {
    let answer!: (r: { response: number; checkboxChecked: boolean }) => void;
    await boot({ routes: offer() });
    expect(fake.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    // (boot's default answer already resolved; re-arm a pending dialog for the next check)
    fake.dialog.showMessageBox.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    await vi.advanceTimersByTimeAsync(SIX_HOURS);
    expect(fake.dialog.showMessageBox).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(SIX_HOURS);
    await vi.advanceTimersByTimeAsync(SIX_HOURS);
    expect(fake.dialog.showMessageBox).toHaveBeenCalledTimes(2);
    expect(fetched(VERSION_URL)).toBe(2);
    answer({ checkboxChecked: false, response: 1 });
    await flush();
    await vi.advanceTimersByTimeAsync(SIX_HOURS);
    expect(fetched(VERSION_URL)).toBe(3);
  });

  it("checks again after an accepted update failed", async () => {
    await boot({
      answer: 0,
      routes: {
        ...offer(),
        [DOWNLOAD_URL]: () => new Response("", { status: 500 }),
      },
    });
    await finished();
    await vi.advanceTimersByTimeAsync(SIX_HOURS);
    expect(fetched(VERSION_URL)).toBe(2);
    expect(fetched(DOWNLOAD_URL)).toBe(2);
  });
});

describe("what the hub publishes", () => {
  const quiet = [
    {
      label: "nothing published (503, as the hub answers)",
      route: published({ error: "no release published" }, 503),
    },
    { label: "a 404", route: () => new Response("Not Found", { status: 404 }) },
    {
      label: "a newer release behind a 500",
      route: published({ sha256: ZIP_SHA, version: "9.9.9" }, 500),
    },
    {
      label: "an HTML page with status 200",
      route: () => new Response("<!doctype html><title>Vercel</title>"),
    },
    {
      label: "a truncated JSON body",
      route: () => new Response('{"version":"0.3.0","sha'),
    },
    { label: "JSON null", route: published(null) },
    { label: "an empty JSON array", route: published([]) },
    {
      label: "the installed version",
      route: published({ sha256: ZIP_SHA, version: "0.2.0" }),
    },
    {
      label: "an older version",
      route: published({ sha256: ZIP_SHA, version: "0.1.9" }),
    },
    {
      installed: "0.11.0",
      label: "a version that compares as text but not as numbers",
      route: published({ sha256: ZIP_SHA, version: "0.10.0" }),
    },
    {
      label: "the word latest",
      route: published({ sha256: ZIP_SHA, version: "latest" }),
    },
    {
      label: "a v-prefixed version",
      route: published({ sha256: ZIP_SHA, version: "v0.3.0" }),
    },
    {
      label: "a prerelease",
      route: published({ sha256: ZIP_SHA, version: "0.3.0-beta.1" }),
    },
    {
      label: "two-part version",
      route: published({ sha256: ZIP_SHA, version: "0.3" }),
    },
    {
      label: "a numeric version",
      route: published({ sha256: ZIP_SHA, version: 3 }),
    },
    { label: "no version", route: published({ sha256: ZIP_SHA }) },
    {
      label: "an upper-case hash",
      route: published({ sha256: ZIP_SHA.toUpperCase(), version: "0.3.0" }),
    },
    {
      label: "a 63-digit hash",
      route: published({ sha256: ZIP_SHA.slice(1), version: "0.3.0" }),
    },
    {
      label: "a 65-digit hash",
      route: published({ sha256: `${ZIP_SHA}0`, version: "0.3.0" }),
    },
    {
      label: "a hash with a non-hex digit",
      route: published({ sha256: `g${ZIP_SHA.slice(1)}`, version: "0.3.0" }),
    },
    {
      label: "a hash with a trailing newline",
      route: published({ sha256: `${ZIP_SHA}\n`, version: "0.3.0" }),
    },
    {
      label: "a hash with a filename after it",
      route: published({ sha256: `${ZIP_SHA}  Busy.zip`, version: "0.3.0" }),
    },
    { label: "no hash", route: published({ version: "0.3.0" }) },
    {
      label: "a null hash",
      route: published({ sha256: null, version: "0.3.0" }),
    },
    {
      installed: "0.3.0-dev",
      label: "a newer version over an unparseable installed one",
      route: published({ sha256: ZIP_SHA, version: "0.3.0" }),
    },
  ];

  it.each(quiet)("offers nothing for $label", async ({ route, installed }) => {
    await boot({
      routes: { [VERSION_URL]: route, [DOWNLOAD_URL]: () => new Response(ZIP) },
      version: installed,
    });
    await flush();
    expect(fake.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(fake.dialog.showErrorBox).not.toHaveBeenCalled();
    expect(fetched(DOWNLOAD_URL)).toBe(0);
  });

  it("accepts what the hub's release() publishes, even from an upper-case env value", async () => {
    const rel = hubRelease({
      BUSY_APP_SHA256: ` ${ZIP_SHA.toUpperCase()}\n`,
      BUSY_APP_VERSION: "0.3.0\n",
    });
    await boot({
      answer: 0,
      routes: {
        [VERSION_URL]: () => Response.json(rel),
        [DOWNLOAD_URL]: () => new Response(ZIP),
      },
    });
    await finished();
    expect(fake.dialog.showErrorBox).not.toHaveBeenCalled();
    expect(child.spawn).toHaveBeenCalledTimes(1);
  });

  it("ignores fields it doesn't know", async () => {
    await boot({
      routes: {
        [VERSION_URL]: published({
          channel: "beta",
          notes: "x",
          sha256: ZIP_SHA,
          version: "0.3.0",
        }),
      },
    });
    expect(fake.dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it("offers the update again at the next check after Later", async () => {
    await boot({ routes: offer() });
    await vi.advanceTimersByTimeAsync(SIX_HOURS);
    await flush();
    expect(fake.dialog.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when the hub can't be reached", async () => {
    await boot({
      routes: {
        [VERSION_URL]: () => Promise.reject(new TypeError("fetch failed")),
      },
    });
    await flush();
    expect(fake.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(fake.dialog.showErrorBox).not.toHaveBeenCalled();
  });

  it.each([
    { installed: "0.2.0", published: "0.2.1" },
    { installed: "0.9.0", published: "0.10.0" },
    { installed: "0.2.0", published: "1.0.0" },
    { installed: "1.9.9", published: "2.0.0" },
  ])(
    "offers $published over $installed, naming both",
    async ({ installed, published: v }) => {
      await boot({ routes: offer(v), version: installed });
      expect(fake.dialog.showMessageBox).toHaveBeenCalledTimes(1);
      expect(fake.dialog.showMessageBox.mock.calls[0]?.[0].detail).toContain(
        `Version ${v} (you have ${installed})`
      );
    }
  );

  it("makes Enter update and Escape postpone", async () => {
    await boot({ routes: offer() });
    const box = fake.dialog.showMessageBox.mock.calls[0]?.[0];
    expect(box.buttons[box.defaultId]).toBe("Update");
    expect(box.buttons[box.cancelId]).toBe("Later");
  });

  it("asks before downloading anything", async () => {
    await boot({ routes: offer() });
    expect(fetched(DOWNLOAD_URL)).toBe(0);
  });

  it.each([
    ["Later", 1],
    ["an unknown answer", 7],
  ])("downloads nothing when the user picks %s", async (_label, answer) => {
    await boot({ answer, routes: offer() });
    await flush();
    expect(fake.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(fetched(DOWNLOAD_URL)).toBe(0);
    expect(fake.app.quit).not.toHaveBeenCalled();
    expect(fake.dialog.showErrorBox).not.toHaveBeenCalled();
  });
});

describe("an accepted update that fails", () => {
  it.each([403, 404, 500, 503])(
    "reports a download answered with HTTP %i and keeps running",
    async (status) => {
      await boot({
        answer: 0,
        routes: {
          ...offer(),
          [DOWNLOAD_URL]: () => new Response("<html>error</html>", { status }),
        },
      });
      await finished();
      expect(errorText()).toContain(`HTTP ${status}`);
      expect(fake.app.quit).not.toHaveBeenCalled();
      expect(child.spawn).not.toHaveBeenCalled();
      expect(updateDirs()).toEqual([]);
    }
  );

  it("reports a download that can't connect", async () => {
    await boot({
      answer: 0,
      routes: {
        ...offer(),
        [DOWNLOAD_URL]: () =>
          Promise.reject(new TypeError("net::ERR_INTERNET_DISCONNECTED")),
      },
    });
    await finished();
    expect(errorText()).toContain("net::ERR_INTERNET_DISCONNECTED");
    expect(fake.app.quit).not.toHaveBeenCalled();
  });

  it("reports a download that drops halfway", async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(ZIP.slice(0, 100));
        c.error(new Error("socket hang up"));
      },
    });
    await boot({
      answer: 0,
      routes: { ...offer(), [DOWNLOAD_URL]: () => new Response(body) },
    });
    await finished();
    expect(fake.dialog.showErrorBox).toHaveBeenCalledTimes(1);
    expect(child.execFile).not.toHaveBeenCalled();
    expect(fake.app.quit).not.toHaveBeenCalled();
  });

  const flipped = ZIP.slice();
  const flippedIndex = Math.floor(ZIP.length / 2);
  const originalByte = present(flipped[flippedIndex]);
  flipped[flippedIndex] =
    originalByte % 2 === 0 ? originalByte + 1 : originalByte - 1;
  const tampered = [
    { bytes: flipped, label: "one flipped bit" },
    { bytes: ZIP.slice(0, -1), label: "the zip minus its last byte" },
    { bytes: new Uint8Array([...ZIP, 0]), label: "one extra byte appended" },
    { bytes: new Uint8Array(), label: "an empty body" },
    {
      bytes: new TextEncoder().encode("<!doctype html><h1>502</h1>"),
      label: "an HTML error page served as 200",
    },
    { bytes: OTHER_ZIP, label: "another valid release zip" },
    { bytes: new Uint8Array([...ZIP, ...ZIP]), label: "the zip twice" },
  ];

  it.each(tampered)(
    "refuses $label (SHA-256 mismatch) before writing anything",
    async ({ bytes }) => {
      await boot({
        answer: 0,
        routes: { ...offer(), [DOWNLOAD_URL]: () => new Response(bytes) },
      });
      await finished();
      expect(errorText()).toContain("SHA-256 mismatch");
      expect(updateDirs()).toEqual([]);
      expect(child.execFile).not.toHaveBeenCalled();
      expect(child.spawn).not.toHaveBeenCalled();
      expect(fake.app.quit).not.toHaveBeenCalled();
    }
  );

  it("refuses the genuine zip when the hub vouches for a different hash", async () => {
    await boot({ answer: 0, routes: offer("0.3.0", sha(OTHER_ZIP)) });
    await finished();
    expect(errorText()).toContain("SHA-256 mismatch");
    expect(child.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["a bare binary", "/usr/local/bin/busy", "/usr"],
    [
      "a binary three levels under a plain folder",
      "/opt/busy/bin/x/busy",
      "/opt/busy",
    ],
    [
      "a folder named like an app but not a bundle path",
      "/Users/x/Busy.application/a/b/busy",
      "/Users/x/Busy.application",
    ],
  ])(
    "refuses to replace anything when running from %s",
    async (_label, execPath, bundle) => {
      await boot({ answer: 0, execPath, routes: offer() });
      await finished();
      expect(errorText()).toContain(`Can't find the installed app (${bundle})`);
      expect(updateDirs()).toEqual([]);
      expect(child.spawn).not.toHaveBeenCalled();
    }
  );

  it("reports a zip ditto can't extract, and doesn't swap", async () => {
    await boot({
      answer: 0,
      execFile: (_f, _a, cb) =>
        cb(new Error("ditto: Couldn't read PKZip signature")),
      routes: offer(),
    });
    await finished();
    expect(errorText()).toContain("PKZip signature");
    expect(child.spawn).not.toHaveBeenCalled();
    expect(fake.app.quit).not.toHaveBeenCalled();
  });

  it("downloads from the hub BUSY_URL points at", async () => {
    const hub = "https://busy.localhost";
    await boot({
      answer: 0,
      hub,
      routes: {
        [`${hub}/api/download/version`]: published({
          sha256: ZIP_SHA,
          version: "0.3.0",
        }),
        [`${hub}/api/download`]: () => new Response(ZIP),
      },
    });
    await finished();
    expect(fake.net.fetch.mock.calls.map((c) => c[0])).toEqual([
      `${hub}/api/download/version`,
      `${hub}/api/download`,
    ]);
    expect(child.spawn).toHaveBeenCalledTimes(1);
  });

  it("shows a failure that isn't an Error as text", async () => {
    await boot({
      answer: 0,
      routes: {
        ...offer(),
        [DOWNLOAD_URL]: () => Promise.reject("ERR_TIMED_OUT"),
      },
    });
    await finished();
    expect(fake.dialog.showErrorBox.mock.calls[0]?.[1]).toBe("ERR_TIMED_OUT");
  });

  it("titles every failure the user sees the same way", async () => {
    await boot({
      answer: 0,
      routes: {
        ...offer(),
        [DOWNLOAD_URL]: () => new Response("", { status: 500 }),
      },
    });
    await finished();
    expect(fake.dialog.showErrorBox.mock.calls[0]?.[0]).toBe(
      "Couldn't update Busy"
    );
  });
});

describe("an accepted update that downloads the published zip", () => {
  beforeEach(async () => {
    await boot({ answer: 0, routes: offer() });
    await finished();
  });

  const spawnCall = () =>
    child.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
  const updateDir = () => {
    // biome-ignore lint/suspicious/noMisplacedAssertion: updateDir() validates the fixture before returning it
    expect(updateDirs()).toHaveLength(1);
    return join(root, present(updateDirs()[0]));
  };

  it("downloads only after the user said yes", () => {
    expect(fake.calls.indexOf(`fetch ${DOWNLOAD_URL}`)).toBeGreaterThan(
      fake.calls.indexOf("showMessageBox")
    );
  });

  it("writes exactly the downloaded bytes to a fresh busy-update- dir in the temp dir", () => {
    expect(new Uint8Array(readFileSync(join(updateDir(), "Busy.zip")))).toEqual(
      ZIP
    );
  });

  it("extracts it with ditto into that dir", () => {
    const dir = updateDir();
    expect(child.execFile.mock.calls[0]?.slice(0, 2)).toEqual([
      "/usr/bin/ditto",
      ["-x", "-k", join(dir, "Busy.zip"), join(dir, "new")],
    ]);
  });

  it("checks the extracted bundle is a complete Busy.app of the published version before quitting", () => {
    expect(child.execFile.mock.calls[1]?.slice(0, 2)).toEqual([
      "/bin/sh",
      [
        "-c",
        UPDATER_SCRIPT,
        "busy-update",
        "verify",
        join(updateDir(), "new", "Busy.app"),
        "0.3.0",
      ],
    ]);
  });

  it("hands the swap to a detached sh running the updater's copy outside the bundle", () => {
    const dir = updateDir();
    const state = join(root, "userData", "updater");
    const [cmd, args, opts] = spawnCall();
    expect(cmd).toBe("/bin/sh");
    expect(args).toEqual([
      join(state, UPDATER_FILE),
      "swap",
      String(process.pid),
      join(dir, "new", "Busy.app"),
      join(root, "Applications", "Busy.app"),
      dir,
      "0.3.0",
      state,
    ]);
    expect(readFileSync(join(state, UPDATER_FILE), "utf8")).toBe(
      UPDATER_SCRIPT
    );
    // Only this user can rewrite what runs on the next swap or recovery.
    expect(statSync(state).mode.toString(8).slice(-2)).toBe("00");
    expect(statSync(join(state, UPDATER_FILE)).mode.toString(8).slice(-2)).toBe(
      "00"
    );
    expect(opts).toMatchObject({ detached: true, stdio: "ignore" });
  });

  it("lets the app quit without waiting for the swap", () => {
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it("quits only after the swap is started, without an error", () => {
    expect(fake.calls.indexOf("quit")).toBeGreaterThan(
      fake.calls.indexOf("spawn")
    );
    expect(fake.dialog.showErrorBox).not.toHaveBeenCalled();
  });

  it("extracts before it swaps", () => {
    expect(fake.calls.indexOf("spawn")).toBeGreaterThan(
      fake.calls.indexOf("execFile")
    );
  });
});

describe("the bundle it replaces", () => {
  it.each([
    ["spaces and an apostrophe", ["My Apps", "Mati's Busy.app"]],
    ["accents and emoji", ["Café Apps ✨", "Busy.app"]],
    ["shell metacharacters", ["$(touch pwned) `id`", "Busy.app"]],
  ])(
    "passes a bundle path with %s through untouched",
    async (_label, parts) => {
      const bundle = join(os.tmpdir(), ...parts);
      await boot({
        answer: 0,
        execPath: join(bundle, "Contents", "MacOS", "Busy"),
        routes: offer(),
      });
      await finished();
      expect(child.spawn.mock.calls[0]?.[1][4]).toBe(bundle);
    }
  );

  it("normalizes a relative execPath segment to the real bundle", async () => {
    const bundle = join(os.tmpdir(), "Apps", "Busy.app");
    await boot({
      answer: 0,
      execPath: `${bundle}/Contents/Resources/../MacOS/Busy`,
      routes: offer(),
    });
    await finished();
    expect(child.spawn.mock.calls[0]?.[1][4]).toBe(bundle);
  });
});

const E2E = [
  { dir: "My Apps", label: "a folder with spaces" },
  { dir: "Café Apps ✨", label: "an accented, emoji folder" },
  {
    dir: `$(touch pwned) "q" 'a' \`touch pwned\``,
    inject: true,
    label: "a folder full of shell syntax",
  },
];

interface E2ERun {
  bundle: string;
  /** What the new build's startup recovery answered, after the swap. */
  confirmed: string | null;
  opened: string;
  root: string;
  siblingsAfterSwap: string[];
  status: number | null;
  stderr: string;
  swapped: boolean;
}

// Only ever the real ditto, or the real updater verifying, only ever inside this test's temp dir.
const realTools =
  (own: string): ExecFile =>
  (file, execArgs, cb) =>
    (file === "/usr/bin/ditto" &&
      execArgs.slice(2).every((a) => a.startsWith(own))) ||
    (file === "/bin/sh" &&
      execArgs[1] === UPDATER_SCRIPT &&
      (execArgs[3] === "verify" || execArgs[3] === "recover") &&
      present(execArgs[4]).startsWith(own))
      ? childProcess.execFile(file, execArgs, cb)
      : cb(new Error(`refused ${file} ${execArgs.join(" ")}`));

/** Runs the updater copy main.mjs spawned, as the detached sh would, with `prelude` shell functions first. */
function runSpawnedSwap(own: string, args: string[], prelude = "") {
  // biome-ignore lint/suspicious/noMisplacedAssertion: validates the generated subprocess command
  expect(args[2]).toBe(String(process.pid));
  // The app (this test process) can't quit, so hand the script a pid that is already gone.
  const gone = String(childProcess.spawnSync("true").pid);
  const bin = join(own, "bin");
  if (!existsSync(bin)) {
    toolsBin(bin);
  }
  // `open` is a shell function: nothing launches, and PATH can't reach the real one.
  return childProcess.spawnSync(
    "/bin/sh",
    [
      "-c",
      `open() { printf '%s\\0' "$1" >> "$OPENED"; }\n${prelude}\n${withPerlHook(readFileSync(present(args[0]), "utf8"))}`,
      "busy-update",
      "swap",
      gone,
      ...args.slice(3),
    ],
    {
      cwd: own,
      encoding: "utf8",
      env: { OPENED: join(own, "opened"), PATH: bin },
      timeout: 10_000,
    }
  );
}

/** Installed bundle in root/<dir>, the update served from `zip`; real ditto extraction, then the real swap. */
async function endToEnd(
  dir: string,
  zip: Uint8Array<ArrayBuffer>
): Promise<E2ERun> {
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
  });
  root = mkdtempSync(join(os.tmpdir(), "busy-main-update-e2e-"));
  const own = root;
  const bundle = join(own, dir, "Busy.app");
  makeBundle(bundle, { build: "build 0.2.0", version: "0.2.0" });
  writeFileSync(join(bundle, "Contents", "stale-0.2.0-only"), "x");
  await boot({
    answer: 0,
    execFile: realTools(own),
    execPath: join(bundle, "Contents", "MacOS", "Busy"),
    routes: {
      [VERSION_URL]: published({ sha256: sha(zip), version: "0.3.0" }),
      [DOWNLOAD_URL]: () => new Response(zip),
    },
  });
  await finished();
  process.execPath = savedExecPath;
  vi.useRealTimers();
  const opened = join(own, "opened");
  const call = child.spawn.mock.calls.at(-1) as unknown as
    | [string, string[]]
    | undefined;
  if (!call) {
    return {
      bundle,
      confirmed: null,
      opened,
      root: own,
      siblingsAfterSwap: readdirSync(join(own, dir)),
      status: null,
      stderr: "",
      swapped: false,
    };
  }
  const r = runSpawnedSwap(own, call[1]);
  const siblingsAfterSwap = readdirSync(join(own, dir)).sort();
  // The new build starts: its startup recovery confirms the update (the bundled script, the running bundle).
  const confirmed = childProcess.spawnSync(
    "/bin/sh",
    [
      "-c",
      UPDATER_SCRIPT,
      "busy-update",
      "recover",
      join(own, "userData", "updater"),
      bundle,
      "0.3.0",
    ],
    { encoding: "utf8" }
  ).stdout;
  return {
    bundle,
    confirmed,
    opened,
    root: own,
    siblingsAfterSwap,
    status: r.status,
    stderr: r.stderr,
    swapped: true,
  };
}

describe.each(E2E)(
  "end to end, installed in $label: real zip, real ditto, real swap",
  ({ dir, inject }) => {
    let e: E2ERun;

    beforeAll(async () => {
      e = await endToEnd(dir, ZIP);
    });
    afterAll(() => rmSync(e.root, { force: true, recursive: true }));

    test("installs the zip's contents in place of the running bundle", () => {
      expect(e.stderr).toBe("");
      expect(
        readFileSync(join(e.bundle, "Contents", "MacOS", "Busy"), "utf8")
      ).toBe("build 0.3.0");
      expect(
        readFileSync(join(e.bundle, "Contents", "Info.plist"), "utf8")
      ).toBe(infoPlist({ version: "0.3.0" }));
    });

    test("drops files only the old version had", () => {
      expect(existsSync(join(e.bundle, "Contents", "stale-0.2.0-only"))).toBe(
        false
      );
    });

    test("relaunches the bundle at the path it was running from", () => {
      expect(readFileSync(e.opened, "utf8")).toBe(`${e.bundle}\0`);
    });

    test("removes the download dir and keeps the previous build only until the new one confirms", () => {
      expect(
        readdirSync(e.root).filter((n) => n.startsWith("busy-update-"))
      ).toEqual([]);
      expect(e.siblingsAfterSwap).toEqual(["Busy.app", "Busy.app.old"]);
      expect(e.confirmed).toBe("installed\n");
      expect(readdirSync(join(e.root, dir))).toEqual(["Busy.app"]);
    });

    if (inject) {
      test("runs nothing embedded in the path", () => {
        expect(existsSync(join(e.root, "pwned"))).toBe(false);
      });
    }
  }
);

describe.each([
  {
    label: "has no Busy.app inside",
    zip: () => buildZip("no-app", { "README.txt": "not an app" }, "README.txt"),
  },
  {
    label: "has a Busy.app without Info.plist",
    zip: () =>
      buildZip(
        "no-plist",
        { "Contents/MacOS/Busy": "build 0.3.0" },
        "Busy.app"
      ),
  },
  {
    label: "has a Busy.app of another version",
    zip: () => OTHER_ZIP,
  },
])("end to end, when a zip with the published hash $label", ({ zip }) => {
  let e: E2ERun;
  let errors: string;
  let quit: number;
  beforeAll(async () => {
    const bytes = zip();
    e = await endToEnd("Applications", bytes);
    errors = errorText();
    quit = fake.app.quit.mock.calls.length;
  });
  afterAll(() => rmSync(e.root, { force: true, recursive: true }));

  test("tells the user before quitting, and keeps running", () => {
    expect(errors).toContain("doesn't contain a complete Busy.app 0.3.0");
    expect(quit).toBe(0);
  });

  test("never starts the swap, keeps the installed build and removes the download", () => {
    expect(e.swapped).toBe(false);
    expect(
      readFileSync(join(e.bundle, "Contents", "MacOS", "Busy"), "utf8")
    ).toBe("build 0.2.0");
    expect(existsSync(join(e.bundle, "Contents", "stale-0.2.0-only"))).toBe(
      true
    );
    expect(readdirSync(join(e.root, "Applications"))).toEqual(["Busy.app"]);
    expect(
      readdirSync(e.root).filter((n) => n.startsWith("busy-update-"))
    ).toEqual([]);
  });
});

describe("end to end, when the published zip can't be extracted", () => {
  let e: E2ERun;
  let errors: string;
  let quit: number;
  beforeAll(async () => {
    e = await endToEnd(
      "Applications",
      new Uint8Array([
        0x50,
        0x4b,
        0x03,
        0x04,
        ...new TextEncoder().encode("not really a zip"),
      ])
    );
    errors = errorText();
    quit = fake.app.quit.mock.calls.length;
  });
  afterAll(() => rmSync(e.root, { force: true, recursive: true }));

  it("tells the user, and keeps running", () => {
    expect(errors).toContain("ditto");
    expect(quit).toBe(0);
  });

  it("never starts the swap, so the installed app is untouched", () => {
    expect(e.swapped).toBe(false);
    expect(
      readFileSync(join(e.bundle, "Contents", "MacOS", "Busy"), "utf8")
    ).toBe("build 0.2.0");
  });
});

describe("at startup, with an update journal left behind", () => {
  const journal = () => join(root, "userData", "updater", "journal");
  const withJournal = () => {
    mkdirSync(join(root, "userData", "updater"), { recursive: true });
    writeFileSync(journal(), "left behind");
  };
  const recoverCalls = () =>
    child.execFile.mock.calls.filter((c) => c[1][3] === "recover");

  it("does nothing without a journal", async () => {
    await boot();
    expect(recoverCalls()).toEqual([]);
    expect(fetched(VERSION_URL)).toBe(1);
  });

  it("never runs from an unpackaged dev build", async () => {
    withJournal();
    await boot({ packaged: false });
    expect(recoverCalls()).toEqual([]);
  });

  it("settles it with the running bundle and version before checking for updates", async () => {
    withJournal();
    await boot({ version: "0.3.0" });
    expect(recoverCalls().map((c) => c.slice(0, 2))).toEqual([
      [
        "/bin/sh",
        [
          "-c",
          UPDATER_SCRIPT,
          "busy-update",
          "recover",
          join(root, "userData", "updater"),
          join(root, "Applications", "Busy.app"),
          "0.3.0",
        ],
      ],
    ]);
    expect(fake.calls.indexOf("execFile")).toBeLessThan(
      fake.calls.indexOf(`fetch ${VERSION_URL}`)
    );
  });

  it("says nothing when the update was installed", async () => {
    withJournal();
    await boot({
      execFile: (_f, _a, cb) => cb(null, "installed\n", ""),
      version: "0.3.0",
    });
    expect(fake.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("tells the user when the previous update didn't finish", async () => {
    withJournal();
    await boot({
      execFile: (_f, _a, cb) =>
        cb(
          null,
          "failed\nCouldn't move the update into place. Busy kept the previous version.\n",
          ""
        ),
    });
    expect(fake.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(fake.dialog.showMessageBox.mock.calls[0]?.[0]).toMatchObject({
      detail:
        "Couldn't move the update into place. Busy kept the previous version. You have version 0.2.0.",
      message: "Busy couldn't finish updating",
      type: "warning",
    });
  });

  it("still checks for updates when the recovery itself fails", async () => {
    withJournal();
    await boot({ execFile: (_f, _a, cb) => cb(new Error("sh: boom")) });
    expect(fetched(VERSION_URL)).toBe(1);
  });
});

describe("end to end, when the swap is SIGKILLed", () => {
  // Interrupts the real spawned updater right after a given rename, then lets recovery run.
  async function killed(prelude: string) {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    root = mkdtempSync(join(os.tmpdir(), "busy-main-update-kill-"));
    const own = root;
    const bundle = join(own, "Applications", "Busy.app");
    makeBundle(bundle, { build: "build 0.2.0", version: "0.2.0" });
    await boot({
      answer: 0,
      execFile: realTools(own),
      execPath: join(bundle, "Contents", "MacOS", "Busy"),
      routes: offer(),
    });
    await finished();
    vi.useRealTimers();
    const [, args] = child.spawn.mock.calls.at(-1) as unknown as [
      string,
      string[],
    ];
    const r = runSpawnedSwap(own, args, prelude);
    return { args, bundle, own, r };
  }

  it("right after the exchange, the new build's first start completes it and drops the backup", async ({
    skip,
  }) => {
    skip(
      !exchangeAvailable(),
      "renameatx_np RENAME_SWAP is unavailable here; the two-rename case below still runs"
    );
    const k = await killed(
      `perl() { command perl "$@" || return 1; kill -KILL $$; }`
    );
    expect(k.r.signal).toBe("SIGKILL");
    // The exchange left the new build installed and the previous one at .new: no gap at any point.
    expect(
      readFileSync(join(k.bundle, "Contents", "MacOS", "Busy"), "utf8")
    ).toBe("build 0.3.0");
    // The new build starts (packaged 0.3.0, same bundle) and its recovery runs the real script.
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    await boot({
      execFile: realTools(k.own),
      execPath: join(k.bundle, "Contents", "MacOS", "Busy"),
      version: "0.3.0",
    });
    await vi.waitFor(
      () =>
        expect(readdirSync(join(k.own, "Applications"))).toEqual(["Busy.app"]),
      { interval: 5, timeout: 5000 }
    );
    expect(fake.dialog.showMessageBox).not.toHaveBeenCalled();
    rmSync(k.own, { force: true, recursive: true });
  });

  it("between the two renames (no exchange), the updater copy outside the bundle restores an app with Busy.app gone", async () => {
    // No exchange; killed right after `mv "$APP" "$APP.old"`.
    const k = await killed(
      `perl() { return 1; }\nmv() { command mv "$@" || return 1; [ "$1" != "$APP" ] || kill -KILL $$; }`
    );
    expect(k.r.signal).toBe("SIGKILL");
    // The installed path is empty: Busy.app can't start, so recovery can't come from it.
    expect(existsSync(k.bundle)).toBe(false);
    const state = present(k.args[7]);
    const helper = present(k.args[0]);
    expect(helper.startsWith(join(k.own, "userData"))).toBe(true);
    const out = childProcess.spawnSync("/bin/sh", [helper, "recover", state], {
      encoding: "utf8",
      env: { PATH: join(k.own, "bin") },
    });
    expect(out.stdout).toBe("staged\n");
    expect(
      readFileSync(join(k.bundle, "Contents", "MacOS", "Busy"), "utf8")
    ).toBe("build 0.3.0");
    // The backup is kept until the new build confirms.
    expect(
      readFileSync(join(`${k.bundle}.old`, "Contents", "MacOS", "Busy"), "utf8")
    ).toBe("build 0.2.0");
    rmSync(k.own, { force: true, recursive: true });
  });
});
