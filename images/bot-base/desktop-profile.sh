# Every login shell (eve runs commands with `bash -lc`) joins the screen that `desktop` starts.
export DISPLAY=:99 DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/desktop-runtime/bus ACCESSIBILITY_ENABLED=1
