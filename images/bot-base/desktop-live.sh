#!/bin/sh
# desktop-live <token> <control-password> <view-password>: shows this computer's screen live in the
# hub's app (noVNC). x11vnc shares the screen `desktop` starts, on localhost only; websockify on
# :6080 lets in only a websocket carrying the hub's token, and x11vnc's two passwords decide whether
# that viewer only watches or also clicks and types. The hub runs this and exposes port 6080.
# Baked into the bot base image as /usr/local/bin/desktop-live. Safe to run again: it restarts only
# what a resume killed, and rewrites the token.
#
# On success it prints one JSON line: {"ok":true,"screen":"ready","browser":"ready"|"busy"}.
# "busy" means the screen is shared but the managed Chrome could not be checked or opened because
# an agent action or a viewer holds desktop-control; browser actions keep answering CONTROL_BUSY.
# Any other failure exits non-zero before the screen is shared. Exit 75 means the previous x11vnc
# is still stopping: nothing changed, run it again.
set -eu
[ $# -eq 3 ] || { echo "usage: desktop-live <token> <control-password> <view-password>" >&2; exit 2; }
# Boots the screen if it isn't up (Xvfb, D-Bus, openbox); fails when X does not answer.
desktop version >/dev/null
# One run at a time: two viewers opening the screen together would each find no Chrome and open
# one. What it starts gets 8>&- so it doesn't keep holding the lock.
exec 8>/tmp/desktop-live.lock
flock 8
live=/tmp/desktop-runtime/live
mkdir -p "$live" && chmod 700 "$live"
umask 077

screen_ready() { xdpyinfo -display :99 >/dev/null 2>&1; }

# Something to watch and use: the one managed Chrome endpoint shared by Live,
# taskbar/XDG launches and the stock agent-browser CLI. The helper validates
# the native launch response and serializes the possible fresh launch. Only a
# busy desktop-control lease is tolerated, and only on a screen that answers:
# Live is for looking at the screen, Chrome is only needed for browser actions.
browser=ready
if ! desktop-browser ensure >"$live/browser.json.tmp" 8>&-; then
  code=$(python3 -c 'import json,sys
lines=[l for l in sys.stdin.read().splitlines() if l.strip()]
v=json.loads(lines[-1]) if lines else None
print(v.get("code","") if isinstance(v,dict) and v.get("ok") is False else "")' <"$live/browser.json.tmp" 2>/dev/null || true)
  if [ "$code" = CONTROL_BUSY ] && screen_ready; then
    browser=busy
  else
    cat "$live/browser.json.tmp" >&2
    rm -f "$live/browser.json.tmp"
    echo "desktop-live: the managed browser failed (${code:-unknown}); the screen was not shared" >&2
    exit 1
  fi
fi
mv -f "$live/browser.json.tmp" "$live/browser.json"
printf '%s: localhost:5900\n' "$1" >"$live/tokens.tmp"
mv -f "$live/tokens.tmp" "$live/tokens"

# x11vnc reads its passwords only at start, so new ones (the hub's secret rotated) need a new
# process. This run only ever stops the x11vnc it recorded itself (PID, start time, display and
# port), never another process with the same name, and records the new passwords only once the new
# process is alive and owns the listener on 127.0.0.1:5900.
proc_start() {
  fields=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  rest=${fields##*) }
  set -f
  # shellcheck disable=SC2086
  set -- $rest
  set +f
  [ "$1" != Z ] || return 1
  printf '%s\n' "${20:-}"
}
ours() {
  case "$1" in "" | *[!0-9]*) return 1 ;; esac
  kill -0 "$1" 2>/dev/null || return 1
  [ -n "$2" ] && [ "$(proc_start "$1" || true)" = "$2" ] || return 1
  args=$(tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null) || return 1
  cmd=${args%% *}
  [ "${cmd##*/}" = x11vnc ] || return 1
  case " $args" in *" -display :99 "*) ;; *) return 1 ;; esac
  case " $args" in *" -rfbport 5900 "*) return 0 ;; esac
  return 1
}
owns_listener() {
  # 127.0.0.1:5900 in LISTEN state (0A), then the socket's inode among the process's descriptors.
  inode=$(awk '$2 == "0100007F:170C" && $4 == "0A" { print $10; exit }' /proc/net/tcp 2>/dev/null || true)
  [ -n "$inode" ] || return 1
  for fd in "/proc/$1/fd/"*; do
    [ "$(readlink "$fd" 2>/dev/null || true)" = "socket:[$inode]" ] && return 0
  done
  return 1
}
own_pid=
own_start=
if [ -r "$live/x11vnc.identity" ]; then
  read -r own_pid own_start <"$live/x11vnc.identity" || true
  ours "$own_pid" "$own_start" || own_pid=
fi
if [ -z "$own_pid" ] || [ "$(cat "$live/passwords" 2>/dev/null || true)" != "$2 $3" ] || ! owns_listener "$own_pid"; then
  if [ -n "$own_pid" ]; then
    kill -TERM "$own_pid" 2>/dev/null || true
    for _ in $(seq 50); do ours "$own_pid" "$own_start" || break; sleep 0.1; done
    if ours "$own_pid" "$own_start"; then
      # Keep the identity and the passwords it still uses: the next run stops it again.
      echo "desktop-live: x11vnc ($own_pid) is still stopping; try again" >&2
      exit 75
    fi
  fi
  rm -f "$live/x11vnc.identity"
  x11vnc -display :99 -localhost -rfbport 5900 -forever -shared -noxdamage -quiet \
    -passwd "$2" -viewpasswd "$3" -bg -o /tmp/desktop-x11vnc.log >/dev/null 2>&1 8>&- || true
  new_pid=
  for _ in $(seq 50); do
    for dir in /proc/[0-9]*; do
      pid=${dir##*/}
      [ "$pid" != "$own_pid" ] || continue
      start=$(proc_start "$pid" || true)
      if ours "$pid" "$start" && owns_listener "$pid"; then
        new_pid=$pid new_start=$start
        break
      fi
    done
    [ -z "$new_pid" ] || break
    sleep 0.1
  done
  if [ -z "$new_pid" ]; then
    echo "desktop-live: x11vnc did not start listening on 127.0.0.1:5900" >&2
    exit 1
  fi
  printf '%s %s\n' "$new_pid" "$new_start" >"$live/x11vnc.identity.tmp"
  mv -f "$live/x11vnc.identity.tmp" "$live/x11vnc.identity"
  printf '%s' "$2 $3" >"$live/passwords.tmp"
  mv -f "$live/passwords.tmp" "$live/passwords"
fi
if ! pgrep -f "websockify.* 6080" >/dev/null; then
  websockify --daemon --token-plugin TokenFile --token-source "$live/tokens" 6080 >>/tmp/desktop-websockify.log 2>&1 8>&-
fi
# The screen can go away while this ran; never report it shared without a display behind it.
screen_ready || { echo "desktop-live: the screen stopped answering" >&2; exit 1; }
printf '{"ok":true,"screen":"ready","browser":"%s"}\n' "$browser"
