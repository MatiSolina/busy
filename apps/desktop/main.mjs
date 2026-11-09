// Busy for Mac: a native window on the hub. No logic and no credentials live here;
// the hub (Vercel) owns the UI and the session cookie.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  session,
  shell,
} from "electron";
import { createChatGptBroker } from "./subscription-auth.mjs";
import { isNewer, UPDATER_FILE, UPDATER_SCRIPT } from "./update.mjs";
import { navigationPolicy } from "./url-policy.mjs";

// BUSY_URL is trusted operator configuration (local/dev hubs, previews): whoever launches Busy decides it. The
// window loads it, it is the only origin the window and the ChatGPT IPC accept, update checks ask it, and the
// ChatGPT OAuth callback is forwarded to it (subscription-auth.mjs). See docs/desktop.md.
const HUB = process.env.BUSY_URL ?? "https://app.busybot.dev";
const ICON = join(dirname(fileURLToPath(import.meta.url)), "icon.png");
const UPDATE_EVERY = 6 * 60 * 60 * 1000;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const PRELOAD = join(dirname(fileURLToPath(import.meta.url)), "preload.cjs");
// Per window: { broker, state }. state.phase is loading | ready | failed | restarting | closed.
const desktopWindows = new WeakMap();
let desktopIpcRegistered = false;
// A failed main-frame load is retried after each of these delays, then the window offers a manual retry.
const LOAD_RETRY_DELAYS = [1000, 3000, 10_000];
// A renderer that crashes (or hangs past the grace period) is restarted once; after that, manual retry.
const MAX_RENDERER_RESTARTS = 1;
const UNRESPONSIVE_GRACE_MS = 10_000;
// net::ERR_ABORTED: a navigation replaced by another one (or stopped by will-navigate), not a failure.
const ERR_ABORTED = -3;
// execFile as a promise of stdout (the callback form, so the tests' execFile stand-in behaves the same).
const run = (file, args) =>
  new Promise((done, fail) => {
    execFile(file, args, (error, stdout) =>
      error ? fail(error) : done(String(stdout ?? ""))
    );
  });
const HTML_ESCAPES = {
  "'": "&#39;",
  '"': "&quot;",
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};
const HTML_SPECIAL_RE = /[&<>"']/gu;

// The window has no title bar: leave room for the traffic lights and make the top bars draggable.
const SHELL_CSS = `
  .busy-titlebar { -webkit-app-region: drag; }
  .busy-titlebar button, .busy-titlebar a { -webkit-app-region: no-drag; }
  aside.busy-titlebar, aside .busy-titlebar { padding-left: 84px; }
  aside[data-collapsed="true"] .busy-titlebar { height: 112px; padding: 56px 0 0; }
`;

const escapeHtml = (value) =>
  value.replace(HTML_SPECIAL_RE, (c) => HTML_ESCAPES[c]);

// A local page without script: its only way out is the link back to the hub, which will-navigate allows.
function recoveryPage(title, message) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Busy</title><style>body{background:#0a0a0a;color:#f5f5f5;font:15px system-ui,sans-serif;display:grid;min-height:100vh;place-items:center;margin:0;-webkit-app-region:drag}main{max-width:28rem;padding:2rem;text-align:center}p{color:#a3a3a3;line-height:1.5}a{color:#f5f5f5;-webkit-app-region:no-drag}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(HUB)}">Try again</a></p></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(body)}`;
}
const isRecoveryPage = (url) =>
  typeof url === "string" && url.startsWith("data:");

function createWindow() {
  const win = new BrowserWindow({
    backgroundColor: "#0a0a0a",
    height: 820,
    icon: ICON,
    minHeight: 600,
    minWidth: 900,
    show: false,
    title: "Busy",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: PRELOAD,
      sandbox: true,
    },
    width: 1280,
  });
  const broker = createChatGptBroker({
    fetchImpl: (url, init) => win.webContents.session.fetch(url, init),
    hub: HUB,
    openExternal: (url) => shell.openExternal(url),
  });
  const state = {
    cancelReason: null,
    loadFailures: 0,
    phase: "loading",
    // The recovery page is up (or on its way): until the hub is loaded again, nothing finished is the hub.
    recovering: false,
    restarts: 0,
    retryTimer: null,
    unresponsiveTimer: null,
  };
  desktopWindows.set(win.webContents, { broker, state });

  // Shows the window once: on its first paint, or with the recovery page if it never paints the hub.
  let show = () => {
    show = () => undefined;
    win.show();
  };
  const clearTimers = () => {
    clearTimeout(state.retryTimer);
    clearTimeout(state.unresponsiveTimer);
    state.retryTimer = null;
    state.unresponsiveTimer = null;
  };
  // A pending Sign in with ChatGPT belongs to the page that started it: a reloaded or closed page starts over.
  const cancelBroker = (reason) => {
    state.cancelReason = reason;
    broker.cancel();
  };
  const load = (url) => {
    state.recovering = isRecoveryPage(url);
    // Failures also arrive as did-fail-load, which owns the retry; the rejected promise only repeats them.
    win.loadURL(url).catch(() => undefined);
  };
  const showRecovery = (title, message) => {
    load(recoveryPage(title, message));
    show();
  };

  win.once("closed", () => {
    state.phase = "closed";
    clearTimers();
    cancelBroker("closed");
  });
  win.once("ready-to-show", () => show());
  win.webContents.on("did-finish-load", () => {
    // The renderer can disappear while Electron is injecting the CSS; this is deliberately fire-and-forget.
    // biome-ignore lint/complexity/noVoid: the page lifecycle must not wait on renderer CSS injection
    void win.webContents.insertCSS(SHELL_CSS);
    // Electron also reports a failed load's error page as finished, at the hub's URL: that is not ready.
    if (
      state.phase !== "closed" &&
      !state.recovering &&
      navigationPolicy(win.webContents.getURL(), HUB) === "allow"
    ) {
      state.phase = "ready";
      state.loadFailures = 0;
    }
  });
  win.webContents.on(
    "did-fail-load",
    (_event, code, _description, url, isMainFrame) => {
      if (
        isMainFrame === false ||
        code === ERR_ABORTED ||
        isRecoveryPage(url) ||
        state.phase === "closed"
      ) {
        return;
      }
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
      const delay = LOAD_RETRY_DELAYS[state.loadFailures];
      state.loadFailures += 1;
      if (delay === undefined) {
        state.phase = "failed";
        showRecovery(
          "Busy can't reach the hub",
          "Check your connection, then try again."
        );
        return;
      }
      state.phase = "loading";
      const retry = navigationPolicy(url, HUB) === "allow" ? url : HUB;
      showRecovery("Reconnecting to Busy…", "Busy will try again in a moment.");
      state.retryTimer = setTimeout(() => {
        state.retryTimer = null;
        if (state.phase === "loading") {
          load(retry);
        }
      }, delay);
    }
  );
  win.webContents.on("render-process-gone", (_event, details) => {
    if (state.phase === "closed" || state.phase === "failed") {
      return;
    }
    clearTimers();
    cancelBroker(`renderer ${details?.reason ?? "gone"}`);
    if (state.restarts >= MAX_RENDERER_RESTARTS) {
      state.phase = "failed";
      showRecovery(
        "Busy stopped working",
        "The window crashed again after a restart."
      );
      return;
    }
    state.restarts += 1;
    state.phase = "restarting";
    load(HUB);
  });
  win.on("unresponsive", () => {
    if (state.phase === "closed" || state.unresponsiveTimer) {
      return;
    }
    state.unresponsiveTimer = setTimeout(() => {
      state.unresponsiveTimer = null;
      if (state.phase !== "closed") {
        // Ends in render-process-gone, which applies the single restart.
        win.webContents.forcefullyCrashRenderer();
      }
    }, UNRESPONSIVE_GRACE_MS);
  });
  win.on("responsive", () => {
    clearTimeout(state.unresponsiveTimer);
    state.unresponsiveTimer = null;
  });

  // Links that leave the app open in the default browser; nothing remote takes over the window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (navigationPolicy(url, HUB) !== "block") {
      // biome-ignore lint/complexity/noVoid: opening an external URL must not block navigation handling
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  const enforce = (event, url) => {
    const policy = navigationPolicy(url, HUB);
    if (policy !== "allow" && event.isMainFrame !== false) {
      cancelBroker("navigation");
    }
    if (policy === "allow") {
      if (
        event.isMainFrame !== false &&
        isRecoveryPage(win.webContents.getURL())
      ) {
        // "Try again" on the recovery page: a person asked, so the retry and restart budgets start over.
        clearTimers();
        state.loadFailures = 0;
        state.restarts = 0;
        state.recovering = false;
        state.phase = "loading";
      }
      return;
    }
    event.preventDefault();
    if (policy === "external") {
      // biome-ignore lint/complexity/noVoid: opening an external URL must not block navigation handling
      void shell.openExternal(url);
    }
  };
  win.webContents.on("will-navigate", enforce);
  // Main frame only: a PDF iframe legitimately redirects to its signed Blob URL.
  win.webContents.on(
    "will-redirect",
    (details) => details.isMainFrame && enforce(details, details.url)
  );
  win.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame) {
      enforce(event, event.url);
    }
  });

  load(HUB);
}

function rendererBroker(event) {
  const entry = desktopWindows.get(event.sender);
  const frame = event.senderFrame;
  if (
    !(entry && frame && event.sender.mainFrame) ||
    frame !== event.sender.mainFrame ||
    entry.state.phase === "closed" ||
    entry.state.phase === "failed"
  ) {
    throw new Error("The Busy window is unavailable.");
  }
  let parsed;
  try {
    parsed = new URL(frame.url);
  } catch (error) {
    throw new Error("The Busy window is unavailable.", { cause: error });
  }
  if (parsed.origin !== new URL(HUB).origin) {
    throw new Error("The Busy window is unavailable.");
  }
  return entry.broker;
}

function registerDesktopSubscriptionIpc() {
  if (desktopIpcRegistered || !ipcMain?.handle) {
    return;
  }
  desktopIpcRegistered = true;
  ipcMain.handle("busy:ai:chatgpt:prepare", (event) =>
    rendererBroker(event).prepare()
  );
  ipcMain.handle("busy:ai:chatgpt:open", (event, attempt) =>
    rendererBroker(event).open(attempt)
  );
  ipcMain.handle("busy:ai:chatgpt:cancel", (event) =>
    rendererBroker(event).cancel()
  );
}

// Self-update. Ad-hoc signed, so Squirrel/electron-updater are out; only this shell ever needs updating
// (the UI is the hub). The zip is trusted only if it matches the SHA-256 the hub deployment publishes.
// The swap itself runs in UPDATER_SCRIPT (update.mjs), from a copy kept outside the bundle; docs/desktop.md.
const updaterState = () => join(app.getPath("userData"), "updater");
// execPath is …/Busy.app/Contents/MacOS/Busy: the bundle that is actually running.
const runningBundle = () => resolve(process.execPath, "../../..");

// At startup: finish or roll back a swap a previous run left behind, and confirm the update only now that the
// new build is running (which is when the updater may delete the previous build it kept as a backup).
async function recoverUpdate() {
  if (!app.isPackaged) {
    return;
  }
  const state = updaterState();
  if (!existsSync(join(state, "journal"))) {
    return;
  }
  const stdout = await run("/bin/sh", [
    "-c",
    UPDATER_SCRIPT,
    "busy-update",
    "recover",
    state,
    runningBundle(),
    app.getVersion(),
  ]);
  const [result, error] = stdout.split("\n");
  if (result === "failed") {
    await dialog.showMessageBox({
      buttons: ["OK"],
      detail: `${error || "The update didn't finish."} You have version ${app.getVersion()}.`,
      message: "Busy couldn't finish updating",
      type: "warning",
    });
  }
}

let updating = false;
async function checkForUpdate() {
  if (updating || !app.isPackaged) {
    return;
  }
  updating = true;
  let accepted = false;
  try {
    const res = await net.fetch(`${HUB}/api/download/version`);
    if (!res.ok) {
      return;
    }
    const { version, sha256 } = await res.json();
    if (!(isNewer(version, app.getVersion()) && SHA256_RE.test(sha256))) {
      return;
    }
    const { response } = await dialog.showMessageBox({
      buttons: ["Update", "Later"],
      cancelId: 1,
      defaultId: 0,
      detail: `Version ${version} (you have ${app.getVersion()}). Busy will quit and reopen on its own.`,
      message: "A new version of Busy is available",
      type: "info",
    });
    if (response !== 0) {
      return;
    }
    accepted = true;
    await installUpdate(version, sha256);
  } catch (err) {
    // A failed background check stays quiet; a failed update the user asked for does not.
    if (accepted) {
      dialog.showErrorBox(
        "Couldn't update Busy",
        err instanceof Error ? err.message : String(err)
      );
    }
  } finally {
    updating = false;
  }
}

async function installUpdate(version, sha256) {
  const res = await net.fetch(`${HUB}/api/download`);
  if (!res.ok) {
    throw new Error(`The download failed (HTTP ${res.status}).`);
  }
  const zip = Buffer.from(await res.arrayBuffer());
  if (createHash("sha256").update(zip).digest("hex") !== sha256) {
    throw new Error(
      "The download doesn't match the published version (SHA-256 mismatch). Nothing was installed."
    );
  }
  const bundle = runningBundle();
  if (!bundle.endsWith(".app")) {
    throw new Error(`Can't find the installed app (${bundle}).`);
  }
  const dir = await mkdtemp(join(tmpdir(), "busy-update-"));
  const newApp = join(dir, "new", "Busy.app");
  try {
    await writeFile(join(dir, "Busy.zip"), zip);
    await run("/usr/bin/ditto", [
      "-x",
      "-k",
      join(dir, "Busy.zip"),
      join(dir, "new"),
    ]);
    try {
      await run("/bin/sh", [
        "-c",
        UPDATER_SCRIPT,
        "busy-update",
        "verify",
        newApp,
        version,
      ]);
    } catch (error) {
      throw new Error(
        `The download doesn't contain a complete Busy.app ${version}. Nothing was installed.`,
        { cause: error }
      );
    }
  } catch (error) {
    await rm(dir, { force: true, recursive: true });
    throw error;
  }
  // The swap runs from a copy outside the bundle it replaces, next to its journal.
  const state = updaterState();
  await mkdir(state, { mode: 0o700, recursive: true });
  const helper = join(state, UPDATER_FILE);
  await writeFile(`${helper}.tmp`, UPDATER_SCRIPT, { mode: 0o700 });
  await rename(`${helper}.tmp`, helper);
  spawn(
    "/bin/sh",
    [helper, "swap", String(process.pid), newApp, bundle, dir, version, state],
    { detached: true, stdio: "ignore" }
  ).unref();
  app.quit();
}

// An interrupted update is settled before the first check can start another one.
async function startUpdates() {
  try {
    await recoverUpdate();
  } catch (error) {
    console.error("Busy update recovery failed", error);
  }
  await checkForUpdate();
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on("second-instance", () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win?.isMinimized()) {
    win.restore();
  }
  win?.focus();
});

app.whenReady().then(() => {
  app.dock?.setIcon(ICON);
  // Deny every permission by default; grant per feature when one needs it.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) =>
    done(false)
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  registerDesktopSubscriptionIpc();
  createWindow();
  // biome-ignore lint/complexity/noVoid: update recovery and checks must not block app startup
  void startUpdates();
  setInterval(() => {
    // biome-ignore lint/complexity/noVoid: periodic update checks must not block the event loop
    void checkForUpdate();
  }, UPDATE_EVERY);
  app.on(
    "activate",
    () => BrowserWindow.getAllWindows().length === 0 && createWindow()
  );
});

app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());
