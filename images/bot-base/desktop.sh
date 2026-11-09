#!/bin/sh
# desktop <agent-desktop args>: starts this computer's screen once (Xvfb, D-Bus with the
# AT-SPI accessibility bus, openbox) and runs agent-desktop inside that session.
# Baked into the bot base image as /usr/local/bin/desktop (images/bot-base). A resume loses processes, so
# every call checks and restarts what is missing.
set -eu
export DISPLAY=:99
export XDG_RUNTIME_DIR=/tmp/desktop-runtime
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
export ACCESSIBILITY_ENABLED=1 GTK_MODULES=gail:atk-bridge NO_AT_BRIDGE=0
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"

# Every mutating desktop call is held under the same kernel lease as browser
# actions. Read-only observations stay direct so they can still diagnose a
# viewer's screen while the manual-control lease is active. A caller already
# under the lease proves it with the locked descriptor desktop-control passed
# (fd 7); an environment variable alone is not enough. This coordinates the
# wrappers; it is not a security boundary (see desktop-control).
if command -v desktop-control >/dev/null 2>&1 && ! desktop-control is-read-only "$@"; then
  if [ -z "${BUSY_DESKTOP_LEASE_FD:-}" ] || ! desktop-control verify-lease; then
    exec 7>&-
    unset BUSY_DESKTOP_LEASE_FD BUSY_DESKTOP_LEASE_MODE
    exec desktop-control run --pass-lease -- "$0" "$@"
  fi
fi
# Nothing this starts (the screen's daemons, agent-desktop) may keep the lease.
exec 7>&-
unset BUSY_DESKTOP_LEASE_FD BUSY_DESKTOP_LEASE_MODE BUSY_DESKTOP_CONTROLLED

# Parallel calls start the screen once: the first one holds the lock while it boots.
# Daemons get 9>&- so they don't keep holding it.
exec 9>"$XDG_RUNTIME_DIR/start.lock"
flock 9
fresh_screen=0
if ! xdpyinfo >/dev/null 2>&1; then
  # A fresh screen means no Chrome is running. After a resume the hostname changes, and Chrome
  # would refuse a profile still locked by the old one. The cursor overlay belonged to the old screen.
  fresh_screen=1
  rm -f /tmp/.X99-lock "$HOME"/.config/google-chrome/Singleton* "$HOME"/.config/busy-chrome-profile/Singleton* "$XDG_RUNTIME_DIR/agent-session" "$XDG_RUNTIME_DIR/desktop-ready" "$XDG_RUNTIME_DIR/a11y-ready"
  Xvfb :99 -screen 0 1440x900x24 -nolisten tcp >/tmp/desktop-xvfb.log 2>&1 9>&- &
  for _ in 1 2 3 4 5 6 7 8 9 10; do xdpyinfo >/dev/null 2>&1 && break; sleep 0.3; done
fi
# The loop above only waits: nothing that needs X starts, and no readiness is
# claimed, unless the display really answers. The next call starts it again.
screen_failed() {
  rm -f "$XDG_RUNTIME_DIR/desktop-ready" "$XDG_RUNTIME_DIR/agent-session"
  if command -v desktop-control >/dev/null 2>&1; then desktop-control invalidate >/dev/null 2>&1 || true; fi
  echo "desktop: $1" >&2
  exit 1
}
xdpyinfo >/dev/null 2>&1 || screen_failed "the screen (Xvfb on :99) did not become ready"

bus_responds() {
  [ -S "$XDG_RUNTIME_DIR/bus" ] || return 1
  if command -v dbus-send >/dev/null 2>&1; then
    dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply=literal \
      /org/freedesktop/DBus org.freedesktop.DBus.ListNames >/dev/null 2>&1
    return $?
  fi
  return 0
}

stop_a11y() {
  a11y_identity=$(cat "$XDG_RUNTIME_DIR/a11y-ready" 2>/dev/null || true)
  a11y_pid=${a11y_identity%%:*}
  a11y_start=${a11y_identity#*:}
  case "$a11y_pid" in
    ""|*[!0-9]*) pkill -x desktop-a11y >/dev/null 2>&1 || true ;;
    *)
      case "$a11y_start" in
        ""|*[!0-9]*) pkill -x desktop-a11y >/dev/null 2>&1 || true ;;
        *)
          if [ -r "/proc/$a11y_pid/stat" ]; then
            a11y_fields=$(cat "/proc/$a11y_pid/stat" 2>/dev/null || true)
            a11y_rest=${a11y_fields##*) }
            set -- $a11y_rest
            [ "${20:-}" = "$a11y_start" ] && kill "$a11y_pid" >/dev/null 2>&1 || true
          else
            pkill -x desktop-a11y >/dev/null 2>&1 || true
          fi
          ;;
      esac
      ;;
  esac
  rm -f "$XDG_RUNTIME_DIR/a11y-ready"
}

# A resumed sandbox can leave a socket at this path with no live bus behind it.
# Probe the bus, remove only that stale socket, then wait for a real reply.
if ! bus_responds; then
  stop_a11y
  rm -f "$XDG_RUNTIME_DIR/bus" "$XDG_RUNTIME_DIR/a11y-ready"
  dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" --fork --nopidfile >/dev/null 9>&-
  for _ in 1 2 3 4 5 6 7 8 9 10; do bus_responds && break; sleep 0.3; done
fi
[ -S "$XDG_RUNTIME_DIR/bus" ] && bus_responds || { echo "desktop: session D-Bus did not become ready" >&2; exit 1; }
# A non-compositing window manager: agent-desktop can capture the whole display under it.
pgrep -x openbox >/dev/null || (openbox >/tmp/desktop-openbox.log 2>&1 9>&- &)
# Keeps Chrome alive when agent-desktop presses keys (desktop-a11y says how).
a11y_running() {
  a11y_identity=$(cat "$XDG_RUNTIME_DIR/a11y-ready" 2>/dev/null || true)
  a11y_pid=${a11y_identity%%:*}
  a11y_start=${a11y_identity#*:}
  case "$a11y_identity" in
    *:*[0-9]*)
      if [ -r "/proc/$a11y_pid/stat" ]; then
        a11y_fields=$(cat "/proc/$a11y_pid/stat" 2>/dev/null || true)
        a11y_rest=${a11y_fields##*) }
        set -- $a11y_rest
        [ "${20:-}" = "$a11y_start" ] && kill -0 "$a11y_pid" >/dev/null 2>&1 && return 0
      fi
      ;;
  esac
  # The fallback is only for the test harness/older non-Linux hosts. Linux
  # images always use the PID+start-tick identity above, not comm=python3.
  pgrep -x desktop-a11y >/dev/null 2>&1
}
if ! a11y_running || [ ! -s "$XDG_RUNTIME_DIR/a11y-ready" ]; then
  stop_a11y
  (desktop-a11y >/tmp/desktop-a11y.log 2>&1 9>&- &)
fi
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if a11y_running && [ -s "$XDG_RUNTIME_DIR/a11y-ready" ]; then break; fi
  sleep 0.3
done
if ! a11y_running || [ ! -s "$XDG_RUNTIME_DIR/a11y-ready" ]; then
  echo "desktop: AT-SPI listener did not become ready" >&2
  exit 1
fi
# The desktop people see in the app's live screen: taskbar, file manager, terminal (desktop-session).
desktop-session 9>&- || true
if [ "$fresh_screen" -eq 1 ] && command -v desktop-control >/dev/null 2>&1; then
  desktop-control invalidate >/dev/null 2>&1 || true
fi
# Xvfb can die while the bus, openbox or the session start: check it again
# right before claiming the desktop is ready (D-Bus and AT-SPI don't prove X).
xdpyinfo >/dev/null 2>&1 || screen_failed "the screen (Xvfb on :99) stopped while the desktop started"
printf '%s\n' "ready" >"$XDG_RUNTIME_DIR/desktop-ready"
exec 9>&-

# In this session agent-desktop draws a cursor moving to every target, so people watching the live
# screen see what the bot clicks and types into (its own actions never move the real pointer).
if [ -s "$XDG_RUNTIME_DIR/agent-session" ]; then export AGENT_DESKTOP_SESSION="$(cat "$XDG_RUNTIME_DIR/agent-session")"; fi
# Web pages refuse headless `type`: keys always go physical, for `press` too.
case "${1:-}" in press | type) set -- --headed "$@" ;; esac
exec agent-desktop "$@"
