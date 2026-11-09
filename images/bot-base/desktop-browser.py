#!/usr/bin/python3
"""Own the one headed Chrome used by Live and agent-browser.

This module only orchestrates the stock agent-desktop CLI.  It never speaks CDP
itself and never starts a second browser.  The launch response is already
validated by agent-desktop's --cdp implementation; the small state file lets
the browser wrapper reconnect after a sandbox resume.
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
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


RUNTIME = Path(os.environ.get("BUSY_DESKTOP_RUNTIME", "/tmp/desktop-runtime"))
STATE = RUNTIME / "browser.json"
PROFILE = Path(os.environ.get("BUSY_CHROME_PROFILE", str(Path.home() / ".config" / "busy-chrome-profile")))
DESKTOP = os.environ.get("BUSY_DESKTOP_COMMAND", "/usr/local/bin/desktop")
AGENT_BROWSER = os.environ.get("BUSY_AGENT_BROWSER_STOCK_COMMAND", "/opt/busy-tools/node_modules/agent-browser/bin/agent-browser-linux-x64")
CONTROL = os.environ.get("BUSY_DESKTOP_CONTROL_COMMAND", "/usr/local/bin/desktop-control")
APP = "google-chrome"
SESSION = "busy-live"
CHROME = os.environ.get("BUSY_CHROME_COMMAND", "/usr/bin/google-chrome")
GENERATION = RUNTIME / "browser-generation"
LAUNCH_LOCK = RUNTIME / "browser-launch.lock"
LOCAL_HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
LEASE_FD_ENV = "BUSY_DESKTOP_LEASE_FD"
_LEASE: bool | None = None


def emit(value: dict[str, Any], code: int = 0) -> int:
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    return code


def read_state() -> dict[str, Any] | None:
    try:
        value = json.loads(STATE.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def write_state(value: dict[str, Any]) -> None:
    RUNTIME.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(RUNTIME, 0o700)
    temporary = STATE.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":")) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, STATE)


def remove_state() -> None:
    try:
        STATE.unlink()
    except FileNotFoundError:
        pass


def lease_fds() -> tuple[int, ...]:
    """The verified lease descriptor, for children that must prove the lease too."""
    return (int(os.environ[LEASE_FD_ENV]),) if controlled() else ()


def run_desktop(args: list[str]) -> subprocess.CompletedProcess[str]:
    # `desktop` verifies the lease for a mutating call (launch) and closes the
    # descriptor before it starts anything, so Chrome never inherits it.
    return subprocess.run([DESKTOP, *args], text=True, capture_output=True, check=False, pass_fds=lease_fds())


def desktop_version_ok() -> tuple[bool, str]:
    result = run_desktop(["version"])
    if result.returncode != 0:
        return False, result.stderr[-400:].strip() or "agent-desktop is not ready"
    return True, ""


def chrome_processes() -> tuple[bool, list[dict[str, Any]]]:
    # Use the complete inventory rather than `--app chrome`: on Linux the
    # launchable desktop entry is google-chrome while AT-SPI reports chrome.
    # An incomplete inventory is unknown, never proof that it is safe to launch.
    result = run_desktop(["list-apps"])
    if result.returncode != 0:
        return False, []
    try:
        payload = json.loads(result.stdout)
        data = payload.get("data")
        if not isinstance(data, dict) or data.get("complete") is False:
            return False, []
        apps = data.get("apps")
        if not isinstance(apps, list):
            return False, []
        # AT-SPI can retain a just-closed app row for a short interval. A dead
        # or zombie PID is not evidence of an unmanaged Chrome; ignore it so
        # graceful stop followed immediately by ensure can relaunch. A live
        # unknown PID remains a hard BROWSER_UNMANAGED failure.
        return True, [app for app in apps if isinstance(app, dict) and process_alive(app.get("pid")) and is_chrome_app(app)]
    except json.JSONDecodeError:
        return False, []


def is_chrome_app(app: dict[str, Any]) -> bool:
    names = [app.get("name"), app.get("bundle_id"), app.get("app")]
    if any(isinstance(value, str) and "chrome" in value.lower() for value in names):
        return True
    # Under Rosetta the AT-SPI display name can be `rosetta`; use the native
    # process command line to identify an already-running Chrome safely.
    cmdline = process_cmdline(app.get("pid"))
    return bool(cmdline and any("chrome" in part.lower() for part in cmdline))


def app_name(app: dict[str, Any]) -> str:
    value = app.get("name") or app.get("app")
    return value if isinstance(value, str) and value else APP


def process_alive(pid: Any) -> bool:
    if not isinstance(pid, int) or pid <= 1:
        return False
    try:
        stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
        fields = stat.rsplit(") ", 1)[-1].split()
        if fields and fields[0] == "Z":
            return False
    except (FileNotFoundError, OSError, IndexError):
        pass
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def process_starttime(pid: Any) -> str | None:
    """Linux proc start tick, which distinguishes PID reuse after a resume."""
    if not isinstance(pid, int) or pid <= 1:
        return None
    try:
        fields = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8").rsplit(") ", 1)[-1].split()
        # The tail begins at field 3 (state), so field 22/starttime is index 19.
        return fields[19] if len(fields) > 19 else None
    except (FileNotFoundError, OSError, IndexError):
        # Unit tests run on macOS, where procfs is absent. Native Linux images
        # always get this extra identity check.
        return None


def process_cmdline(pid: Any) -> list[str] | None:
    if not isinstance(pid, int) or pid <= 1:
        return None
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
        return [part.decode("utf-8", "replace") for part in raw.split(b"\0") if part]
    except (FileNotFoundError, OSError):
        return None


def private_profile(path: Any) -> bool:
    if not isinstance(path, str):
        return False
    profile = Path(path)
    try:
        profile.relative_to(Path.home())
    except ValueError:
        return False
    return "/data" not in profile.parts and profile == PROFILE


def managed_process(value: dict[str, Any]) -> bool:
    if not private_profile(value.get("profile")):
        return False
    pid = value.get("pid")
    if not (isinstance(pid, int) and process_alive(pid) and isinstance(value.get("process_instance"), str) and value["process_instance"]):
        return False
    expected_start = value.get("pid_starttime")
    current_start = process_starttime(pid)
    if current_start is not None and expected_start != current_start:
        return False
    profile_arg = f"--user-data-dir={value['profile']}"
    # Chrome may rewrite argv into one NUL-delimited entry. Preserve the
    # private-profile ownership check while accepting either argv shape.
    cmdline = process_cmdline(value.get("pid"))
    if cmdline is None:
        return process_alive(value.get("pid"))
    if profile_arg in cmdline:
        return True
    joined = "\0".join(cmdline)
    return re.search(rf"(?:^|[\s\0]){re.escape(profile_arg)}(?=$|[\s\0])", joined) is not None


def endpoint_state(value: dict[str, Any]) -> bool:
    cdp = value.get("cdp")
    if not isinstance(cdp, dict):
        return False
    port = cdp.get("port")
    websocket_url = cdp.get("websocket_url")
    http_endpoint = cdp.get("http_endpoint")
    if not isinstance(port, int) or not 1 <= port <= 65535:
        return False
    if not isinstance(websocket_url, str) or not isinstance(http_endpoint, str):
        return False
    websocket = urlparse(websocket_url)
    http = urlparse(http_endpoint)
    if websocket.scheme != "ws" or websocket.hostname not in {"127.0.0.1", "localhost"} or websocket.port != port:
        return False
    if http.scheme != "http" or http.hostname not in {"127.0.0.1", "localhost"} or http.port != port:
        return False
    pid = value.get("pid")
    process_instance = value.get("process_instance")
    if not (isinstance(pid, int) and process_alive(pid) and isinstance(process_instance, str) and bool(process_instance)):
        return False
    expected_start = value.get("pid_starttime")
    current_start = process_starttime(pid)
    return current_start is None or (isinstance(expected_start, str) and expected_start == current_start)


def cdp_healthy(value: dict[str, Any], timeout: float = 0.35) -> bool:
    """Probe native agent-desktop's verified loopback endpoint, not raw CDP."""
    if not endpoint_state(value):
        return False
    cdp = value["cdp"]
    http_endpoint = str(cdp["http_endpoint"]).rstrip("/")
    expected = urlparse(str(cdp["websocket_url"]))
    try:
        with LOCAL_HTTP.open(f"{http_endpoint}/json/version", timeout=timeout) as response:
            payload = json.loads(response.read(64 * 1024).decode("utf-8"))
        reported = payload.get("webSocketDebuggerUrl") if isinstance(payload, dict) else None
        if not isinstance(reported, str):
            return False
        actual = urlparse(reported)
        return (
            actual.scheme == "ws"
            and actual.hostname in {"127.0.0.1", "localhost"}
            and actual.port == expected.port
            and actual.path == expected.path
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError, urllib.error.URLError):
        return False


def fast_state() -> dict[str, Any] | None:
    value = read_state()
    # State was written only after native launch verified the process identity;
    # PID/starttime/process_instance plus the private profile path are enough
    # for the hot path. The stricter cmdline profile check remains for stop.
    if value and private_profile(value.get("profile")) and endpoint_state(value) and cdp_healthy(value):
        return value
    return None


def managed_state() -> dict[str, Any] | None:
    value = read_state()
    if value and endpoint_state(value):
        return value
    if value:
        remove_state()
    return None


def next_generation() -> int:
    try:
        previous = int(GENERATION.read_text(encoding="utf-8").strip())
    except (FileNotFoundError, OSError, ValueError):
        previous = 0
    value = previous + 1
    RUNTIME.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = GENERATION.with_suffix(".tmp")
    temporary.write_text(f"{value}\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, GENERATION)
    return value


def control_generation() -> int:
    try:
        payload = json.loads((RUNTIME / "control.json").read_text(encoding="utf-8"))
        value = payload.get("generation", 0)
        return int(value) if isinstance(value, int) else 0
    except (FileNotFoundError, OSError, json.JSONDecodeError, ValueError):
        return 0


def browser_session(value: dict[str, Any] | None = None) -> str:
    return SESSION


def inventory_matches(value: dict[str, Any], apps: list[dict[str, Any]]) -> bool:
    pid = value.get("pid")
    instance = value.get("process_instance")
    saved_app = value.get("app")
    for app in apps:
        if app.get("pid") == pid and app.get("process_instance") == instance:
            # Rosetta/Linux accessibility can report the process as `rosetta`
            # even though launch returned google-chrome. PID + process_instance
            # is the native identity; do not reject it on display name.
            return True
    return False


def controlled() -> bool:
    """Whether this process inherited desktop-control's locked descriptor.

    Asked once per process: desktop-control checks that the descriptor is the
    action lock and that it is the one holding it. No environment variable on
    its own counts as the lease.
    """
    global _LEASE
    if _LEASE is None:
        raw = os.environ.get(LEASE_FD_ENV, "")
        _LEASE = False
        if raw.isdigit() and Path(CONTROL).is_file():
            try:
                result = subprocess.run([CONTROL, "verify-lease"], check=False, pass_fds=(int(raw),), capture_output=True)
                _LEASE = result.returncode == 0
            except OSError:
                _LEASE = False
    return _LEASE


def invoke_controlled(argv: list[str]) -> int:
    """Run this helper under the same kernel lease as desktop/agent-browser."""
    command = [sys.executable, str(Path(__file__).resolve()), *argv]
    child_env = os.environ.copy()
    child_env["BUSY_BROWSER_LAUNCH_LOCKED"] = "1"
    if controlled() or not Path(CONTROL).is_file():
        return subprocess.run(command, env=child_env, check=False, pass_fds=lease_fds()).returncode
    return subprocess.run([CONTROL, "run", "--pass-lease", "--", *command], env=child_env, check=False).returncode


class BrowserLaunchLock:
    def __enter__(self) -> "BrowserLaunchLock":
        RUNTIME.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(RUNTIME, 0o700)
        self.fd = os.open(LAUNCH_LOCK, os.O_CREAT | os.O_RDWR, 0o600)
        os.chmod(LAUNCH_LOCK, 0o600)
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        return self

    def __exit__(self, *_: object) -> None:
        fcntl.flock(self.fd, fcntl.LOCK_UN)
        os.close(self.fd)


def current_state(verify_inventory: bool = True) -> tuple[dict[str, Any] | None, str | None]:
    value = read_state()
    if not value:
        return None, None
    if not endpoint_state(value) or not cdp_healthy(value):
        remove_state()
        return None, None
    if not verify_inventory:
        return value, None
    inventory_ok, apps = chrome_processes()
    if not inventory_ok:
        return None, "agent-desktop returned no complete Chrome inventory"
    if not inventory_matches(value, apps):
        # Never close a replacement process under a stale state file.
        remove_state()
        return None, None
    return value, None


def launch() -> int:
    ready, detail = desktop_version_ok()
    if not ready:
        return emit({"ok": False, "error": detail, "code": "BROWSER_DESKTOP_UNREADY"}, 1)
    inventory_ok, existing = chrome_processes()
    if not inventory_ok:
        return emit(
            {
                "ok": False,
                "error": "agent-desktop returned no complete Chrome inventory",
                "code": "BROWSER_DESKTOP_UNREADY",
            },
            1,
        )
    if existing:
        return emit(
            {
                "ok": False,
                "error": "Chrome is already running without a managed CDP endpoint",
                "code": "BROWSER_UNMANAGED",
            },
            1,
        )

    PROFILE.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(PROFILE, 0o700)
    args = [
        "launch",
        # The image's Linux desktop entry is a real executable alias. Passing
        # the bare `chrome` display name makes agent-desktop classify it as an
        # existing app and fail the required fresh --cdp launch.
        "/usr/bin/google-chrome",
        "--cdp",
        "--timeout",
        "30000",
        "--env",
        "ACCESSIBILITY_ENABLED=1",
        "--arg=--force-renderer-accessibility",
        "--arg=--no-first-run",
        "--arg=--start-maximized",
        "--arg=--hide-crash-restore-bubble",
        f"--arg=--user-data-dir={PROFILE}",
    ]
    result = run_desktop(args)
    if result.returncode != 0:
        return emit(
            {
                "ok": False,
                "error": "managed Chrome could not be launched",
                "code": "BROWSER_LAUNCH_FAILED",
                "detail": result.stderr[-400:].strip(),
            },
            1,
        )
    try:
        payload = json.loads(result.stdout)
        data = payload.get("data")
    except json.JSONDecodeError:
        data = None
    if not isinstance(data, dict) or not isinstance(data.get("cdp"), dict):
        return emit({"ok": False, "error": "launch returned no verified CDP endpoint", "code": "BROWSER_ENDPOINT_INVALID"}, 1)
    if not isinstance(data.get("app"), str):
        # Native launch output names the app that close-app must later target;
        # keep the known image entry only as a compatibility fallback.
        app = APP
    else:
        app = data["app"]
    state = {
        "app": app,
        "pid": data.get("pid"),
        "process_instance": data.get("process_instance"),
        "pid_starttime": process_starttime(data.get("pid")),
        "cdp": data["cdp"],
        "profile": str(PROFILE),
        "startedAt": int(time.time() * 1000),
        "generation": next_generation(),
    }
    if not endpoint_state(state):
        return emit({"ok": False, "error": "launch endpoint or process identity was invalid", "code": "BROWSER_ENDPOINT_INVALID"}, 1)
    write_state(state)
    return emit({"ok": True, **state})


def ensure_inner() -> int:
    state = fast_state()
    if state:
        return emit({"ok": True, **state})
    ready, detail = desktop_version_ok()
    if not ready:
        return emit({"ok": False, "error": detail, "code": "BROWSER_DESKTOP_UNREADY"}, 1)
    state, error = current_state()
    if error:
        return emit({"ok": False, "error": error, "code": "BROWSER_DESKTOP_UNREADY"}, 1)
    if state:
        return emit({"ok": True, **state})
    if not controlled():
        return invoke_controlled(["ensure"])
    return launch()


def ensure() -> int:
    # A healthy managed browser is a read-only result and remains available
    # while a viewer holds the manual lease. Only the no-state fresh launch is
    # put under desktop-control. The child invoked through desktop-control
    # inherits BUSY_BROWSER_LAUNCH_LOCKED so it does not take this descriptor a
    # second time.
    if os.environ.get("BUSY_BROWSER_LAUNCH_LOCKED") == "1":
        return ensure_inner()
    # The common healthy case needs no lock and no lease check.
    state = fast_state()
    if state:
        return emit({"ok": True, **state})
    if controlled():
        # desktop-control's action lock is already held by the caller. Taking
        # BrowserLaunchLock here would reverse the lock order with an unguarded
        # desktop-live ensure that is waiting for that action lock.
        os.environ["BUSY_BROWSER_LAUNCH_LOCKED"] = "1"
        try:
            return ensure_inner()
        finally:
            os.environ.pop("BUSY_BROWSER_LAUNCH_LOCKED", None)
    state = fast_state()
    if state:
        return emit({"ok": True, **state})
    ready, detail = desktop_version_ok()
    if not ready:
        return emit({"ok": False, "error": detail, "code": "BROWSER_DESKTOP_UNREADY"}, 1)
    state, error = current_state()
    if error:
        return emit({"ok": False, "error": error, "code": "BROWSER_DESKTOP_UNREADY"}, 1)
    if state:
        return emit({"ok": True, **state})
    with BrowserLaunchLock():
        if not controlled():
            return invoke_controlled(["ensure"])
        os.environ["BUSY_BROWSER_LAUNCH_LOCKED"] = "1"
        try:
            return ensure_inner()
        finally:
            os.environ.pop("BUSY_BROWSER_LAUNCH_LOCKED", None)


def stop() -> int:
    # Do not call desktop here: stop is used immediately before suspending the
    # sandbox and must not wake X/AT-SPI just to find a stale app alias.
    state = read_state()
    if not state:
        remove_state()
        return emit({"ok": True, "stopped": False})
    if not managed_process(state):
        remove_state()
        return emit({"ok": True, "stopped": False, "reason": "managed process is no longer running"})
    pid = int(state["pid"])
    try:
        os.kill(pid, 15)
    except ProcessLookupError:
        remove_state()
        return emit({"ok": True, "stopped": False})
    deadline = time.monotonic() + 8
    while process_alive(pid) and time.monotonic() < deadline:
        time.sleep(0.1)
    if process_alive(pid):
        return emit({"ok": False, "error": "managed Chrome did not exit after graceful stop", "code": "BROWSER_STOP_FAILED"}, 1)
    remove_state()
    return emit({"ok": True, "stopped": True})


def manual_lease_active() -> bool:
    try:
        value = json.loads((RUNTIME / "control.json").read_text(encoding="utf-8"))
        return isinstance(value.get("owner"), str) and int(value.get("expiresAt", 0)) > int(time.time() * 1000)
    except (FileNotFoundError, OSError, json.JSONDecodeError, TypeError, ValueError):
        return False


def human_open(urls: list[str]) -> int:
    """Hand URLs to the already managed headed Chrome for a human launcher."""
    for url in urls:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return emit({"ok": False, "error": "only http(s) URLs are accepted", "code": "INVALID_URL"}, 2)
    state = fast_state()
    if not state:
        # Launching Chrome needs the action lease. The person holding manual
        # control gets it through desktop-control's human-open (one fixed
        # command); anyone else through the ordinary agent lease.
        if not controlled() and Path(CONTROL).is_file():
            if manual_lease_active():
                return subprocess.run([CONTROL, "human-open", *urls], check=False).returncode
            return invoke_controlled(["human-open", *urls])
        result = ensure()
        if result != 0:
            return result
        state = fast_state()
    if not state:
        return emit({"ok": False, "error": "managed Chrome is not healthy", "code": "BROWSER_ENDPOINT_UNAVAILABLE"}, 1)
    result = subprocess.run(
        [
            CHROME,
            f"--user-data-dir={PROFILE}",
            "--force-renderer-accessibility",
            "--no-first-run",
            "--start-maximized",
            "--hide-crash-restore-bubble",
            *urls,
        ],
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return emit({"ok": False, "error": "Chrome rejected the human launcher request", "code": "BROWSER_HUMAN_OPEN_FAILED"}, 1)
    return emit({"ok": True, "opened": urls, "pid": state.get("pid")})


def open_url(urls: list[str]) -> int:
    for url in urls:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return emit({"ok": False, "error": "only http(s) URLs are accepted", "code": "INVALID_URL"}, 2)
    state, error = current_state()
    if error:
        return emit({"ok": False, "error": error, "code": "BROWSER_DESKTOP_UNREADY"}, 1)
    if not state:
        result = ensure()
        if result != 0:
            return result
        state, error = current_state()
        if error or not state:
            return emit({"ok": False, "error": error or "managed Chrome is not running", "code": "BROWSER_ENDPOINT_UNAVAILABLE"}, 1)
    if not urls:
        return emit({"ok": True, **state})
    for url in urls:
        result = subprocess.run(
            [
                AGENT_BROWSER,
                "--json",
                "--session",
                browser_session(state),
                "--cdp",
                str(state["cdp"]["websocket_url"]),
                "--headed",
                "--pin-tab",
                "open",
                url,
            ],
            text=True,
            check=False,
        )
        if result.returncode != 0:
            return result.returncode
    return 0


def cdp_url() -> str:
    state = managed_state()
    if not state:
        raise RuntimeError("managed Chrome is not running")
    cdp = state["cdp"]
    return str(cdp["websocket_url"])


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["ensure", "stop", "open", "human-open", "state"])
    parser.add_argument("url", nargs="*")
    args = parser.parse_args(argv)
    try:
        if args.action == "ensure":
            return ensure()
        if args.action == "stop":
            if not controlled() and Path(CONTROL).is_file():
                return invoke_controlled(["stop"])
            return stop()
        if args.action == "state":
            value = managed_state()
            return emit({"ok": bool(value), **(value or {})}, 0 if value else 1)
        if args.action == "human-open":
            return human_open(args.url)
        if args.action == "open" and not controlled() and Path(CONTROL).is_file():
            return invoke_controlled(["open", *args.url])
        return open_url(args.url)
    except RuntimeError as error:
        return emit({"ok": False, "error": str(error), "code": "BROWSER_ENDPOINT_UNAVAILABLE"}, 1)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
