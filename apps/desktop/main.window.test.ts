// main.mjs window lifecycle against the in-memory electron (fake-electron.ts): failed loads, renderer crashes and
// hangs (N-02), the ChatGPT IPC across a restart, and which origin BUSY_URL makes the window, the IPC and the
// OAuth callback trust (N-07). The fake does not load pages: each test emits the webContents events itself.
import { request } from "node:http";
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

const PRODUCTION = "https://app.busybot.dev";
const ERR_INTERNET_DISCONNECTED = -106;
const ERR_ABORTED = -3;
const LOOPBACK_CALLBACK_RE = /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/u;

let fake: FakeElectron;
const savedEnv = process.env.BUSY_URL;

async function boot(hub?: string) {
  fake = fakeElectron({ packaged: false });
  if (hub === undefined) {
    delete process.env.BUSY_URL;
  } else {
    process.env.BUSY_URL = hub;
  }
  vi.resetModules();
  vi.doMock("electron", () => fake.module);
  await import("./main.mjs");
  fake.ready();
  await flush();
  return fake;
}

const win = () => {
  const [window] = fake.windows;
  if (!window) {
    throw new Error("Expected a fake window");
  }
  return window;
};
const wc = () => win().webContents;
const loads = () => win().loadURL.mock.calls.map(([url]) => url);
const hubLoads = () => loads().filter((u) => !u.startsWith("data:"));
const recoveryLoads = () => loads().filter((u) => u.startsWith("data:"));
const recoveryText = () =>
  decodeURIComponent(recoveryLoads().at(-1)?.split(",")[1] ?? "");

const emitFail = (url: string, code: number, main: boolean) =>
  wc().emit("did-fail-load", {}, code, "net error", url, main);
/**
 * A failed main-frame load the way Electron 45 reports it (checked against the real binary): did-fail-load, then
 * did-finish-load for the error page while getURL() still says the hub URL, then the recovery page finishing.
 */
const failLoad = (url: string) => {
  emitFail(url, ERR_INTERNET_DISCONNECTED, true);
  const next = wc().mainFrame;
  wc().mainFrame = { url };
  wc().emit("did-finish-load");
  wc().mainFrame = next;
  wc().emit("did-finish-load");
};
const finishLoad = () => wc().emit("did-finish-load");
/** A crashed renderer; the next load gets a new main frame (WebFrameMain) object. */
const crash = (reason = "crashed") => {
  wc().mainFrame = { url: wc().mainFrame.url };
  wc().emit("render-process-gone", {}, { exitCode: 1, reason });
};

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handler = (channel: string) => {
  const call = fake.ipcMain.handle.mock.calls.find(([c]) => c === channel);
  if (!call) {
    throw new Error(`No handler for ${channel}`);
  }
  return call[1] as Handler;
};
/** An IPC event from the window's current main frame (override any part). */
const ipcEvent = (over: Record<string, unknown> = {}) => ({
  sender: wc(),
  senderFrame: wc().mainFrame,
  ...over,
});
const prepare = (event = ipcEvent()) =>
  handler("busy:ai:chatgpt:prepare")(event) as Promise<{ redirectUri: string }>;
const attempt = (redirectUri: string, state: string) => ({
  attemptId: `attempt-${state}`,
  expiresAt: Date.now() + 60_000,
  kind: "browser",
  provider: "chatgpt",
  url: `https://auth.openai.com/api/accounts/authorize?${new URLSearchParams({
    redirect_uri: redirectUri,
    state,
  })}`,
});
const open = (redirectUri: string, state: string, event = ipcEvent()) =>
  handler("busy:ai:chatgpt:open")(event, attempt(redirectUri, state));

/** GETs the loopback callback the way the browser would after ChatGPT sign-in. */
function callback(redirectUri: string, state: string) {
  return new Promise<number>((resolve) => {
    const req = request(`${redirectUri}?code=c&state=${state}`, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    // A closed listener refuses the connection.
    req.on("error", () => resolve(0));
    req.end();
  });
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
  });
});

afterEach(() => {
  // Close any loopback listener a test left open.
  for (const w of fake?.windows ?? []) {
    w.emit("closed");
  }
  vi.useRealTimers();
  vi.doUnmock("electron");
  if (savedEnv === undefined) {
    delete process.env.BUSY_URL;
  } else {
    process.env.BUSY_URL = savedEnv;
  }
});

describe("a hub that can't be reached", () => {
  it("shows a local reconnecting page at once, instead of a hidden window", async () => {
    await boot();
    failLoad(PRODUCTION);
    expect(win().show).toHaveBeenCalledTimes(1);
    expect(recoveryText()).toContain("Reconnecting to Busy");
    // Never a remote page: the recovery page is a local data: URL without script.
    expect(recoveryLoads().at(-1)?.startsWith("data:text/html")).toBe(true);
    expect(recoveryText()).toContain("default-src 'none'");
    expect(recoveryText()).not.toContain("<script");
  });

  it("retries after 1 s, 3 s and 10 s, then stops and offers a manual retry", async () => {
    await boot();
    for (const delay of [1000, 3000, 10_000]) {
      failLoad(PRODUCTION);
      vi.advanceTimersByTime(delay - 1);
      const before = hubLoads().length;
      vi.advanceTimersByTime(1);
      expect(hubLoads()).toHaveLength(before + 1);
    }
    failLoad(PRODUCTION);
    expect(recoveryText()).toContain("Busy can&#39;t reach the hub");
    expect(recoveryText()).toContain(`href="${PRODUCTION}"`);
    vi.advanceTimersByTime(60 * 60 * 1000);
    // The first load plus three retries; nothing after that without a person.
    expect(hubLoads()).toEqual([
      PRODUCTION,
      PRODUCTION,
      PRODUCTION,
      PRODUCTION,
    ]);
    // Shown once, when the first failure happened.
    expect(win().show).toHaveBeenCalledTimes(1);
  });

  it("recovers when the network is back, with a fresh retry budget for the next outage", async () => {
    await boot();
    failLoad(PRODUCTION);
    vi.advanceTimersByTime(1000);
    expect(wc().getURL()).toBe(PRODUCTION);
    finishLoad();
    // Later, the page fails again: the 1 s retry applies again, not the next step of the old outage.
    failLoad(PRODUCTION);
    const before = hubLoads().length;
    vi.advanceTimersByTime(1000);
    expect(hubLoads()).toHaveLength(before + 1);
  });

  it("retries the hub page that failed, but never a page of another origin", async () => {
    await boot();
    failLoad(`${PRODUCTION}/c/42`);
    vi.advanceTimersByTime(1000);
    expect(hubLoads().at(-1)).toBe(`${PRODUCTION}/c/42`);
    failLoad("https://evil.example/");
    vi.advanceTimersByTime(3000);
    expect(hubLoads().at(-1)).toBe(PRODUCTION);
  });

  it("ignores aborted navigations, subframes and the recovery page itself", async () => {
    await boot();
    emitFail(PRODUCTION, ERR_ABORTED, true);
    emitFail(`${PRODUCTION}/frame`, ERR_INTERNET_DISCONNECTED, false);
    emitFail("data:text/html,x", ERR_INTERNET_DISCONNECTED, true);
    vi.advanceTimersByTime(60_000);
    expect(loads()).toEqual([PRODUCTION]);
    expect(win().show).not.toHaveBeenCalled();
  });

  it("starts over when the person clicks Try again on the recovery page", async () => {
    await boot();
    for (const delay of [1000, 3000, 10_000]) {
      failLoad(PRODUCTION);
      vi.advanceTimersByTime(delay);
    }
    failLoad(PRODUCTION);
    const event = { isMainFrame: true, preventDefault: vi.fn() };
    wc().emit("will-navigate", event, PRODUCTION);
    // The link is the hub itself, so the navigation goes ahead…
    expect(event.preventDefault).not.toHaveBeenCalled();
    // …and if it fails again, the automatic retries apply again.
    failLoad(PRODUCTION);
    const before = hubLoads().length;
    vi.advanceTimersByTime(1000);
    expect(hubLoads()).toHaveLength(before + 1);
  });

  it("doesn't retry into a window that was closed meanwhile", async () => {
    await boot();
    failLoad(PRODUCTION);
    win().emit("closed");
    vi.advanceTimersByTime(60_000);
    expect(hubLoads()).toEqual([PRODUCTION]);
  });
});

describe("a renderer that crashes", () => {
  it("restarts it once, on the hub", async () => {
    await boot();
    finishLoad();
    crash();
    expect(hubLoads()).toEqual([PRODUCTION, PRODUCTION]);
    expect(recoveryLoads()).toEqual([]);
  });

  it("offers a manual retry when it crashes again after the restart, and stops there", async () => {
    await boot();
    crash();
    finishLoad();
    crash("oom");
    expect(hubLoads()).toHaveLength(2);
    expect(recoveryText()).toContain("Busy stopped working");
    expect(win().show).toHaveBeenCalledTimes(1);
    // The recovery page's own renderer dying doesn't start a loop.
    crash();
    crash();
    expect(loads()).toHaveLength(3);
  });

  it("keeps one window, its options and its handlers: nothing is registered twice", async () => {
    await boot();
    const counts = Object.fromEntries(
      [...wc().listeners.keys()].map((e) => [e, wc().listenerCount(e)])
    );
    crash();
    finishLoad();
    crash();
    expect(fake.windows).toHaveLength(1);
    expect(win().options.webPreferences).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      preload: expect.stringContaining("preload.cjs"),
      sandbox: true,
    });
    expect(
      Object.fromEntries(
        [...wc().listeners.keys()].map((e) => [e, wc().listenerCount(e)])
      )
    ).toEqual(counts);
    expect(fake.ipcMain.handle.mock.calls.map(([c]) => c)).toEqual([
      "busy:ai:chatgpt:prepare",
      "busy:ai:chatgpt:open",
      "busy:ai:chatgpt:cancel",
    ]);
  });

  it("still denies every permission after the restart", async () => {
    await boot();
    crash();
    finishLoad();
    const done = vi.fn();
    fake.perms.request?.(wc(), "media", done);
    expect(done).toHaveBeenCalledWith(false);
    expect(fake.perms.check?.(wc(), "geolocation")).toBe(false);
  });
});

describe("a renderer that stops responding", () => {
  it("is crashed and restarted after 10 s without a response", async () => {
    await boot();
    win().emit("unresponsive");
    win().emit("unresponsive");
    vi.advanceTimersByTime(9999);
    expect(wc().forcefullyCrashRenderer).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(wc().forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
  });

  it("is left alone when it responds again in time", async () => {
    await boot();
    win().emit("unresponsive");
    vi.advanceTimersByTime(5000);
    win().emit("responsive");
    vi.advanceTimersByTime(60_000);
    expect(wc().forcefullyCrashRenderer).not.toHaveBeenCalled();
  });
});

describe("Sign in with ChatGPT across a renderer restart", () => {
  it("cancels the pending sign-in: the old callback can't complete it, nor the new page's one", async () => {
    await boot();
    finishLoad();
    const old = await prepare();
    await open(old.redirectUri, "old-state");
    crash();
    finishLoad();
    // The old listener is gone.
    expect(await callback(old.redirectUri, "old-state")).toBe(0);
    // The new page signs in again on a new listener; the old state is refused there.
    const fresh = await prepare();
    expect(fresh.redirectUri).not.toBe(old.redirectUri);
    await open(fresh.redirectUri, "new-state");
    expect(await callback(fresh.redirectUri, "old-state")).toBe(400);
    expect(wc().session.fetch).not.toHaveBeenCalled();
  });

  it("refuses a message from the main frame of the renderer that crashed", async () => {
    await boot();
    const stale = ipcEvent();
    crash();
    finishLoad();
    expect(() => handler("busy:ai:chatgpt:prepare")(stale)).toThrow(
      "The Busy window is unavailable."
    );
  });

  it("refuses the recovery page and a closed window", async () => {
    await boot();
    for (const delay of [1000, 3000, 10_000]) {
      failLoad(PRODUCTION);
      vi.advanceTimersByTime(delay);
    }
    failLoad(PRODUCTION);
    expect(() => handler("busy:ai:chatgpt:prepare")(ipcEvent())).toThrow(
      "The Busy window is unavailable."
    );
    win().emit("closed");
    wc().mainFrame = { url: PRODUCTION };
    expect(() => handler("busy:ai:chatgpt:prepare")(ipcEvent())).toThrow(
      "The Busy window is unavailable."
    );
  });

  it("refuses a subframe of the hub", async () => {
    await boot();
    expect(() =>
      handler("busy:ai:chatgpt:prepare")(
        ipcEvent({ senderFrame: { url: PRODUCTION } })
      )
    ).toThrow("The Busy window is unavailable.");
  });
});

// N-07: BUSY_URL is trusted operator configuration. Whatever it names is the one origin the window keeps, the
// ChatGPT IPC answers, and the OAuth callback is forwarded to; production is the default.
describe.each([
  { expected: PRODUCTION, hub: undefined, label: "default production" },
  {
    expected: "http://localhost:3000",
    hub: "http://localhost:3000",
    label: "localhost",
  },
  {
    expected: "https://busy.localhost",
    hub: "https://busy.localhost",
    label: "a .localhost (portless) hub",
  },
  {
    expected: "https://busy-hub-git-feature-matisolina.vercel.app",
    hub: "https://busy-hub-git-feature-matisolina.vercel.app/",
    label: "a preview deployment",
  },
])("with BUSY_URL for $label", ({ hub, expected }) => {
  test("loads that origin", async () => {
    await boot(hub);
    expect(new URL(present(loads()[0])).origin).toBe(expected);
  });

  test("answers the ChatGPT IPC from that origin's main frame only", async () => {
    await boot(hub);
    wc().mainFrame = { url: `${expected}/settings/ai` };
    await expect(prepare()).resolves.toMatchObject({
      redirectUri: expect.stringMatching(LOOPBACK_CALLBACK_RE),
    });
    const other =
      expected === PRODUCTION ? "https://busy.localhost" : PRODUCTION;
    wc().mainFrame = { url: `${other}/settings/ai` };
    expect(() => handler("busy:ai:chatgpt:prepare")(ipcEvent())).toThrow(
      "The Busy window is unavailable."
    );
  });

  test("forwards the OAuth callback to that origin, through the window's session", async () => {
    await boot(hub);
    wc().mainFrame = { url: `${expected}/settings/ai` };
    const { redirectUri } = await prepare();
    await open(redirectUri, "s1");
    await callback(redirectUri, "s1");
    expect(wc().session.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = wc().session.fetch.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe(`${expected}/api/ai/connections/chatgpt/complete`);
    expect(init.headers.Origin).toBe(expected);
  });
});

function present<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected a present test value");
  }
  return value;
}
