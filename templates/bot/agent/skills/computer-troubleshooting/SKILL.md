---
name: computer-troubleshooting
description: Load when your own computer misbehaves, i.e. bash commands fail or hang, the desktop command or browser tools return errors, Chrome won't open or keeps restarting, refs stop working, or the live screen is blank, before you give up or tell the user it's broken.
---

# When your computer misbehaves

Your computer is a Linux machine with a desktop (display `:99`), Chrome, persistent /data and temporary /workspace. Diagnose calmly, keep the user posted only at real milestones, and never claim a task finished when the computer blocked it.

## 1. Is it up?

- Run a trivial bash command (`echo ok; df -h /data /workspace`). If it answers, the computer is running. Check free disk while you're there.
- A first start, or a start after the computer stopped while idle, can take a while. If a tool says the computer is starting or times out once, wait a few seconds and retry once or twice before concluding anything.
- The computer may stop between idle messages. /data stays; a later turn may resume the same screen or start a fresh one.

## 2. After any restart, refs are stale

If the screen, the desktop session or Chrome restarted (or the user took control), every old accessibility ref is invalid. Take a fresh `browser__snapshot` (or a fresh `desktop` snapshot) before any click or fill. Never replay an old ref or a failed click blindly.

## 3. What the common errors mean

- `USER_CONTROL_ACTIVE`, `CONTROL_BUSY`, `BROWSERERROR_USERCONTROL`: the user (or another task) is controlling the screen. Pause, tell the user, wait until control returns, then take a fresh snapshot.
- `CONTROL_LOST`: control changed hands during your action. Take a fresh snapshot and check what actually happened before continuing.
- `BROWSER_OBSERVATION_REQUIRED`: you must take a fresh snapshot before acting on refs.
- `BROWSER_GENERATION_CHANGED`: Chrome restarted mid-batch; nothing more was sent. Snapshot again and redo only the steps that didn't happen.
- `BROWSER_ENDPOINT_UNAVAILABLE`, `BROWSER_UNMANAGED`, an unavailable CDP endpoint: the managed Chrome isn't reachable, or a Chrome was started outside the managed launcher. Don't launch `google-chrome` yourself; reopen the page with `browser__open`, which starts the managed Chrome.
- `BROWSER_DESKTOP_UNREADY`: the desktop session isn't ready yet. Wait a few seconds and retry.
- `BROWSER_LAUNCH_FAILED`: Chrome couldn't start. Retry once; if it fails again, check the logs below.
- `BATCH_*` errors: the `browser__batch` input was invalid or hit a step or time limit. Read the step statuses and the final snapshot, fix the batch, and don't repeat steps that already succeeded.
- `desktop` command errors: run `desktop <command> --help` for the right flags, and re-read `desktop skills get desktop` if you haven't this conversation.

## 4. Read-only diagnostics

Use bash only to look, not to repair:

- Desktop logs: `ls /tmp/desktop-*.log` and `tail -n 50` the relevant one (Xvfb, openbox, accessibility, panel, file manager).
- Processes: `pgrep -a chrome`, `pgrep -a Xvfb`.
- The computer image version: `cat /etc/busy-image-version`.
- Disk: `df -h`. If /workspace is full, delete your own temporary files there; never delete the user's files in /data.

Don't kill processes, delete lock files, reinstall packages, edit system configuration, or drive the screen with `xdotool` to force things. Don't use `curl` or scripts to replace the visible browser.

## 5. When it needs a reset

You can't reset your own computer. If the desktop, browser or live screen keep failing after a fresh snapshot and a couple of retries, or a notice says your computer comes from an older image, tell the user plainly:

"My computer needs a reset. Files in /data are kept, but browser logins may be lost."

There is no reset button in the Busy app, so don't invent one; the reset is done by whoever runs this Busy installation. Meanwhile, offer what you can still do without the screen (connected apps, files, bash).

## 6. Software you installed

Packages and tools you installed outside /data may be gone after a reset or a fresh computer. Reinstall what you need. Keep anything that must last (scripts, outputs, notes) in /data.
