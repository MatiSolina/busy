#!/usr/bin/python3
"""Small local lease used by the visible desktop and browser wrappers.

The helper deliberately owns no browser or desktop protocol.  It only serializes
manual control against one agent CLI invocation and keeps the lease durable for
the lifetime of the runtime directory.

`run` hands the command proof that it holds the lease: the locked descriptor
itself, on fd LEASE_FD, named by BUSY_DESKTOP_LEASE_FD. Wrappers call
`verify-lease`, which checks that the descriptor is the action lock file and
that its open file description is the one holding the kernel lock. An
environment variable on its own (BUSY_DESKTOP_CONTROLLED, the old marker) no
longer lets anything skip the lease.

This is cooperative coordination between the wrappers, not a security
boundary: every process in the sandbox runs as the same user and can open the
lock file, call agent-desktop or the stock agent-browser binary, or talk to
X11, AT-SPI or the CDP port directly. See docs/acceptance.md (H-20).
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


TTL_MS = 75_000
OWNER_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
READ_ONLY_DESKTOP = {
    "find",
    "get",
    "is",
    "list-apps",
    "list-displays",
    "list-surfaces",
    "list-windows",
    "screenshot",
    "snapshot",
    "status",
    "trace",
    "version",
    "wait",
}
FREE_COMMANDS = {"doctor", "help", "skills", "version"}
# The descriptor `run` passes to its command; single digit so sh can close it.
LEASE_FD = 7
LEASE_ENV = "BUSY_DESKTOP_LEASE_FD"
# Set by `human-open` only: the lease was taken for a person's launcher while
# that person holds manual control, so an active owner is expected.
LEASE_MODE_ENV = "BUSY_DESKTOP_LEASE_MODE"
DESKTOP_BROWSER = os.environ.get("BUSY_DESKTOP_BROWSER_COMMAND", "/usr/local/bin/desktop-browser")
# Markers that must never reach a command as if they were authorization.
SCRUBBED_ENV = ("BUSY_DESKTOP_CONTROLLED", "BUSY_BROWSER_WRAPPER_CONTROLLED", LEASE_ENV, LEASE_MODE_ENV)


def runtime_dir() -> Path:
    return Path(os.environ.get("BUSY_DESKTOP_RUNTIME", "/tmp/desktop-runtime"))


def control_path() -> Path:
    return runtime_dir() / "control.json"


def lock_path() -> Path:
    return runtime_dir() / "control.lock"


def action_lock_path() -> Path:
    # This descriptor stays locked for the complete agent subprocess. Unlike a
    # counter in control.json it is released by the kernel after SIGKILL/crash.
    return runtime_dir() / "agent-action.lock"


def now_ms() -> int:
    return int(time.time() * 1000)


def empty_state() -> dict[str, Any]:
    return {"generation": 0}


def read_state() -> dict[str, Any]:
    try:
        raw = json.loads(control_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return empty_state()
    if not isinstance(raw, dict):
        return empty_state()
    state = empty_state()
    state.update(raw)
    # Older images persisted this counter. It cannot be trusted after a killed
    # process, so the file lock below is the only source of truth now.
    state.pop("agentInFlight", None)
    return state


def write_state(state: dict[str, Any]) -> None:
    runtime_dir().mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = control_path().with_suffix(".tmp")
    tmp.write_text(json.dumps(state, separators=(",", ":")) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, control_path())


class LockedState:
    def __enter__(self) -> dict[str, Any]:
        runtime_dir().mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(runtime_dir(), 0o700)
        self.fd = os.open(lock_path(), os.O_CREAT | os.O_RDWR, 0o600)
        os.chmod(lock_path(), 0o600)
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        self.state = read_state()
        self.expire_if_needed()
        return self.state

    def expire_if_needed(self) -> None:
        expires = self.state.get("expiresAt")
        if isinstance(expires, int) and expires <= now_ms():
            self.state.pop("owner", None)
            self.state.pop("expiresAt", None)
            self.state["generation"] = int(self.state.get("generation", 0)) + 1
            invalidate_overlay_session()

    def __exit__(self, *_: object) -> None:
        write_state(self.state)
        fcntl.flock(self.fd, fcntl.LOCK_UN)
        os.close(self.fd)


class ActionLock:
    """Non-blocking lease over the whole agent command, owned by the kernel."""

    def __enter__(self) -> bool:
        runtime_dir().mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(runtime_dir(), 0o700)
        self.fd = os.open(action_lock_path(), os.O_CREAT | os.O_RDWR, 0o600)
        os.chmod(action_lock_path(), 0o600)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(self.fd)
            self.fd = -1
            return False
        return True

    def __exit__(self, *_: object) -> None:
        if self.fd >= 0:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)


def output(value: dict[str, Any], code: int = 0) -> int:
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    return code


def valid_owner(owner: str) -> bool:
    return bool(OWNER_RE.fullmatch(owner))


def conflict(state: dict[str, Any], message: str, code: str = "CONTROL_BUSY") -> int:
    return output(
        {
            "ok": False,
            "error": message,
            "code": code,
        },
        1,
    )


def invalidate_overlay_session() -> None:
    # desktop-session recreates this on the next desktop call.  Removing only
    # this marker invalidates old refs without touching the persisted profile.
    try:
        (runtime_dir() / "agent-session").unlink()
    except FileNotFoundError:
        pass


def acquire(owner: str) -> int:
    if not valid_owner(owner):
        return output({"ok": False, "error": "invalid viewer uuid", "code": "INVALID_OWNER"}, 2)
    # Acquire in the same order as run(): action lock first, then control.json.
    # This makes the check atomic with respect to an in-flight subprocess.
    with ActionLock() as action_available:
        with LockedState() as state:
            current = state.get("owner")
            if isinstance(current, str) and current != owner:
                return conflict(state, "manual control is already held")
            if not action_available:
                return conflict(state, "an agent desktop action is in flight")
            state["owner"] = owner
            state["expiresAt"] = now_ms() + TTL_MS
            state["generation"] = int(state.get("generation", 0)) + 1
            invalidate_overlay_session()
            return output({"ok": True, "expiresAt": state["expiresAt"]})


def renew(owner: str) -> int:
    if not valid_owner(owner):
        return output({"ok": False, "error": "invalid viewer uuid", "code": "INVALID_OWNER"}, 2)
    with LockedState() as state:
        if state.get("owner") != owner:
            return conflict(state, "manual control lease is not yours", "CONTROL_LOST")
        state["expiresAt"] = now_ms() + TTL_MS
        return output({"ok": True, "expiresAt": state["expiresAt"]})


def release(owner: str) -> int:
    if not valid_owner(owner):
        return output({"ok": False, "error": "invalid viewer uuid", "code": "INVALID_OWNER"}, 2)
    with LockedState() as state:
        if state.get("owner") != owner:
            return conflict(state, "manual control lease is not yours", "CONTROL_LOST")
        state.pop("owner", None)
        state.pop("expiresAt", None)
        state["generation"] = int(state.get("generation", 0)) + 1
        invalidate_overlay_session()
        # The hub treats release like the other lease calls and expects the same
        # machine-readable shape. Zero means that no lease remains.
        return output({"ok": True, "expiresAt": 0})


def invalidate() -> int:
    """Invalidate native/browser observations after a screen or process restart."""
    with LockedState() as state:
        state["generation"] = int(state.get("generation", 0)) + 1
        invalidate_overlay_session()
        return output({"ok": True, "generation": state["generation"]})


def state() -> int:
    """Return local coordination state for wrappers, never for the hub API."""
    with ActionLock() as action_available:
        with LockedState() as current:
            value = {
                "ok": True,
                "generation": int(current.get("generation", 0)),
                "agentInFlight": 0 if action_available else 1,
            }
            owner = current.get("owner")
            expires = current.get("expiresAt")
            if isinstance(owner, str) and isinstance(expires, int):
                value.update({"owner": owner, "expiresAt": expires})
            return output(value)


# Runs in a child that keeps the lock even if this helper is killed. It closes
# every other descriptor in the command, so daemons the command starts cannot
# retain the lease after it exits. Only with --pass-lease (the wrappers) does
# the command also get the lock on LEASE_FD as proof; those wrappers verify it
# and close it before they start anything long-lived.
SUPERVISOR = (
    "import os,subprocess,sys\n"
    "fd=int(sys.argv[1]);target=int(sys.argv[2])\n"
    "fds=()\n"
    "if target>=0:\n"
    "    os.dup2(fd,target);fds=(target,)\n"
    "sys.exit(subprocess.run(sys.argv[3:],close_fds=True,pass_fds=fds).returncode)"
)


def lease_env(pass_lease: bool, mode: str | None = None) -> dict[str, str]:
    environment = {key: value for key, value in os.environ.items() if key not in SCRUBBED_ENV}
    if pass_lease:
        environment[LEASE_ENV] = str(LEASE_FD)
        if mode:
            environment[LEASE_MODE_ENV] = mode
    return environment


def supervise(action_lock: ActionLock, command: list[str], pass_lease: bool, mode: str | None = None) -> int:
    completed = subprocess.run(
        [sys.executable, "-c", SUPERVISOR, str(action_lock.fd), str(LEASE_FD if pass_lease else -1), *command],
        check=False,
        env=lease_env(pass_lease, mode),
        pass_fds=(action_lock.fd,),
    )
    return completed.returncode


def run(command: list[str], pass_lease: bool = False) -> int:
    if not command:
        return output({"ok": False, "error": "missing command", "code": "INVALID_ARGS"}, 2)
    action_lock = ActionLock()
    with action_lock as action_available:
        if not action_available:
            with LockedState() as state:
                return conflict(state, "an agent desktop action is in flight")
        with LockedState() as state:
            if state.get("owner"):
                return conflict(state, "manual control is active")
        return supervise(action_lock, command, pass_lease)


def manual_owner_active() -> bool:
    current = read_state()
    owner = current.get("owner")
    expires = current.get("expiresAt")
    return isinstance(owner, str) and isinstance(expires, int) and expires > now_ms()


def human_open(urls: list[str]) -> int:
    """Launch the managed Chrome for the person holding manual control.

    The taskbar/XDG launcher runs while a viewer holds the lease, when `run`
    refuses. This takes the action lock for one fixed command only, and only
    while a manual owner exists.
    """
    if not manual_owner_active():
        return output({"ok": False, "error": "no manual control is active", "code": "CONTROL_LOST"}, 1)
    action_lock = ActionLock()
    with action_lock as action_available:
        if not action_available:
            with LockedState() as state:
                return conflict(state, "an agent desktop action is in flight")
        return supervise(action_lock, [DESKTOP_BROWSER, "human-open", *urls], True, mode="manual")


def lease_held() -> bool:
    """Whether the caller inherited the descriptor that holds the action lock."""
    raw = os.environ.get(LEASE_ENV, "")
    if not raw.isdigit():
        return False
    fd = int(raw)
    try:
        inherited = os.fstat(fd)
        expected = os.stat(action_lock_path())
    except OSError:
        return False
    if (inherited.st_dev, inherited.st_ino) != (expected.st_dev, expected.st_ino):
        return False
    # Someone must hold the lock: a fresh descriptor cannot take it...
    probe = os.open(action_lock_path(), os.O_RDWR)
    try:
        try:
            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            fcntl.flock(probe, fcntl.LOCK_UN)
            return False
    finally:
        os.close(probe)
    # ...and that someone is the inherited open file description: re-locking it
    # succeeds only for the holder (flock locks belong to the description).
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (BlockingIOError, OSError):
        return False
    # A manual takeover cannot start while the action lock is held; one that
    # was already active is only compatible with the human launcher.
    if os.environ.get(LEASE_MODE_ENV) == "manual":
        return manual_owner_active()
    return not manual_owner_active()


def verify_lease() -> int:
    # Silent, like is-read-only: callers use the exit status as a guard.
    return 0 if lease_held() else 1


def command_name(args: list[str]) -> str | None:
    value_options = {"--session", "--agent-id", "--trace", "--timeout-ms", "--max-depth", "--root"}
    skip_value = False
    for item in args:
        if skip_value:
            skip_value = False
            continue
        if item in value_options:
            skip_value = True
            continue
        if item.startswith("--"):
            continue
        return item
    return None


def desktop_read_only(args: list[str]) -> bool:
    if not args or any(item in {"--help", "-h"} for item in args):
        return True
    name = command_name(args)
    if name in READ_ONLY_DESKTOP:
        return True
    if name in {"permissions"} and "--request" not in args:
        return True
    return False


def is_read_only(args: list[str]) -> int:
    # This is intentionally silent: desktop.sh uses the exit status as a guard,
    # and any stdout here would corrupt agent-desktop's JSON response.
    return 0 if desktop_read_only(args) else 1


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    sub = parser.add_subparsers(dest="action")
    for action in ("acquire", "renew", "release"):
        child = sub.add_parser(action)
        child.add_argument("owner")
    sub.add_parser("invalidate")
    sub.add_parser("state")
    child = sub.add_parser("is-read-only")
    child.add_argument("command", nargs=argparse.REMAINDER)
    sub.add_parser("verify-lease")
    child = sub.add_parser("human-open")
    child.add_argument("urls", nargs="*")
    child = sub.add_parser("run")
    child.add_argument("--read-only", action="store_true")
    child.add_argument("--pass-lease", action="store_true")
    child.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if args.action == "acquire":
        return acquire(args.owner)
    if args.action == "renew":
        return renew(args.owner)
    if args.action == "release":
        return release(args.owner)
    if args.action == "invalidate":
        return invalidate()
    if args.action == "state":
        return state()
    if args.action == "is-read-only":
        return is_read_only(list(args.command))
    if args.action == "verify-lease":
        return verify_lease()
    if args.action == "human-open":
        return human_open(list(args.urls))
    if args.action == "run":
        command = list(args.command)
        if command[:1] == ["--"]:
            command = command[1:]
        return run(command, bool(args.pass_lease))
    return output({"ok": False, "error": "missing action", "code": "INVALID_ARGS"}, 2)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
