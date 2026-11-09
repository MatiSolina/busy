#!/usr/bin/python3
# desktop-a11y: holds an AT-SPI listener for window:activate open for as long as the screen is up.
# agent-desktop registers that listener on every call and drops it when it exits, and Chrome 156
# crashes (SIGSEGV) when that happens while it handles a key: every `desktop press` took Chrome down.
# With this one always registered, agent-desktop's come and go and Chrome never notices.
# `desktop` starts it. Baked into the bot base image as /usr/local/bin/desktop-a11y.
import atexit
import os
from pathlib import Path
import signal
import sys

import dbus

ready = Path(os.environ.get("BUSY_A11Y_READY_FILE", str(Path(os.environ.get("XDG_RUNTIME_DIR", "/tmp/desktop-runtime")) / "a11y-ready")))


def process_starttime() -> str:
    try:
        fields = Path(f"/proc/{os.getpid()}/stat").read_text(encoding="utf-8").rsplit(") ", 1)[-1].split()
        return fields[19] if len(fields) > 19 else ""
    except (FileNotFoundError, OSError, IndexError):
        return ""


def clear_ready() -> None:
    try:
        ready.unlink()
    except FileNotFoundError:
        pass


def stop(signum: int, _frame: object) -> None:
    clear_ready()
    raise SystemExit(128 + signum)


atexit.register(clear_ready)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
clear_ready()

try:
    address = dbus.SessionBus().get_object("org.a11y.Bus", "/org/a11y/bus").GetAddress(dbus_interface="org.a11y.Bus")
    registry = dbus.bus.BusConnection(address).get_object("org.a11y.atspi.Registry", "/org/a11y/atspi/registry")
    registry.RegisterEvent("window:activate", dbus.Array([], signature="s"), "", dbus_interface="org.a11y.atspi.Registry")
    ready.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    ready.write_text(f"{os.getpid()}:{process_starttime()}\n", encoding="utf-8")
    os.chmod(ready, 0o600)
except Exception as error:
    print(f"desktop-a11y: could not register listener: {error}", file=sys.stderr)
    raise SystemExit(1)

# The registry drops the listener when this connection closes: stay.
signal.pause()
