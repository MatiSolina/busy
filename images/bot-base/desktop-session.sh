#!/bin/sh
# desktop-session: the desktop people see in the hub's live screen, over openbox: a taskbar (tint2)
# with Chrome, Terminal and Files, and the file manager's desktop with a shortcut to the bot's files.
# `desktop` runs it once the screen is up; it starts only what is missing, like `desktop` itself.
# Baked into the bot base image as /usr/local/bin/desktop-session, with its settings in
# /usr/local/share/busy-desktop (images/bot-base/desktop).
set -u
export DISPLAY=:99
share=/usr/local/share/busy-desktop
# The taskbar launcher is also the system handler for web links. Install the
# managed entry once per profile so LibreOffice/Files/XDG launches converge on
# the same visible Chrome instead of the distro's standalone Chrome desktop id.
xdg_data=${XDG_DATA_HOME:-$HOME/.local/share}
xdg_apps=$xdg_data/applications
xdg_marker=$xdg_data/busy-desktop/xdg-version
if [ ! -e "$xdg_apps/busy-chrome.desktop" ] || [ "$(cat "$xdg_marker" 2>/dev/null || true)" != "3" ]; then
  mkdir -p "$xdg_apps" "$xdg_data/busy-desktop"
  cp "$share/applications/busy-chrome.desktop" "$xdg_apps/busy-chrome.desktop"
  if command -v xdg-mime >/dev/null 2>&1; then
    xdg-mime default busy-chrome.desktop x-scheme-handler/http >/dev/null 2>&1 || true
    xdg-mime default busy-chrome.desktop x-scheme-handler/https >/dev/null 2>&1 || true
    xdg-mime default busy-chrome.desktop text/html >/dev/null 2>&1 || true
    printf '%s\n' "3" >"$xdg_marker"
  fi
fi
# First boot of this computer: the desktop's settings, and the bot's files on the desktop.
if [ ! -e "$HOME/.config/pcmanfm" ]; then
  mkdir -p "$HOME/.config" "$HOME/Desktop"
  cp -R "$share/config/." "$HOME/.config/"
  ln -sfn /data "$HOME/Desktop/Bot files"
fi
# The clock shows Mati's time, not the sandbox's UTC.
pgrep -x tint2 >/dev/null || (TZ=America/Argentina/Buenos_Aires tint2 >/tmp/desktop-tint2.log 2>&1 &)
pgrep -x pcmanfm >/dev/null || (pcmanfm --desktop >/tmp/desktop-pcmanfm.log 2>&1 &)
# The cursor that shows what the bot does: an agent-desktop session with its overlay on, which
# `desktop` hands every command. Started once per screen (`desktop` drops it with the old screen).
session=${XDG_RUNTIME_DIR:-/tmp/desktop-runtime}/agent-session
[ -s "$session" ] || agent-desktop session start --name busy --cursor | sed -n 's/.*"session_id":"\([^"]*\)".*/\1/p' >"$session"
