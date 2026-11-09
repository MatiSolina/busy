import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import config from "./config.json" with { type: "json" };
import { computerOwner } from "./lib/lifecycle";
import selector from "./sandbox";
import { defined } from "./test-utils";

vi.hoisted(() => {
  process.env.BOT_BASE_IMAGE = `vcr.vercel.com/test-team/test-project/bot-base@sha256:${"0".repeat(64)}`;
});

const TEAM_RE = /^[a-z][a-z0-9-]{0,15}$/u;
const BOT_RE = /^[a-z0-9-]{1,20}$/u;
const PUSH_NAME_RE = /name=(?<name>[^:,"\s]+):\$1/u;
const IMAGE_RE = /^sha256:[a-f0-9]{64}$/u;
const IMAGE_ERROR_RE = /agent-desktop: command not found/u;

// @vercel/sandbox's Drive and eve's Vercel environment talk to Vercel: stand-ins that record what
// the selector asks for. eve's durable state only exists inside a step: a Map here (as in
// hooks/suspend.test.ts), so lib/lifecycle.ts runs for real.
const h = vi.hoisted(() => ({
  environment: undefined as
    | undefined
    | {
        region: string;
        image: string;
        prepare: (sandbox: unknown) => Promise<void>;
      },
  getOrCreate: undefined as unknown as Mock<
    (arg: { name: string; region: string }) => Promise<unknown>
  >,
  // What the opened computer's /etc/busy-image-version holds (null: no marker).
  marker: "9" as string | null | Error,
  open: undefined as unknown as Mock<(...args: unknown[]) => Promise<unknown>>,
  snapshot: undefined as unknown as Mock<() => Promise<unknown>>,
  states: new Map<string, unknown>(),
}));
vi.mock("eve/context", () => ({
  defineState: (name: string, init: () => unknown) => ({
    get: () => (h.states.has(name) ? h.states.get(name) : init()),
    update: (fn: (v: unknown) => unknown) =>
      h.states.set(name, fn(h.states.has(name) ? h.states.get(name) : init())),
  }),
}));
vi.mock("eve/sandbox/vercel", () => ({
  VercelSandbox: {
    environment: (cfg: NonNullable<typeof h.environment>) => {
      h.environment = cfg;
      return { open: (...args: unknown[]) => h.open(...args) };
    },
  },
}));
vi.mock("@vercel/sandbox", () => ({
  Drive: {
    getOrCreate: (arg: { name: string; region: string }) => h.getOrCreate(arg),
  },
}));

const DRIVE = `busy-${config.slug}`;
const SNAPSHOT = { drive: DRIVE, mode: "snapshot" };
// Only what the selector may touch on an opened computer: reading the image marker.
const COMPUTER = {
  id: "sbx_1",
  readTextFile: vi.fn(({ path }: { path: string }) => {
    if (path !== "/etc/busy-image-version") {
      return Promise.resolve(null);
    }
    return h.marker instanceof Error
      ? Promise.reject(h.marker)
      : Promise.resolve(h.marker === null ? null : `${h.marker}\n`);
  }),
};
const MINUTES_45 = 45 * 60 * 1000;

const open = selector as unknown as (ctx: unknown) => Promise<unknown>;
const session = (id: string, principalId: string | null) => ({
  session: {
    auth: {
      current:
        principalId === null ? null : { principalId, principalType: "service" },
      initiator: null,
    },
    id,
  },
});
const bot = (team: string, project: string) =>
  `https://oidc.vercel.com/${team}:owner:${team}:project:${project}:environment:production`;
const opened = () =>
  defined(h.open.mock.calls[0])[0] as {
    mounts: Record<string, unknown>;
    networkPolicy?: string;
    timeout: number;
  };

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.states.clear();
  h.marker = "9";
  COMPUTER.readTextFile.mockClear();
  h.snapshot = vi.fn(async () => SNAPSHOT);
  h.getOrCreate = vi.fn(async ({ name }: { name: string }) => ({
    name,
    snapshot: h.snapshot,
  }));
  h.open = vi.fn(async () => COMPUTER);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {
    // Deliberate no-op: suppress expected warning output in this test.
  });
  return () => warn.mockRestore();
});

describe("the computer each session gets", () => {
  const writer = {
    mounts: { "/data": { drive: DRIVE, mode: "read-write" } },
    timeout: MINUTES_45,
  };
  const reader = {
    mounts: { "/data": SNAPSHOT },
    networkPolicy: "deny-all",
    timeout: MINUTES_45,
  };

  it.each<[string, string | null, object, number]>([
    ["The user's chat, through the hub", "busy-hub:hub", writer, 0],
    ["an unprotected local session", null, writer, 0],
    ["the local dev server", "local-dev", writer, 0],
    ["eve's own app (schedules)", "eve:app", writer, 0],
    ["a bot of the same team", bot("mati-solina", "bot-lawyer"), reader, 1],
    ["a bot of another team", bot("acme", "bot-ventas"), reader, 1],
  ])("for %s", async (_, principalId, expected, snapshots) => {
    expect(await open(session("s1", principalId))).toBe(COMPUTER);
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(opened()).toStrictEqual(expected);
    expect(h.snapshot).toHaveBeenCalledTimes(snapshots);
  });

  it("mounts this bot's own Drive, in the computer's region", async () => {
    await open(session("s1", "busy-hub:hub"));
    expect(h.getOrCreate).toHaveBeenCalledWith({
      name: DRIVE,
      region: defined(h.environment).region,
    });
  });

  it("snapshots the same Drive the chat writes to", async () => {
    await open(session("chat", "busy-hub:hub"));
    await open(session("q1", bot("mati-solina", "bot-lawyer")));
    expect(
      h.getOrCreate.mock.calls.map(([arg]) => (arg as { name: string }).name)
    ).toEqual([DRIVE, DRIVE]);
    expect((opened().mounts["/data"] as { drive: string }).drive).toBe(DRIVE);
  });

  it("never gives a consultation a writable /data or the network, for any bot", async () => {
    const team = fc.stringMatching(TEAM_RE);
    await fc.assert(
      fc.asyncProperty(team, fc.stringMatching(BOT_RE), async (t, slug) => {
        h.open.mockClear();
        await open(session("q", bot(t, `bot-${slug}`)));
        expect(opened().networkPolicy).toBe("deny-all");
        expect(opened().mounts["/data"]).toBe(SNAPSHOT);
      }),
      { numRuns: 50, seed: 1 }
    );
  });

  // A Drive snapshot only sees what the chat's computer published when it last stopped: each
  // consultation takes its own, so a later one sees later work.
  it("takes a new snapshot for every consultation", async () => {
    h.snapshot
      .mockResolvedValueOnce({ at: 1, drive: DRIVE, mode: "snapshot" })
      .mockResolvedValueOnce({ at: 2, drive: DRIVE, mode: "snapshot" });
    await open(session("q1", bot("mati-solina", "bot-lawyer")));
    await open(session("q2", bot("mati-solina", "bot-lawyer")));
    expect(h.snapshot).toHaveBeenCalledTimes(2);
    expect(
      h.open.mock.calls.map(
        ([arg]) =>
          defined(
            (arg as { mounts: Record<string, { at: number }> }).mounts["/data"]
          ).at
      )
    ).toEqual([1, 2]);
  });

  it("gives the chat a fresh mount object each time, never the snapshot", async () => {
    await open(session("chat", "busy-hub:hub"));
    const first = opened().mounts["/data"];
    h.open.mockClear();
    await open(session("chat", "busy-hub:hub"));
    expect(opened().mounts["/data"]).toEqual(first);
    expect(opened().mounts["/data"]).not.toBe(SNAPSHOT);
  });
});

describe("who owns the computer", () => {
  it.each([
    ["the chat", "chat", "busy-hub:hub"],
    ["a consultation", "q1", bot("mati-solina", "bot-lawyer")],
  ])("records %s as the owner once it is open", async (_, id, principalId) => {
    expect(computerOwner()).toBeNull();
    await open(session(id, principalId));
    expect(computerOwner()).toBe(id);
  });

  it("records nothing when the computer fails to open (the suspend hook would wake one up)", async () => {
    h.open.mockRejectedValueOnce(new Error("quota"));
    await expect(open(session("chat", "busy-hub:hub"))).rejects.toThrow(
      "quota"
    );
    expect(computerOwner()).toBeNull();
  });

  it("opens nothing when the Drive can't be reached", async () => {
    h.getOrCreate.mockRejectedValueOnce(new Error("drive down"));
    await expect(open(session("chat", "busy-hub:hub"))).rejects.toThrow(
      "drive down"
    );
    expect(h.open).not.toHaveBeenCalled();
    expect(computerOwner()).toBeNull();
  });

  it("opens nothing for a consultation whose snapshot fails, rather than mounting the live Drive", async () => {
    h.snapshot.mockRejectedValueOnce(new Error("snapshot failed"));
    await expect(
      open(session("q1", bot("mati-solina", "bot-lawyer")))
    ).rejects.toThrow("snapshot failed");
    expect(h.open).not.toHaveBeenCalled();
  });
});

// --- the image ---------------------------------------------------------------------------------

const PUSH = readFileSync(
  new URL("../../../images/bot-base/push.sh", import.meta.url),
  "utf8"
);

describe("the bot base image", () => {
  it("is the repository push.sh publishes", () => {
    const pushed = PUSH_NAME_RE.exec(PUSH)?.groups?.name;
    expect(pushed).toBeDefined();
    expect(PUSH).toContain("BOT_BASE_IMAGE_REPOSITORY");
    expect(defined(h.environment).image.split("@")[0]).toBe(
      process.env.BOT_BASE_IMAGE?.split("@")[0]
    );
  });

  it("pins the published manifest rather than a mutable tag", () => {
    expect(defined(h.environment).image.split("@")[1]).toMatch(IMAGE_RE);
  });
});

describe("prepare: checking the image at build time", () => {
  const prepare = (run: (arg: { command: string }) => Promise<unknown>) =>
    defined(h.environment).prepare({ run });

  it("passes when the check exits 0", async () => {
    await expect(
      prepare(async () => ({
        exitCode: 0,
        stderr: "",
        stdout: "agent-desktop 1.0.2\nagent-browser 0.41.1",
      }))
    ).resolves.toBeUndefined();
  });

  it("fails the build with the check's stderr", async () => {
    const run = async () => ({
      exitCode: 127,
      stderr: "agent-desktop: command not found",
      stdout: "",
    });
    await expect(prepare(run)).rejects.toThrow(IMAGE_ERROR_RE);
  });

  it("fails the build when the check can't run at all", async () => {
    await expect(
      prepare(async () => Promise.reject(new Error("sandbox gone")))
    ).rejects.toThrow("sandbox gone");
  });

  it("runs a single check command", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "" }));
    await prepare(run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  // The check itself, run with bash against a stub agent-desktop. Its one absolute path (where the
  // image installs `desktop`) is rewritten into a temp dir, so nothing outside it is looked at.
  describe("the check command", () => {
    let dir = "";
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "prepare-"));
      writeFileSync(
        join(dir, "agent-desktop"),
        // biome-ignore lint/suspicious/noTemplateCurlyInString: This fixture verifies a shell placeholder is preserved literally.
        '#!/bin/sh\n[ "$1" = version ] || exit 2\nprintf "agent-desktop 1.0.2\\n"\nexit "${AD_EXIT:-0}"\n',
        { mode: 0o755 }
      );
      writeFileSync(
        join(dir, "browser"),
        '#!/bin/sh\n[ "$1" = --version ] || exit 2\nprintf "agent-browser 0.41.1\\n"\n',
        { mode: 0o755 }
      );
    });
    afterAll(() => {
      if (dir) {
        rmSync(dir, { force: true, recursive: true });
      }
    });

    let command = "";
    const check = async (setup: {
      agentDesktop: boolean;
      browser?: "executable" | "missing";
      desktopBrowser?: "executable" | "missing";
      desktopControl?: "executable" | "missing";
      desktop: "executable" | "plain" | "missing";
      live?: "executable" | "missing";
      session?: "executable" | "missing";
      a11y?: "executable" | "missing";
      exit?: number;
      marker?: string | null;
    }) => {
      if (!command) {
        await defined(h.environment).prepare({
          run: async ({ command: c }: { command: string }) => {
            await Promise.resolve();
            command = c;
            return { exitCode: 0, stderr: "", stdout: "" };
          },
        });
      }
      const desktop = join(dir, "desktop");
      rmSync(desktop, { force: true });
      if (setup.desktop !== "missing") {
        writeFileSync(desktop, "#!/bin/sh\n", {
          mode: setup.desktop === "executable" ? 0o755 : 0o644,
        });
      }
      if (setup.desktop === "plain") {
        chmodSync(desktop, 0o644);
      }
      const browser = join(dir, "browser");
      if (setup.browser === "missing") {
        rmSync(browser, { force: true });
      } else {
        writeFileSync(
          browser,
          '#!/bin/sh\n[ "$1" = --version ] || exit 2\nprintf "agent-browser 0.41.1\\n"\n',
          { mode: 0o755 }
        );
      }
      const desktopBrowser = join(dir, "desktop-browser");
      rmSync(desktopBrowser, { force: true });
      if (setup.desktopBrowser !== "missing") {
        writeFileSync(desktopBrowser, "#!/bin/sh\n", { mode: 0o755 });
      }
      const desktopControl = join(dir, "desktop-control");
      rmSync(desktopControl, { force: true });
      if (setup.desktopControl !== "missing") {
        writeFileSync(desktopControl, "#!/bin/sh\n", { mode: 0o755 });
      }
      const live = join(dir, "desktop-live");
      rmSync(live, { force: true });
      if (setup.live !== "missing") {
        writeFileSync(live, "#!/bin/sh\n", { mode: 0o755 });
      }
      const sessionPath = join(dir, "desktop-session");
      rmSync(sessionPath, { force: true });
      if (setup.session !== "missing") {
        writeFileSync(sessionPath, "#!/bin/sh\n", { mode: 0o755 });
      }
      const a11y = join(dir, "desktop-a11y");
      rmSync(a11y, { force: true });
      if (setup.a11y !== "missing") {
        writeFileSync(a11y, "#!/bin/sh\n", { mode: 0o755 });
      }
      const marker = join(dir, "busy-image-version");
      rmSync(marker, { force: true });
      if (setup.marker !== undefined && setup.marker !== null) {
        writeFileSync(marker, `${setup.marker}\n`);
      }
      const paths = (command.match(/\/[\w./-]+/gu) ?? []).filter(
        (path) => path !== "/dev/null" && path !== "/etc/busy-image-version"
      );
      // biome-ignore lint/suspicious/noMisplacedAssertion: This helper is called only from the surrounding test cases.
      expect(command.split("/etc/busy-image-version")).toHaveLength(3);
      // biome-ignore lint/suspicious/noMisplacedAssertion: This helper is called only from the surrounding test cases.
      expect(paths).toEqual([
        "/usr/local/bin/browser",
        "/usr/local/bin/desktop-browser",
        "/usr/local/bin/desktop-control",
        "/usr/local/bin/desktop",
        "/usr/local/bin/desktop-live",
        "/usr/local/bin/desktop-session",
        "/usr/local/bin/desktop-a11y",
      ]);
      const local = command
        .replaceAll("/usr/local/bin/browser", browser)
        .replaceAll("/usr/local/bin/desktop-browser", desktopBrowser)
        .replaceAll("/usr/local/bin/desktop-control", desktopControl)
        .replaceAll("/usr/local/bin/desktop-live", live)
        .replaceAll("/usr/local/bin/desktop-session", sessionPath)
        .replaceAll("/usr/local/bin/desktop-a11y", a11y)
        .replaceAll("/usr/local/bin/desktop", desktop)
        .replaceAll("/etc/busy-image-version", marker);
      const PATH = setup.agentDesktop
        ? `${dir}:/usr/bin:/bin`
        : "/usr/bin:/bin";
      return spawnSync("/bin/bash", ["-c", local], {
        env: { AD_EXIT: String(setup.exit ?? 0), PATH },
      }).status;
    };

    it.each<[string, Parameters<typeof check>[0], boolean]>([
      [
        "agent-desktop and an executable desktop",
        { agentDesktop: true, desktop: "executable" },
        true,
      ],
      [
        "no browser wrapper",
        { agentDesktop: true, browser: "missing", desktop: "executable" },
        false,
      ],
      [
        "no desktop-browser wrapper",
        {
          agentDesktop: true,
          desktop: "executable",
          desktopBrowser: "missing",
        },
        false,
      ],
      [
        "no desktop-control wrapper",
        {
          agentDesktop: true,
          desktop: "executable",
          desktopControl: "missing",
        },
        false,
      ],
      [
        "no agent-desktop",
        { agentDesktop: false, desktop: "executable" },
        false,
      ],
      [
        "an agent-desktop that fails",
        { agentDesktop: true, desktop: "executable", exit: 1 },
        false,
      ],
      ["no desktop command", { agentDesktop: true, desktop: "missing" }, false],
      [
        "a desktop that isn't executable",
        { agentDesktop: true, desktop: "plain" },
        false,
      ],
      [
        "no desktop-live (an image from before the live screen)",
        { agentDesktop: true, desktop: "executable", live: "missing" },
        false,
      ],
      [
        "no desktop-session (an image without the desktop)",
        { agentDesktop: true, desktop: "executable", session: "missing" },
        false,
      ],
      [
        "no desktop-a11y (an image where a key press crashes Chrome)",
        { a11y: "missing", agentDesktop: true, desktop: "executable" },
        false,
      ],
      [
        "the image marker this code expects",
        { agentDesktop: true, desktop: "executable", marker: "9" },
        true,
      ],
      [
        "another image's marker (digest and BOT_BASE_IMAGE_VERSION bumped apart)",
        { agentDesktop: true, desktop: "executable", marker: "10" },
        false,
      ],
      [
        "no marker (the pinned image predates it)",
        { agentDesktop: true, desktop: "executable", marker: null },
        true,
      ],
    ])(
      "with %s, passes=%s",
      async (_, setup, passes) => {
        expect((await check(setup)) === 0).toBe(passes);
      },
      15_000
    );
  });
});

// --- the image under an opened computer (H-19) -------------------------------------------------

describe("the computer's image after it opens", () => {
  const image = () =>
    h.states.get("busy.computer-image") as
      | { status: string; found: string | null; expected: string }
      | undefined;

  it("records a computer from the expected image as current, without warning", async () => {
    expect(await open(session("chat", "busy-hub:hub"))).toBe(COMPUTER);
    expect(COMPUTER.readTextFile).toHaveBeenCalledWith({
      path: "/etc/busy-image-version",
    });
    expect(image()).toMatchObject({
      expected: "9",
      found: "9",
      status: "current",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a resumed computer from an older image as stale, and still opens it untouched", async () => {
    h.marker = "8";
    expect(await open(session("chat", "busy-hub:hub"))).toBe(COMPUTER);
    expect(image()).toMatchObject({ found: "8", status: "stale" });
    expect(warn).toHaveBeenCalledWith(
      "computer-image: this session's computer comes from another bot image",
      expect.objectContaining({ expected: "9", found: "8", status: "stale" })
    );
  });

  it("reports a computer without a marker as unknown", async () => {
    h.marker = null;
    expect(await open(session("chat", "busy-hub:hub"))).toBe(COMPUTER);
    expect(image()).toMatchObject({ found: null, status: "unknown" });
  });

  it("opens the computer even when the marker can't be read", async () => {
    h.marker = new Error("sandbox busy");
    expect(await open(session("chat", "busy-hub:hub"))).toBe(COMPUTER);
    expect(image()).toMatchObject({ status: "unknown" });
  });
});
