# Busy for Mac (apps/desktop)

A native window on the hub. The hub owns the UI, the session cookie and every
credential; the shell only loads it, keeps navigation on its origin, brokers the
ChatGPT loopback callback and updates itself.

## `BUSY_URL` is trusted configuration

`BUSY_URL` (default `https://app.busybot.dev`) is set by whoever launches Busy:
the operator packaging it, or a developer running `pnpm --filter busy-desktop start`
against a local hub (`http://localhost:3000`, a portless `https://busy.localhost`)
or a preview deployment. Its origin is used for all of these:

- the page the window loads, and the only origin allowed to navigate inside it
  (`url-policy.mjs`); everything else opens in the browser or is dropped;
- the only origin whose main frame may call the ChatGPT IPC (`rendererBroker`);
- the hub that receives the ChatGPT OAuth callback: `subscription-auth.mjs`
  POSTs it to `<BUSY_URL origin>/api/ai/connections/chatgpt/complete` with the
  window's session;
- update checks and downloads (`/api/download/version`, `/api/download`).

Treat it as trusted launch configuration: a process that can change Busy's
environment can point it at another hub. No allowlist is enforced,
on purpose, so local and preview hubs keep working. Add one only if Busy is ever
launched by something that isn't trusted, and then keep `localhost`,
`.localhost` and deliberate previews working in development builds.
`main.window.test.ts` pins the behavior for the default, `localhost`,
`.localhost` and a preview origin.

## Run or package a self-hosted desktop

The checked-in default points at the official Busy hub. A local or self-hosted
hub must be selected explicitly with `BUSY_URL`; this variable is runtime
configuration and is intentionally trusted by the person launching the app:

```sh
# Run the desktop shell against a local hub.
BUSY_URL=http://localhost:3000 pnpm --filter busy-desktop start

# Run a packaged app against your own HTTPS hub from its executable.
BUSY_URL=https://busy.example.com \
  apps/desktop/dist/mac-arm64/Busy.app/Contents/MacOS/Busy
```

Build the Apple Silicon package from a Mac after configuring your own hub:

```sh
pnpm --filter busy-desktop dist
```

`dist` produces an ad-hoc signed arm64 zip; it does not embed `BUSY_URL`.
Launching the app from Finder therefore uses the checked-in default. For a
standalone Finder app, change the default in `apps/desktop/main.mjs` before
packaging; otherwise launch the executable with `BUSY_URL` as shown above. The
self-hosted hub's
`/install` endpoint can publish an installer for its own release, but it needs
its own private Blob release and `BUSY_APP_VERSION`/`BUSY_APP_SHA256` values.
The release helper uploads only to the Blob credentials supplied by the
operator; it does not publish to the official Busy infrastructure automatically.

## Window recovery

Each window tracks `loading`, `ready`, `failed`, `restarting` or `closed`:

- A failed main-frame load (`did-fail-load`, not `ERR_ABORTED`) shows a local
  "Reconnecting…" page right away and retries the hub after 1 s, 3 s and 10 s.
  After that it shows "Busy can't reach the hub" with a **Try again** link back
  to the hub, which resets the budget. The page is a `data:` URL with no script;
  it never gets the ChatGPT IPC.
- A renderer that crashes (`render-process-gone`) is restarted once on the hub.
  A hang (`unresponsive` for 10 s without `responsive`) is crashed and goes the
  same way. A second crash shows the manual retry page.
- A restart, close or navigation away cancels that window's ChatGPT listener.
  The IPC handlers are registered once per app, the security options
  (`contextIsolation`, `sandbox`, `nodeIntegration: false`) and the
  deny-everything permission handlers are unchanged.

Electron also reports a failed load's error page as `did-finish-load` at the
hub URL. The window ignores it while the recovery page is up, so it isn't taken
as ready. This was checked with the real Electron 45 binary: offline start,
retry, crash and restart, second crash, Try again, and a hung page.

## Self-update

The hub publishes `version` and the zip's SHA-256. After the person accepts,
`main.mjs` downloads the zip and checks the hash. It extracts the zip and
verifies the bundle before quitting. The bundle must be a complete `Busy.app`:
`Contents/Info.plist` with identifier `com.matisolina.busy`, its
`CFBundleExecutable` present and executable, and `CFBundleShortVersionString`
equal to the published version. A zip that fails this is reported and nothing
is installed.

The swap runs in `UPDATER_SCRIPT` (`update.mjs`). `main.mjs` copies it to
`~/Library/Application Support/Busy/updater/busy-updater.sh` (mode 0700, outside
the bundle) and starts it detached after the app quits. It keeps its journal next
to it (`updater/journal`, replaced with temp + rename) with the phases `staged`,
`old-moved`, `new-installed`, `verified`, `cleanup`, `failed` and `rolled-back`.

1. Copy the update next to the app as `Busy.app.new` and verify it again
   (`staged`).
2. Swap it in. On APFS this is one atomic `renameatx_np(RENAME_SWAP)` (syscall
   488, run through `/usr/bin/perl`, pinned so a Homebrew perl on PATH is never
   used), so `Busy.app` always exists. Without it
   (another file system, no perl) the swap falls back to two renames.
3. Verify the installed bundle (`verified`), keep the previous build as
   `Busy.app.old` and relaunch.
4. The new build's startup confirms the update: the running bundle and version
   match the journal. Only then does `recover` delete `Busy.app.old` and the
   journal. If the update failed or was rolled back, the next start says so in
   a dialog.

Recovery decides from what is on disk, never from the journal alone. It only
touches `APP`, `APP.new` and `APP.old`, for a journal path that is an absolute
`*.app` with one of those three being a complete Busy bundle. A corrupt or
edited journal is set aside as `journal.invalid` without touching anything. A
lock (`updater/lock`, with the holder's pid) keeps the startup recovery from
racing a running swap.

### When recovery runs, and the limit

- **Next start of Busy** (`recoverUpdate` in `main.mjs`), whenever a journal
  exists. It finishes or reverts an interrupted swap and confirms or reports
  the result.
- **The next update's swap** settles any leftover journal before starting.
- **By hand**, without the app:

  ```sh
  sh ~/Library/Application\ Support/Busy/updater/busy-updater.sh recover \
    ~/Library/Application\ Support/Busy/updater
  ```

  It prints the phase it settled. It restores a missing `Busy.app` from the
  verified staged copy or `Busy.app.old`, and never deletes a backup.

No LaunchAgent is installed. A per-user agent (for example `RunAtLoad`, or a
`KeepAlive` job running the swap) would recover even with no app to start.
But it adds a persistent background item (macOS shows "Background Items Added"
on each install), and its activation can't be exercised in tests without
changing the real login session. With the atomic swap, the installed path is
never empty, so the startup recovery always has an app to run from.

The remaining gap is the two-rename fallback on non-APFS volumes. A kill or
power loss between the renames leaves `Busy.app` missing until the person runs
the command above, which restores it. The journal isn't fsynced (sh can't), so
it's safe against a killed process but not proven against power loss. Recovery
reads the disk, not just the journal, to cover that. The new build's
confirmation is a launch handshake, not a functional check. If the new build
can't start at all, `Busy.app.old` stays in place for a manual restore.

Tests: `update.swap.test.ts` SIGKILLs a separate `sh` after every rename and
exchange (both modes), then runs the standalone recovery and the startup
confirmation. It also covers failures of `ditto`, rename and exchange,
incomplete bundles, edited journals and the lock. `main.update.test.ts` runs the
same flow end to end from `main.mjs`, including a kill between the renames
recovered by the copy outside the bundle. Fixtures live in `mkdtemp`
directories; no test touches an installed app.
