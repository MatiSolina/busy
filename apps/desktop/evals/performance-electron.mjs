import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow } from "electron";

// Set this before Busy requests its single-instance lock. Never reuse a real profile.
const profile = process.env.PERF_ELECTRON_PROFILE;
if (!profile) {
  throw new Error("Missing isolated Electron evaluation profile");
}
app.setPath("userData", profile);

// Start the real shell without preloading a Next.js page. The evaluator installs
// its cookie and CPU throttle before navigating, just like the web context.
const { loadURL } = BrowserWindow.prototype;
BrowserWindow.prototype.loadURL = function startBlank() {
  BrowserWindow.prototype.loadURL = loadURL;
  return loadURL.call(this, "about:blank");
};
const sourceRoot = process.env.PERF_SOURCE_DIR;
await import(
  sourceRoot
    ? pathToFileURL(resolve(sourceRoot, "apps/desktop/main.mjs")).href
    : new URL("../main.mjs", import.meta.url).href
);
