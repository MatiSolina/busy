#!/usr/bin/python3
"""Guarded entry point for the pinned stock agent-browser binary.

The wrapper deliberately contains no browser engine. It asks desktop-browser for
the managed agent-desktop CDP handoff, then delegates the user's command to the
real 0.41.1 CLI while holding desktop-control's kernel lease.
"""

from __future__ import annotations

import hashlib
import json
import os
import posixpath
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


STOCK = os.environ.get("BUSY_AGENT_BROWSER_STOCK_COMMAND", "/opt/busy-tools/node_modules/agent-browser/bin/agent-browser-linux-x64")
DESKTOP_BROWSER = os.environ.get("BUSY_DESKTOP_BROWSER_COMMAND", "/usr/local/bin/desktop-browser")
CONTROL = os.environ.get("BUSY_DESKTOP_CONTROL_COMMAND", "/usr/local/bin/desktop-control")
RUNTIME = Path(os.environ.get("BUSY_DESKTOP_RUNTIME", "/tmp/desktop-runtime"))
# One observation record per agent-browser session: a snapshot of session A
# never authorizes a mutation in session B.
OBSERVATIONS = RUNTIME / "browser-observations"
SESSION = "busy-live"
# Options that would point the stock CLI at another browser than the managed
# endpoint, in either spelling. 0.41.1 parses `--flag value` before and after
# the command and ignores or rejects `--flag=value`; both are refused here so
# that neither a real override nor a silently ignored one gets through.
TARGET_FLAGS = ("--cdp", "--auto-connect", "--no-pin-tab", "--provider")
# Environment the stock CLI reads as the same overrides. The wrapper sets
# AGENT_BROWSER_CDP itself from the managed state.
TARGET_ENV = ("AGENT_BROWSER_CDP", "AGENT_BROWSER_AUTO_CONNECT", "AGENT_BROWSER_PROVIDER", "AGENT_BROWSER_SESSION", "AGENT_BROWSER_PIN_TAB")
LAST_ERROR = ""
LEASE_FD_ENV = "BUSY_DESKTOP_LEASE_FD"
_LEASE: bool | None = None
LAST_ERROR_CODE = ""

# ``batch`` is intentionally a small declarative surface.  Keep this list in
# the wrapper as well as in the Eve tool: the wrapper is the last trust boundary
# before a model-controlled value reaches agent-browser.
BATCH_DEFAULT_MAX_STEPS = 12
BATCH_MAX_STEPS = 12
BATCH_DEFAULT_MAX_TIME_MS = 30_000
BATCH_MAX_TIME_MS = 120_000
BATCH_DEFAULT_MAX_OUTPUT_CHARS = 16_384
BATCH_MAX_OUTPUT_CHARS = 24_000
BATCH_STEP_OUTPUT_CHARS = 4_096
BATCH_FINAL_OUTPUT_CHARS = 8_192
BATCH_MAX_TEXT_CHARS = 20_000
BATCH_MAX_SELECTOR_CHARS = 512
BATCH_MAX_URL_CHARS = 2_048
COMMAND_CAPTURE_MAX_BYTES = 256_000

BATCH_ACTIONS = {
    "open": ("agent_browser_open", {"url", "timeoutMs"}),
    "back": ("agent_browser_back", {"timeoutMs"}),
    "forward": ("agent_browser_forward", {"timeoutMs"}),
    "reload": ("agent_browser_reload", {"timeoutMs"}),
    "click": ("agent_browser_click", {"selector", "newTab", "timeoutMs"}),
    "dblclick": ("agent_browser_dblclick", {"selector", "timeoutMs"}),
    "fill": ("agent_browser_fill", {"selector", "text", "timeoutMs"}),
    "type": ("agent_browser_type", {"selector", "text", "clear", "delayMs", "timeoutMs"}),
    "press": ("agent_browser_press", {"key", "timeoutMs"}),
    "select": ("agent_browser_select", {"selector", "values", "timeoutMs"}),
    "check": ("agent_browser_check", {"selector", "timeoutMs"}),
    "uncheck": ("agent_browser_uncheck", {"selector", "timeoutMs"}),
    "scroll": ("agent_browser_scroll", {"direction", "amount", "selector", "timeoutMs"}),
    "wait_ms": ("agent_browser_wait_ms", {"ms", "timeoutMs"}),
    "wait_for_selector": ("agent_browser_wait_for_selector", {"selector", "waitTimeoutMs", "timeoutMs"}),
    "wait_for_text": ("agent_browser_wait_for_text", {"text", "waitTimeoutMs", "timeoutMs"}),
    "wait_for_load": ("agent_browser_wait_for_load", {"state", "waitTimeoutMs", "timeoutMs"}),
    "snapshot": ("agent_browser_snapshot", {"compact", "delta", "depth", "full", "includeUrls", "interactive", "selector", "timeoutMs"}),
    "screenshot": ("agent_browser_screenshot", {"annotate", "format", "fullPage", "ifChanged", "path", "quality", "selector", "threshold", "timeoutMs"}),
    "get_text": ("agent_browser_get_text", {"selector", "timeoutMs"}),
    "get_url": ("agent_browser_get_url", {"timeoutMs"}),
    "get_title": ("agent_browser_get_title", {"timeoutMs"}),
    "tab_new": ("agent_browser_tab_new", {"label", "url", "timeoutMs"}),
    "tab_switch": ("agent_browser_tab_switch", {"tab", "timeoutMs"}),
    "tab_close": ("agent_browser_tab_close", {"tab", "timeoutMs"}),
}

# Read-only or recovery actions may establish a target after a restart.  The
# ref-based actions below still require a fresh snapshot after every action
# that can invalidate refs.
BATCH_RECOVERY_ACTIONS = {
    "open",
    "back",
    "forward",
    "reload",
    "wait_ms",
    "wait_for_selector",
    "wait_for_text",
    "wait_for_load",
    "snapshot",
    "screenshot",
    "get_text",
    "get_url",
    "get_title",
    "tab_new",
    "tab_switch",
    "tab_close",
}

BATCH_INVALIDATING_ACTIONS = {
    "open",
    "back",
    "forward",
    "reload",
    "wait_ms",
    "wait_for_selector",
    "wait_for_text",
    "wait_for_load",
    "tab_new",
    "tab_switch",
    "tab_close",
}

MCP_RECOVERY_TOOLS = {
    "agent_browser_open",
    "agent_browser_snapshot",
    "agent_browser_wait",
    "agent_browser_tab",
    "agent_browser_tab_list",
    "agent_browser_tab_new",
    "agent_browser_tab_switch",
}
MCP_READ_ONLY_TOOLS = {
    "agent_browser_snapshot",
    "agent_browser_screenshot",
    "agent_browser_get_url",
    "agent_browser_get_text",
    "agent_browser_get_value",
    "agent_browser_get_attribute",
    "agent_browser_get_count",
    "agent_browser_get_box",
    "agent_browser_get_styles",
    "agent_browser_is_visible",
    "agent_browser_is_enabled",
    "agent_browser_is_checked",
    "agent_browser_is_editable",
    "agent_browser_wait_for_selector",
    "agent_browser_wait_for_text",
    "agent_browser_wait_for_url",
    "agent_browser_wait_for_load_state",
    "agent_browser_read",
    "agent_browser_tab_list",
    "agent_browser_tools_profiles",
}


def emit(value: dict[str, Any], code: int) -> int:
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    return code


def mcp_error(message: str, code: str) -> int:
    response = {"success": False, "error": message, "code": code}
    envelope = {
        "content": [{"type": "text", "text": message}],
        "structuredContent": {"exitCode": 1, "stdout": "", "stderr": message, "response": response},
        "isError": True,
        "_meta": {"agentBrowserVersion": "0.41.1"},
    }
    return emit(envelope, 1)


def batch_error(message: str, code: str, *, details: dict[str, Any] | None = None) -> dict[str, Any]:
    value: dict[str, Any] = {"success": False, "error": {"code": code, "message": message}}
    if details:
        value["error"]["details"] = details
    return value


def batch_text(value: Any, limit: int = BATCH_MAX_TEXT_CHARS) -> bool:
    return isinstance(value, str) and 0 < len(value) <= limit


def batch_safe_text(value: Any, limit: int = 128) -> str | None:
    if not isinstance(value, str):
        return None
    return value[:limit] + ("…" if len(value) > limit else "")


def batch_int(value: Any, *, minimum: int = 0, maximum: int | None = None) -> bool:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        return False
    return maximum is None or value <= maximum


def batch_selector(value: Any) -> bool:
    return batch_text(value, BATCH_MAX_SELECTOR_CHARS)


def batch_url(value: Any) -> bool:
    if not batch_text(value, BATCH_MAX_URL_CHARS):
        return False
    # agent-browser's visible wrapper only permits regular web navigation.  Do
    # not pass javascript:, data:, file: or other URL schemes to the CLI.
    parsed = urlparse(value)
    return parsed.scheme in {"https", "http"} and bool(parsed.netloc) and not any(character.isspace() for character in value)


def batch_action_error(index: int, action: Any, message: str, code: str) -> dict[str, Any]:
    return batch_error(
        message,
        code,
        details={"index": index, "action": batch_safe_text(action)},
    )


def validate_batch_action(action: Any, index: int) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    if not isinstance(action, dict):
        return None, batch_action_error(index, None, "Each batch action must be an object.", "BATCH_ACTION_INVALID")
    name = action.get("action")
    if not isinstance(name, str) or name not in BATCH_ACTIONS:
        return None, batch_action_error(index, name, "The browser batch action is not allowed.", "BATCH_ACTION_NOT_ALLOWED")
    _, fields = BATCH_ACTIONS[name]
    unknown = sorted(set(action) - {"action", *fields})
    if unknown:
        error = batch_action_error(index, name, "The browser batch action contains unsupported fields.", "BATCH_ARGUMENT_INVALID")
        error["error"]["details"] = {
            "index": index,
            "action": batch_safe_text(name),
            "fields": [batch_safe_text(field) for field in unknown[:16]],
        }
        return None, error
    value = {key: action[key] for key in fields if key in action}

    def require(field: str, predicate: bool) -> dict[str, Any] | None:
        if field not in value or not predicate:
            return batch_action_error(index, name, f"The `{name}` action requires a valid `{field}`.", "BATCH_ARGUMENT_INVALID")
        return None

    if name == "open":
        error = require("url", batch_url(value.get("url")))
        if error:
            return None, error
    elif name in {"click", "dblclick", "fill", "type", "select", "check", "uncheck", "wait_for_selector", "get_text"}:
        error = require("selector", batch_selector(value.get("selector")))
        if error:
            return None, error
    if name == "scroll" and "selector" in value and not batch_selector(value.get("selector")):
        return None, batch_action_error(index, name, "The optional scroll selector must be a non-empty string.", "BATCH_ARGUMENT_INVALID")
    if name in {"fill", "type", "wait_for_text"}:
        field = "text"
        error = require(field, batch_text(value.get(field)))
        if error:
            return None, error
    if name == "press":
        error = require("key", batch_text(value.get("key"), 128))
        if error:
            return None, error
    if name == "select":
        values = value.get("values")
        if not isinstance(values, list) or not values or len(values) > 32 or not all(batch_text(item, 1024) for item in values):
            return None, batch_action_error(index, name, "The `select` action requires one to 32 non-empty values.", "BATCH_ARGUMENT_INVALID")
    if name == "wait_for_load":
        error = require("state", value.get("state") in {"load", "domcontentloaded", "networkidle"})
        if error:
            return None, error
    if name == "scroll":
        if "direction" in value and value["direction"] not in {"up", "down", "left", "right"}:
            return None, batch_action_error(index, name, "Scroll direction is not supported.", "BATCH_ARGUMENT_INVALID")
        if "amount" in value and not batch_int(value["amount"], minimum=1, maximum=20_000):
            return None, batch_action_error(index, name, "Scroll amount must be between 1 and 20000.", "BATCH_ARGUMENT_INVALID")
        if "direction" not in value and "amount" not in value:
            return None, batch_action_error(index, name, "Scroll requires a direction or amount.", "BATCH_ARGUMENT_INVALID")
    if name == "wait_ms":
        error = require("ms", batch_int(value.get("ms"), minimum=0, maximum=30_000))
        if error:
            return None, error
    if name == "screenshot":
        if "format" in value and value["format"] not in {"png", "jpeg"}:
            return None, batch_action_error(index, name, "Screenshot format must be png or jpeg.", "BATCH_ARGUMENT_INVALID")
        if "path" in value:
            path = value["path"]
            normalized_path = posixpath.normpath(path) if isinstance(path, str) else ""
            if (
                not batch_text(path, 512)
                or not (normalized_path.startswith("/data/") or normalized_path.startswith("/workspace/"))
                or normalized_path != path
                or "/../" in path
            ):
                return None, batch_action_error(index, name, "Screenshot paths must stay under /data or /workspace.", "BATCH_ARGUMENT_INVALID")
        if "quality" in value and not batch_int(value["quality"], minimum=0, maximum=100):
            return None, batch_action_error(index, name, "Screenshot quality must be between 0 and 100.", "BATCH_ARGUMENT_INVALID")
        if "threshold" in value and (isinstance(value["threshold"], bool) or not isinstance(value["threshold"], (int, float)) or not 0 <= value["threshold"] <= 1):
            return None, batch_action_error(index, name, "Screenshot threshold must be between 0 and 1.", "BATCH_ARGUMENT_INVALID")
    if name == "tab_new" and "url" in value and not batch_url(value["url"]):
        return None, batch_action_error(index, name, "New tab URLs must use http(s).", "BATCH_ARGUMENT_INVALID")
    if name in {"tab_switch", "tab_close"} and not batch_selector(value.get("tab")):
        return None, batch_action_error(index, name, "The tab identifier is required and must be a non-empty string.", "BATCH_ARGUMENT_INVALID")
    for field in ("timeoutMs", "waitTimeoutMs"):
        if field in value and not batch_int(value[field], minimum=1, maximum=BATCH_MAX_TIME_MS):
            return None, batch_action_error(index, name, f"`{field}` must be between 1 and {BATCH_MAX_TIME_MS}.", "BATCH_ARGUMENT_INVALID")
    if "delayMs" in value and not batch_int(value["delayMs"], minimum=0, maximum=5_000):
        return None, batch_action_error(index, name, "`delayMs` must be between 0 and 5000.", "BATCH_ARGUMENT_INVALID")
    if "depth" in value and not batch_int(value["depth"], minimum=1, maximum=100):
        return None, batch_action_error(index, name, "Snapshot depth must be between 1 and 100.", "BATCH_ARGUMENT_INVALID")
    if "label" in value and not batch_text(value["label"], 256):
        return None, batch_action_error(index, name, "Tab labels must be non-empty and short.", "BATCH_ARGUMENT_INVALID")
    return {"action": name, **value}, None


def validate_batch_request(payload: Any) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    if not isinstance(payload, dict):
        return None, batch_error("The browser batch input must be an object.", "BATCH_INPUT_INVALID")
    allowed = {"actions", "maxSteps", "maxTimeMs", "maxOutputChars"}
    unknown = sorted(set(payload) - allowed)
    if unknown:
        return None, batch_error("The browser batch input contains unsupported fields.", "BATCH_INPUT_INVALID", details={"fields": [batch_safe_text(field) for field in unknown[:16]]})
    actions = payload.get("actions")
    if not isinstance(actions, list) or not actions:
        return None, batch_error("A browser batch must contain at least one action.", "BATCH_INPUT_INVALID")
    max_steps = payload.get("maxSteps", BATCH_DEFAULT_MAX_STEPS)
    max_time = payload.get("maxTimeMs", BATCH_DEFAULT_MAX_TIME_MS)
    max_output = payload.get("maxOutputChars", BATCH_DEFAULT_MAX_OUTPUT_CHARS)
    if not batch_int(max_steps, minimum=1, maximum=BATCH_MAX_STEPS):
        return None, batch_error(f"maxSteps must be between 1 and {BATCH_MAX_STEPS}.", "BATCH_LIMIT_INVALID")
    if len(actions) > max_steps:
        return None, batch_error("The full batch exceeds maxSteps; no action was started.", "BATCH_STEP_LIMIT", details={"requested": len(actions), "maxSteps": max_steps})
    if not batch_int(max_time, minimum=1, maximum=BATCH_MAX_TIME_MS):
        return None, batch_error(f"maxTimeMs must be between 1 and {BATCH_MAX_TIME_MS}.", "BATCH_LIMIT_INVALID")
    if not batch_int(max_output, minimum=1_024, maximum=BATCH_MAX_OUTPUT_CHARS):
        return None, batch_error(f"maxOutputChars must be between 1024 and {BATCH_MAX_OUTPUT_CHARS}.", "BATCH_LIMIT_INVALID")
    normalized: list[dict[str, Any]] = []
    for index, action in enumerate(actions):
        value, error = validate_batch_action(action, index)
        if error:
            return None, error
        assert value is not None
        normalized.append(value)
    return {"actions": normalized, "maxSteps": max_steps, "maxTimeMs": max_time, "maxOutputChars": max_output}, None


def batch_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def batch_last_json(output: str) -> Any:
    try:
        return json.loads(output.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        return None


def batch_message(payload: Any) -> str:
    if isinstance(payload, dict):
        content = payload.get("content")
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and isinstance(item.get("text"), str):
                    return item["text"]
        response = payload.get("structuredContent", {}).get("response", {}) if isinstance(payload.get("structuredContent"), dict) else {}
        if isinstance(response, dict) and isinstance(response.get("error"), str):
            return response["error"]
        error = payload.get("error")
        if isinstance(error, str):
            return error
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return error["message"]
    return "The browser action failed."


def batch_result_from_stock(output: str, returncode: int) -> tuple[bool, Any, dict[str, Any] | None]:
    payload = batch_last_json(output)
    if not isinstance(payload, dict):
        return False, None, {"code": "BROWSER_RESPONSE_INVALID", "message": "The browser returned an invalid response."}
    if payload.get("success") is False:
        error = payload.get("error")
        message = error if isinstance(error, str) else "The browser action failed."
        code = payload.get("code") if isinstance(payload.get("code"), str) else "BROWSER_ACTION_FAILED"
        return False, None, {"code": code, "message": message}
    if payload.get("error") is not None or payload.get("isError") is True:
        response = payload.get("structuredContent", {}).get("response", {}) if isinstance(payload.get("structuredContent"), dict) else {}
        code = response.get("code") if isinstance(response, dict) and isinstance(response.get("code"), str) else "BROWSER_ACTION_FAILED"
        return False, None, {"code": code, "message": batch_message(payload)}
    response = payload.get("structuredContent", {}).get("response") if isinstance(payload.get("structuredContent"), dict) else None
    if isinstance(response, dict):
        if response.get("success") is False:
            code = response.get("code") if isinstance(response.get("code"), str) else "BROWSER_ACTION_FAILED"
            return False, None, {"code": code, "message": batch_message(payload)}
        return returncode == 0, response.get("data"), None if returncode == 0 else {"code": "BROWSER_ACTION_FAILED", "message": batch_message(payload)}
    if returncode != 0:
        return False, None, {"code": "BROWSER_ACTION_FAILED", "message": batch_message(payload)}
    return True, payload, None


def batch_bounded_data(value: Any, limit: int) -> tuple[Any, bool]:
    encoded = batch_json(value)
    if len(encoded) <= limit:
        return value, False
    if isinstance(value, dict):
        kept: dict[str, Any] = {}
        # Keep durable references to files/screenshots and small navigation
        # facts even when a snapshot or page text is too large for the batch.
        for key in ("path", "url", "title", "status", "imageDataUrl"):
            if key in value and key != "imageDataUrl":
                candidate = value[key]
                if isinstance(candidate, str):
                    kept[key] = candidate[: min(512, limit // 4)]
                else:
                    kept[key] = candidate
        kept["truncated"] = True
        kept["originalChars"] = len(encoded)
        return kept, True
    if isinstance(value, list):
        return {"truncated": True, "originalChars": len(encoded), "items": len(value)}, True
    return {"truncated": True, "originalChars": len(encoded), "text": str(value)[: max(0, limit - 80)]}, True


def batch_trim_result(result: dict[str, Any], limit: int) -> dict[str, Any]:
    encoded = batch_json(result)
    step_truncated = any(isinstance(item, dict) and item.get("truncated") is True for item in result.get("results", []))
    snapshot_truncated = isinstance(result.get("finalSnapshot"), dict) and result["finalSnapshot"].get("truncated") is True
    if len(encoded) <= limit and not step_truncated and not snapshot_truncated:
        return result
    trimmed = dict(result)
    if step_truncated or snapshot_truncated:
        trimmed["truncated"] = True
        trimmed["outputLimit"] = limit
        trimmed["recovery"] = "Output was truncated. Use the fresh snapshot and action statuses; do not repeat successful actions."
    results = []
    for item in result.get("results", []):
        if not isinstance(item, dict):
            continue
        value = dict(item)
        if "data" in value:
            value["data"], was_truncated = batch_bounded_data(value["data"], BATCH_STEP_OUTPUT_CHARS)
            if was_truncated:
                value["truncated"] = True
        results.append(value)
    trimmed["results"] = results
    if "finalSnapshot" in trimmed:
        trimmed["finalSnapshot"], was_truncated = batch_bounded_data(trimmed["finalSnapshot"], BATCH_FINAL_OUTPUT_CHARS)
        if was_truncated:
            trimmed["finalSnapshotTruncated"] = True
    trimmed["truncated"] = True
    trimmed["outputLimit"] = limit
    trimmed["recovery"] = "Output was truncated. Use a fresh snapshot and the executed action statuses; do not repeat successful actions."
    if isinstance(trimmed.get("error"), dict):
        trimmed["error"] = {
            key: (str(value)[:512] if isinstance(value, str) else value)
            for key, value in trimmed["error"].items()
            if key in {"code", "message", "index", "action", "expectedGeneration", "actualGeneration"}
        }
    if len(batch_json(trimmed)) > limit:
        trimmed["results"] = [
            {key: item[key] for key in ("index", "action", "success", "executed", "error", "truncated") if key in item}
            for item in results
        ]
        if isinstance(trimmed.get("finalSnapshot"), dict):
            trimmed["finalSnapshot"] = {key: trimmed["finalSnapshot"][key] for key in ("path", "url", "title", "truncated") if key in trimmed["finalSnapshot"]}
    # A caller may deliberately request the smallest supported budget. Keep
    # the response valid JSON and below that budget even for a pathological
    # stock error or a long action name. Statuses are retained until the last
    # fallback; successful counts and recovery guidance are never dropped.
    if len(batch_json(trimmed)) > limit:
        compact_results = [
            {"index": item.get("index"), "action": str(item.get("action", ""))[:64], "success": item.get("success"), "executed": item.get("executed")}
            for item in results
        ]
        minimal: dict[str, Any] = {
            "success": result.get("success", False),
            "requestedCount": result.get("requestedCount", 0),
            "executedCount": result.get("executedCount", 0),
            "attemptedCount": result.get("attemptedCount", 0),
            "results": compact_results,
            "finalSnapshotOk": result.get("finalSnapshotOk", False),
            "partialSideEffects": result.get("partialSideEffects", False),
            "stoppedReason": str(result.get("stoppedReason") or "unknown")[:64],
            "truncated": True,
            "outputLimit": limit,
            "recovery": "Output truncated; use statuses and a fresh snapshot. Do not repeat successful actions.",
        }
        while len(batch_json(minimal)) > limit and len(minimal["results"]) > 1:
            minimal["results"].pop()
        if len(batch_json(minimal)) > limit:
            minimal["results"] = []
        return minimal
    return trimmed


def stock_mcp_response(output: str) -> bool:
    """Preserve both tool errors and JSON-RPC validation errors from stock."""
    try:
        value = json.loads(output.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        return False
    meta = value.get("_meta") if isinstance(value, dict) else None
    return isinstance(meta, dict) and meta.get("agentBrowserVersion") == "0.41.1"


def guarded_mcp_error(output: str, fallback: str) -> int:
    if "CONTROL_BUSY" in output or "manual control" in output:
        code = "USER_CONTROL_ACTIVE"
    elif "CONTROL_LOST" in output:
        code = "CONTROL_LOST"
    else:
        code = "BROWSER_ENDPOINT_UNAVAILABLE"
    message = fallback
    try:
        value = json.loads(output.strip().splitlines()[-1])
        if isinstance(value, dict) and isinstance(value.get("error"), str):
            message = value["error"]
    except (IndexError, json.JSONDecodeError):
        if output.strip():
            message = output.strip().splitlines()[-1][:300]
    return mcp_error(message, code)


def command_name(args: list[str]) -> str | None:
    value_options = {"--session", "--namespace", "--cdp", "--profile", "--timeout", "--wait"}
    skip = False
    for item in args:
        if skip:
            skip = False
            continue
        if item in value_options:
            skip = True
            continue
        if item.startswith("-"):
            continue
        return item
    return None


def mcp_tool_name(args: list[str]) -> str | None:
    try:
        index = args.index("mcp")
        if args[index + 1] != "call":
            return None
        value = args[index + 2]
        return value if not value.startswith("-") else None
    except (ValueError, IndexError):
        return None


def mcp_payload_index(args: list[str]) -> int | None:
    """Index of the JSON payload in `mcp call <tool> <json>`: data, not options."""
    try:
        index = args.index("mcp")
    except ValueError:
        return None
    if args[index + 1 : index + 2] != ["call"] or index + 3 >= len(args):
        return None
    return index + 3


def structural_args(args: list[str]) -> list[str]:
    payload = mcp_payload_index(args)
    return [item for index, item in enumerate(args) if index != payload]


def target_override(args: list[str]) -> str | None:
    """The first argument that would replace the managed CDP target, if any."""
    structural = structural_args(args)
    for item in structural:
        if any(item == flag or item.startswith(flag + "=") for flag in TARGET_FLAGS):
            return item
    name = command_name(args)
    if name == "connect":
        return "connect"
    # `-p` is the short provider option; only the global position is an option.
    for item in structural:
        if item == name:
            break
        if item == "-p" or item.startswith("-p="):
            return item
    return None


def mcp_payload_session(args: list[str]) -> str | None:
    index = mcp_payload_index(args)
    if index is None:
        return None
    try:
        payload = json.loads(args[index])
    except json.JSONDecodeError:
        return None
    value = payload.get("session") if isinstance(payload, dict) else None
    return value if isinstance(value, str) else None


def resolve_session(args: list[str]) -> tuple[str | None, str | None]:
    """The one session both the observation gate and the stock CLI will use.

    0.41.1 honours `--session NAME` before and after the command, rejects
    `--session=NAME` before it and silently ignores it after it. Only the
    supported spelling is accepted, once; an MCP payload may name the same
    session but not another one.
    """
    structural = structural_args(args)
    names: list[str] = []
    for index, item in enumerate(structural):
        if item.startswith("--session="):
            return None, "use `--session NAME`; `--session=NAME` is not supported by the pinned agent-browser"
        if item == "--session":
            if index + 1 >= len(structural) or not structural[index + 1] or structural[index + 1].startswith("-"):
                return None, "--session needs a name"
            names.append(structural[index + 1])
    if len(names) > 1:
        return None, "give --session only once"
    flag = names[0] if names else None
    payload = mcp_payload_session(args)
    if flag and payload and payload != flag:
        return None, "the MCP session argument does not match --session"
    return flag or payload or SESSION, None


def session_name(args: list[str]) -> str:
    name, _ = resolve_session(args)
    return name or SESSION


def has_session(args: list[str]) -> bool:
    return "--session" in structural_args(args)


def normalized_args(args: list[str]) -> list[str]:
    """Keep the caller's session, while supplying one stable default only once."""
    if has_session(args):
        return list(args)
    return ["--session", session_name(args), *args]


def stock_env(browser: dict[str, Any] | None = None) -> dict[str, str]:
    """Environment for the stock CLI: only the wrapper chooses the browser target."""
    environment = {key: value for key, value in os.environ.items() if key not in TARGET_ENV}
    cdp = browser.get("cdp") if browser else None
    if isinstance(cdp, dict) and isinstance(cdp.get("websocket_url"), str):
        environment.update({"AGENT_BROWSER_CDP": str(cdp["websocket_url"]), "AGENT_BROWSER_PIN_TAB": "1", "AGENT_BROWSER_HEADED": "1"})
    return environment


def bypass(args: list[str]) -> bool:
    """Commands that do not connect to or mutate a browser target."""
    if not args or any(item in {"--help", "-h"} for item in args):
        return True
    if args[0] in {"--help", "-h", "help", "--version", "version", "skills", "close"}:
        return True
    return command_name(args) == "doctor" and "--offline" in args


def stock(args: list[str], extra: list[str] | None = None, env: dict[str, str] | None = None) -> int:
    command = [STOCK, *(extra or []), *args]
    try:
        return subprocess.run(command, env=env if env is not None else stock_env(), check=False).returncode
    except FileNotFoundError:
        return emit(
            {
                "ok": False,
                "error": "the pinned agent-browser binary is not installed",
                "code": "BROWSER_BINARY_UNAVAILABLE",
            },
            1,
        )


def close_client(args: list[str]) -> int:
    try:
        browser = json.loads((RUNTIME / "browser.json").read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        browser = None
    status = stock(normalized_args(args), env=stock_env(browser if isinstance(browser, dict) else None))
    if status == 0:
        forget_observation(session_name(args))
    return status


def control_generation() -> int:
    try:
        value = json.loads((RUNTIME / "control.json").read_text(encoding="utf-8")).get("generation", 0)
        return int(value) if isinstance(value, int) else 0
    except (FileNotFoundError, OSError, json.JSONDecodeError, ValueError):
        return 0


def observation_path(session: str) -> Path:
    # Session names are free text: hash them into a fixed, safe file name.
    return OBSERVATIONS / (hashlib.sha256(session.encode("utf-8")).hexdigest()[:32] + ".json")


def read_observation(session: str) -> dict[str, Any] | None:
    try:
        value = json.loads(observation_path(session).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None


def current_generation(browser: dict[str, Any]) -> dict[str, int]:
    return {"browserGeneration": int(browser.get("generation", 0)), "controlGeneration": control_generation()}


def observation_fresh(browser: dict[str, Any], session: str) -> bool:
    """Same session and the same browser/control generations as the snapshot.

    A new Chrome (browserGeneration) or a manual takeover/release, expiry or
    screen restart (controlGeneration) makes every session's record stale.
    """
    expected = current_generation(browser)
    value = read_observation(session)
    return bool(
        value
        and value.get("session") == session
        and value.get("browserGeneration") == expected["browserGeneration"]
        and value.get("controlGeneration") == expected["controlGeneration"]
    )


def write_observation(browser: dict[str, Any], session: str) -> None:
    value: dict[str, Any] = {"session": session, **current_generation(browser), "observedAt": int(time.time() * 1000)}
    # Snapshot success is the observation boundary. The stock client owns the
    # pinned target and performs any foreground activation internally.
    RUNTIME.mkdir(mode=0o700, parents=True, exist_ok=True)
    OBSERVATIONS.mkdir(mode=0o700, exist_ok=True)
    os.chmod(OBSERVATIONS, 0o700)
    target = observation_path(session)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":")) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, target)


def forget_observation(session: str) -> None:
    try:
        observation_path(session).unlink()
    except FileNotFoundError:
        pass


def is_safe_after_restart(name: str | None, args: list[str]) -> bool:
    # Navigation and tab recovery are deliberately allowed to establish a new
    # target. Any ref/keyboard/mouse mutation must first observe that target.
    if name in {"open", "tab", "snapshot", "wait", "url", "get", "screenshot", "read", "session", "webmcp"}:
        return True
    if name == "mcp":
        tool = mcp_tool_name(args) or ""
        return tool in MCP_RECOVERY_TOOLS or tool in MCP_READ_ONLY_TOOLS
    return False


def is_mutation(name: str | None, args: list[str] | None = None) -> bool:
    if name == "mcp":
        tool = mcp_tool_name(args or []) or ""
        return tool not in MCP_RECOVERY_TOOLS and tool not in MCP_READ_ONLY_TOOLS
    return name in {
        "click",
        "dblclick",
        "fill",
        "type",
        "press",
        "key",
        "focus",
        "hover",
        "select",
        "check",
        "uncheck",
        "scroll",
        "drag",
        "upload",
        "download",
        "keyboard",
        "mouse",
        "set",
        "clear",
        "reload",
        "back",
        "forward",
        "pushstate",
        "eval",
    }


def is_snapshot(args: list[str]) -> bool:
    name = command_name(args)
    return name == "snapshot" or (name == "mcp" and mcp_tool_name(args) == "agent_browser_snapshot")


def invalidates_observation(args: list[str]) -> bool:
    name = command_name(args)
    if name in {"open", "reload", "back", "forward", "pushstate", "wait"}:
        return True
    if name == "tab":
        command = next((item for item in args[args.index("tab") + 1 :] if not item.startswith("-")), "") if "tab" in args else ""
        return command in {"new", "close"} or (command not in {"", "list"})
    if name == "mcp":
        return (mcp_tool_name(args) or "") in {
            "agent_browser_open",
            "agent_browser_wait",
            "agent_browser_tab_new",
            "agent_browser_tab_switch",
            "agent_browser_tab_close",
            "agent_browser_tab",
        }
    return False


def active_tab_id(output: str) -> str | None:
    try:
        payload = json.loads(output.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        return None

    def find(node: Any) -> str | None:
        if isinstance(node, dict):
            active = node.get("active") is True or node.get("isActive") is True or node.get("selected") is True or node.get("is_active") is True
            if active:
                for key in ("tabId", "targetId", "id"):
                    value = node.get(key)
                    if isinstance(value, str) and value:
                        return value
            for value in node.values():
                found = find(value)
                if found:
                    return found
        elif isinstance(node, list):
            for value in node:
                found = find(value)
                if found:
                    return found
        return None

    return find(payload)


def lease_held() -> bool:
    """Whether this process inherited desktop-control's locked descriptor.

    desktop-control verifies that the descriptor is the action lock and the
    one holding it; no environment variable on its own counts as the lease.
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


def lease_fds() -> tuple[int, ...]:
    return (int(os.environ[LEASE_FD_ENV]),) if lease_held() else ()


def ensure(mcp: bool = False, timeout: float | None = None, bounded: bool = False) -> dict[str, Any] | None:
    global LAST_ERROR, LAST_ERROR_CODE
    LAST_ERROR_CODE = ""
    try:
        # desktop-browser may need to launch Chrome under this same lease.
        if bounded:
            result = bounded_subprocess([DESKTOP_BROWSER, "ensure"], env=os.environ.copy(), timeout=timeout, pass_fds=lease_fds())
        else:
            result = subprocess.run([DESKTOP_BROWSER, "ensure"], text=True, capture_output=True, check=False, timeout=timeout, pass_fds=lease_fds())
    except FileNotFoundError:
        LAST_ERROR = "desktop-browser is not installed"
        LAST_ERROR_CODE = "BROWSER_HELPER_UNAVAILABLE"
        if not mcp:
            emit({"ok": False, "error": LAST_ERROR, "code": "BROWSER_HELPER_UNAVAILABLE"}, 1)
        return None
    if result.returncode != 0:
        if result.returncode == 124:
            LAST_ERROR = "The managed browser ensure step exceeded the batch time limit"
            LAST_ERROR_CODE = "BATCH_TIME_LIMIT"
        else:
            LAST_ERROR = result.stdout or result.stderr or "managed Chrome could not be prepared"
            LAST_ERROR_CODE = "BROWSER_ENDPOINT_UNAVAILABLE"
        if result.stdout and not mcp:
            sys.stdout.write(result.stdout)
        elif result.stderr and not mcp:
            sys.stderr.write(result.stderr)
        return None
    try:
        payload = json.loads(result.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        LAST_ERROR = "desktop-browser returned invalid state"
        LAST_ERROR_CODE = "BROWSER_STATE_INVALID"
        if not mcp:
            emit({"ok": False, "error": LAST_ERROR, "code": "BROWSER_STATE_INVALID"}, 1)
        return None
    if not isinstance(payload, dict) or payload.get("ok") is not True or not isinstance(payload.get("cdp"), dict):
        LAST_ERROR = "desktop-browser returned no managed CDP endpoint"
        LAST_ERROR_CODE = "BROWSER_ENDPOINT_UNAVAILABLE"
        if not mcp:
            emit({"ok": False, "error": LAST_ERROR, "code": "BROWSER_ENDPOINT_UNAVAILABLE"}, 1)
        return None
    return payload


def bounded_subprocess(
    command: list[str],
    *,
    env: dict[str, str],
    timeout: float | None,
    pass_fds: tuple[int, ...] = (),
) -> subprocess.CompletedProcess[str]:
    """Capture only a bounded tail while continuing to drain both pipes.

    agent-browser normally returns one JSON envelope on its last line, so a
    tail preserves the parseable response even when a page or browser daemon
    writes an unexpectedly large prefix. Draining the pipes prevents a noisy
    child from blocking forever, and the process group is killed on timeout so
    the desktop lease cannot outlive a cancelled batch step.
    """
    process = subprocess.Popen(
        command,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        pass_fds=pass_fds,
    )
    selector = selectors.DefaultSelector()
    streams: dict[int, bytearray] = {}
    for stream in (process.stdout, process.stderr):
        if stream is not None:
            selector.register(stream, selectors.EVENT_READ)
            streams[stream.fileno()] = bytearray()
    deadline = None if timeout is None else time.monotonic() + max(0.0, timeout)
    timed_out = False
    cancelled = False
    stdout_tail = b""
    stderr_tail = b""
    previous_handlers: dict[int, Any] = {}

    def interrupt(_signum: int, _frame: Any) -> None:
        raise KeyboardInterrupt

    for signum in (signal.SIGTERM, signal.SIGINT):
        try:
            previous_handlers[signum] = signal.getsignal(signum)
            signal.signal(signum, interrupt)
        except (ValueError, OSError):
            pass

    def kill_group(*, force: bool = False) -> None:
        if force or process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except PermissionError:
                # macOS can reject killpg after the group leader has exited
                # even though a background descendant is still alive. Restrict
                # fallback cleanup to processes reporting this exact PGID.
                try:
                    listing = subprocess.run(
                        ["ps", "-axo", "pid=,pgid="],
                        text=True,
                        capture_output=True,
                        check=False,
                    ).stdout
                    for line in listing.splitlines():
                        fields = line.split()
                        if len(fields) != 2 or fields[1] != str(process.pid):
                            continue
                        try:
                            os.kill(int(fields[0]), signal.SIGKILL)
                        except (ProcessLookupError, PermissionError, ValueError):
                            pass
                except (OSError, ValueError):
                    pass

    try:
        while selector.get_map():
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                timed_out = True
                # The shell/supervisor may have exited while a background
                # descendant still owns this process group. Force the group
                # kill on timeout instead of checking the leader's status.
                kill_group(force=True)
                remaining = 0
            events = selector.select(remaining)
            if not events:
                if timed_out:
                    break
                if process.poll() is not None:
                    # A closed process may leave one final readable event; loop
                    # once more with a zero timeout to drain it.
                    events = selector.select(0)
                    if not events:
                        break
                else:
                    continue
            for key, _ in events:
                stream = key.fileobj
                try:
                    chunk = os.read(stream.fileno(), 64 * 1024)
                except OSError:
                    chunk = b""
                if not chunk:
                    try:
                        selector.unregister(stream)
                    except (KeyError, ValueError):
                        pass
                    continue
                tail = streams[stream.fileno()]
                tail.extend(chunk)
                if len(tail) > COMMAND_CAPTURE_MAX_BYTES:
                    del tail[: len(tail) - COMMAND_CAPTURE_MAX_BYTES]
        try:
            process.wait(timeout=0.2)
        except subprocess.TimeoutExpired:
            timed_out = True
            kill_group(force=True)
            process.wait()
    except BaseException:
        cancelled = True
        raise
    finally:
        # Cancellation can arrive while a noisy child is being drained. Always
        # release the inherited action lease by killing its whole process group.
        kill_group(force=timed_out or cancelled)
        try:
            process.wait(timeout=0.2)
        except subprocess.TimeoutExpired:
            kill_group(force=True)
            process.wait()
        for signum, handler in previous_handlers.items():
            try:
                signal.signal(signum, handler)
            except (ValueError, OSError):
                pass
        stdout_tail = bytes(streams.get(process.stdout.fileno(), b"")) if process.stdout is not None else b""
        stderr_tail = bytes(streams.get(process.stderr.fileno(), b"")) if process.stderr is not None else b""
        selector.close()
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                stream.close()
    decoded_stdout = stdout_tail.decode("utf-8", errors="replace")
    decoded_stderr = stderr_tail.decode("utf-8", errors="replace")
    if timed_out:
        return subprocess.CompletedProcess(command, 124, decoded_stdout, "batch action timed out")
    return subprocess.CompletedProcess(command, process.returncode, decoded_stdout, decoded_stderr)


def invoke_guarded(
    command: list[str],
    capture: bool = False,
    browser: dict[str, Any] | None = None,
    timeout: float | None = None,
    bounded: bool = False,
) -> subprocess.CompletedProcess[str]:
    environment = stock_env(browser)
    # The stock CLI starts a daemon: it never gets the lease descriptor.
    if lease_held() or not Path(CONTROL).is_file():
        if capture and bounded:
            return bounded_subprocess(command, env=environment, timeout=timeout)
        try:
            return subprocess.run(command, env=environment, text=True, capture_output=capture, check=False, timeout=timeout)
        except subprocess.TimeoutExpired:
            return subprocess.CompletedProcess(command, 124, "", "batch action timed out")
    env_args = ["env"]
    for name in ("AGENT_BROWSER_CDP", "AGENT_BROWSER_PIN_TAB", "AGENT_BROWSER_HEADED"):
        if name in environment:
            env_args.append(f"{name}={environment[name]}")
    guarded = [CONTROL, "run", "--", *env_args, *command]
    if capture and bounded:
        return bounded_subprocess(guarded, env=environment, timeout=timeout)
    try:
        return subprocess.run(guarded, env=environment, text=True, capture_output=capture, check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(command, 124, "", "batch action timed out")


def prepare_snapshot_target(
    browser: dict[str, Any],
    args: list[str],
    timeout: float | None = None,
    bounded: bool = False,
    quiet: bool = False,
) -> int:
    """Select the pinned session's active tab before refs are generated.

    The stock CLI has no public bring-to-front command. A tab switch is safe at
    this point because the next operation is the fresh snapshot; doing it after
    the snapshot would invalidate its refs.
    """
    session = session_name(args)
    started = time.monotonic()
    listed = invoke_guarded([STOCK, "--session", session, "tab", "list", "--json"], capture=True, browser=browser, timeout=timeout, bounded=bounded)
    if listed.returncode != 0:
        # Let the stock snapshot produce the canonical tab_gone/recovery result.
        return 0
    target = active_tab_id(listed.stdout)
    if not target:
        return 0
    remaining = None if timeout is None else timeout - (time.monotonic() - started)
    if remaining is not None and remaining <= 0:
        return 124
    focused = invoke_guarded([STOCK, "--session", session, "tab", target], capture=True, browser=browser, timeout=remaining, bounded=bounded)
    if focused.returncode != 0 and not quiet:
        if focused.stdout:
            sys.stdout.write(focused.stdout)
        if focused.stderr:
            sys.stderr.write(focused.stderr)
    return focused.returncode


def read_control_state() -> dict[str, Any]:
    try:
        value = json.loads((RUNTIME / "control.json").read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return {}


def strict_browser_generation() -> int | None:
    try:
        value = json.loads((RUNTIME / "browser.json").read_text(encoding="utf-8"))
        if not isinstance(value, dict) or isinstance(value.get("generation"), bool) or not isinstance(value.get("generation"), int):
            return None
        cdp = value.get("cdp")
        if not isinstance(cdp, dict) or not isinstance(cdp.get("websocket_url"), str):
            return None
        return int(value["generation"])
    except (FileNotFoundError, OSError, json.JSONDecodeError, ValueError):
        return None


def strict_control_generation() -> int | None:
    try:
        value = json.loads((RUNTIME / "control.json").read_text(encoding="utf-8"))
        generation = value.get("generation") if isinstance(value, dict) else None
        return int(generation) if isinstance(generation, int) and not isinstance(generation, bool) else None
    except (FileNotFoundError, OSError, json.JSONDecodeError, ValueError):
        return None


def active_manual_owner(state: dict[str, Any]) -> bool:
    owner = state.get("owner")
    expires = state.get("expiresAt")
    if not isinstance(owner, str) or not owner:
        return False
    # A malformed or missing expiry is treated as active.  The safe response is
    # to stop and let the desktop lease owner renew/release explicitly.
    return not isinstance(expires, int) or expires > int(time.time() * 1000)


def batch_preflight(browser: dict[str, Any], expected: dict[str, int]) -> dict[str, Any] | None:
    state = read_control_state()
    current_control = strict_control_generation()
    if current_control is None:
        return {"code": "BROWSER_STATE_INVALID", "message": "The desktop-control state is missing or malformed; no further action was sent."}
    if active_manual_owner(state):
        return {"code": "USER_CONTROL_ACTIVE", "message": "Manual browser control became active during the batch."}
    if current_control != expected["controlGeneration"]:
        return {
            "code": "CONTROL_GENERATION_CHANGED",
            "message": "Manual control changed the browser during the batch; no further action was sent.",
            "expectedGeneration": expected["controlGeneration"],
            "actualGeneration": current_control,
        }
    current_browser = strict_browser_generation()
    if current_browser is None:
        return {"code": "BROWSER_STATE_INVALID", "message": "The managed-browser state is missing or malformed; no further action was sent."}
    if current_browser != expected["browserGeneration"]:
        return {
            "code": "BROWSER_GENERATION_CHANGED",
            "message": "The managed browser restarted during the batch; no further action was sent.",
            "expectedGeneration": expected["browserGeneration"],
            "actualGeneration": current_browser,
        }
    # Keep the endpoint check tied to the generation captured by ensure().  A
    # changed websocket is a restart even when a stale runtime file survives.
    current_cdp = browser.get("cdp") if isinstance(browser, dict) else None
    if not isinstance(current_cdp, dict) or not isinstance(current_cdp.get("websocket_url"), str):
        return {"code": "BROWSER_ENDPOINT_UNAVAILABLE", "message": "The managed browser has no CDP endpoint."}
    return None


def batch_command(action: dict[str, Any]) -> list[str]:
    name = action["action"]
    tool, fields = BATCH_ACTIONS[name]
    arguments = {key: action[key] for key in fields if key in action}
    if name == "open":
        # The wrapper owns the headed Chrome.  Do not allow a declarative batch
        # to switch to a hidden browser or another endpoint.
        arguments["headed"] = True
    if name == "tab_new" and "url" not in arguments:
        arguments.pop("url", None)
    return [STOCK, "--session", SESSION, "mcp", "call", tool, batch_json(arguments)]


def batch_step_result(
    index: int,
    action: dict[str, Any],
    success: bool,
    *,
    data: Any = None,
    error: dict[str, Any] | None = None,
    executed: bool = False,
    attempted: bool = True,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "index": index,
        "action": action["action"],
        "success": success,
        "executed": executed,
        "attempted": attempted,
    }
    if data is not None:
        result["data"] = data
    if error is not None:
        result["error"] = error
    return result


def batch_final_snapshot(
    browser: dict[str, Any],
    expected: dict[str, int],
    deadline: float,
) -> tuple[bool, Any, dict[str, Any] | None]:
    preflight = batch_preflight(browser, expected)
    if preflight:
        return False, None, preflight
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return False, None, {"code": "BATCH_TIME_LIMIT", "message": "The batch time limit expired before the final snapshot."}
    args = ["--session", SESSION, "mcp", "call", "agent_browser_snapshot", batch_json({"session": SESSION})]
    prepared = prepare_snapshot_target(browser, args, timeout=remaining, bounded=True, quiet=True)
    if prepared != 0:
        if prepared == 124:
            return False, None, {"code": "BATCH_TIME_LIMIT", "message": "The batch time limit expired while preparing the final snapshot."}
        return False, None, {"code": "BROWSER_FOCUS_FAILED", "message": "The active tab could not be focused for the final snapshot."}
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return False, None, {"code": "BATCH_TIME_LIMIT", "message": "The batch time limit expired while preparing the final snapshot."}
    result = invoke_guarded([STOCK, *args], capture=True, browser=browser, timeout=remaining, bounded=True)
    if result.returncode == 124:
        return False, None, {"code": "BATCH_TIME_LIMIT", "message": "The batch time limit expired while taking the final snapshot."}
    success, data, error = batch_result_from_stock(result.stdout, result.returncode)
    if not success:
        return False, None, error or {"code": "BROWSER_SNAPSHOT_FAILED", "message": "The final browser snapshot failed."}
    write_observation(browser, SESSION)
    bounded, was_truncated = batch_bounded_data(data, BATCH_FINAL_OUTPUT_CHARS)
    if was_truncated and isinstance(bounded, dict):
        bounded["snapshotTruncated"] = True
    return True, bounded, None


def run_batch(
    payload: dict[str, Any],
    browser: dict[str, Any],
    started_at: float | None = None,
    expected: dict[str, int] | None = None,
) -> dict[str, Any]:
    actions = payload["actions"]
    max_time = payload["maxTimeMs"]
    max_output = payload["maxOutputChars"]
    expected = expected or current_generation(browser)
    deadline = (started_at if started_at is not None else time.monotonic()) + (max_time / 1000)
    results: list[dict[str, Any]] = []
    executed = 0
    attempted = 0
    stopped_reason: str | None = None
    batch_error_value: dict[str, Any] | None = None

    for index, action in enumerate(actions):
        preflight = batch_preflight(browser, expected)
        if preflight:
            stopped_reason = "generation_changed" if preflight["code"] != "USER_CONTROL_ACTIVE" else "human_takeover"
            batch_error_value = {**preflight, "index": index, "action": action["action"]}
            results.append(batch_step_result(index, action, False, error=preflight, executed=False, attempted=False))
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            stopped_reason = "time_limit"
            batch_error_value = {"code": "BATCH_TIME_LIMIT", "message": "The batch time limit expired before this action.", "index": index, "action": action["action"]}
            results.append(batch_step_result(index, action, False, error=batch_error_value, executed=False, attempted=False))
            break
        requires_observation = action["action"] not in BATCH_RECOVERY_ACTIONS
        if action["action"] == "scroll":
            requires_observation = "selector" in action
        if requires_observation and not observation_fresh(browser, SESSION):
            stopped_reason = "observation_required"
            batch_error_value = {"code": "BROWSER_OBSERVATION_REQUIRED", "message": "Take a fresh browser snapshot before ref-based actions.", "index": index, "action": action["action"]}
            results.append(batch_step_result(index, action, False, error=batch_error_value, executed=False, attempted=False))
            break
        attempted += 1
        args = batch_command(action)
        timeout = min(remaining, max(0.001, float(action.get("timeoutMs", remaining * 1000)) / 1000))
        if action["action"] == "snapshot":
            prepared = prepare_snapshot_target(browser, args, timeout=timeout, bounded=True, quiet=True)
            if prepared != 0:
                stopped_reason = "time_limit" if prepared == 124 else "focus_failed"
                batch_error_value = {
                    "code": "BATCH_TIME_LIMIT" if prepared == 124 else "BROWSER_FOCUS_FAILED",
                    "message": "The batch time limit expired while preparing the snapshot." if prepared == 124 else "The active tab could not be focused for the snapshot.",
                    "index": index,
                    "action": action["action"],
                }
                results.append(batch_step_result(index, action, False, error=batch_error_value, executed=False))
                break
        result = invoke_guarded(args, capture=True, browser=browser, timeout=timeout, bounded=True)
        if result.returncode == 124:
            success, data, error = False, None, {
                "code": "BATCH_TIME_LIMIT",
                "message": "The batch time limit expired while an action was running; its side effect is unknown.",
            }
        else:
            success, data, error = batch_result_from_stock(result.stdout, result.returncode)
        if success:
            bounded, was_truncated = batch_bounded_data(data, BATCH_FINAL_OUTPUT_CHARS if action["action"] == "snapshot" else BATCH_STEP_OUTPUT_CHARS)
            item = batch_step_result(index, action, True, data=bounded, executed=True)
            if was_truncated:
                item["truncated"] = True
            results.append(item)
            executed += 1
            if action["action"] == "snapshot":
                write_observation(browser, SESSION)
            # A batch is explicitly predeclared: keep the observation boundary
            # across ordinary ref-based edits so a known fill+fill+click flow
            # remains one call. Navigation, waits and tab changes still clear
            # refs and require an explicit snapshot before the next mutation.
            elif action["action"] in BATCH_INVALIDATING_ACTIONS:
                forget_observation(SESSION)
            continue
        stopped_reason = "action_error"
        batch_error_value = {**(error or {"code": "BROWSER_ACTION_FAILED", "message": "The browser action failed."}), "index": index, "action": action["action"]}
        results.append(batch_step_result(index, action, False, error=error, executed=False))
        break

    final_ok = False
    final_snapshot: Any = None
    final_error: dict[str, Any] | None = None
    action_timed_out = isinstance(batch_error_value, dict) and batch_error_value.get("code") == "BATCH_TIME_LIMIT"
    if time.monotonic() < deadline and not action_timed_out:
        final_ok, final_snapshot, final_error = batch_final_snapshot(browser, expected, deadline)
        if not final_ok and stopped_reason is None:
            stopped_reason = "final_snapshot_failed"
            batch_error_value = final_error
    elif stopped_reason is None or action_timed_out:
        stopped_reason = "time_limit"
        if not isinstance(batch_error_value, dict):
            batch_error_value = {"code": "BATCH_TIME_LIMIT", "message": "The batch time limit expired before the final snapshot."}
        final_error = batch_error_value

    value: dict[str, Any] = {
        "success": batch_error_value is None and final_ok,
        "requestedCount": len(actions),
        "executedCount": executed,
        "attemptedCount": attempted,
        "results": results,
        "finalSnapshot": final_snapshot,
        "finalSnapshotOk": final_ok,
        "finalSnapshotError": final_error,
        "partialSideEffects": attempted > 0,
        "sideEffectsPossible": attempted > 0,
        "stoppedReason": stopped_reason,
        "limits": {"maxSteps": payload["maxSteps"], "maxTimeMs": max_time, "maxOutputChars": max_output},
    }
    if batch_error_value is not None:
        value["error"] = batch_error_value
    if not final_ok:
        value["recovery"] = "The final snapshot failed. Successful or attempted actions may already have taken effect; take a fresh snapshot and do not repeat executed actions."
    return batch_trim_result(value, max_output)


def controlled(args: list[str], browser: dict[str, Any]) -> int:
    cdp = browser.get("cdp")
    if not isinstance(cdp, dict) or not isinstance(cdp.get("websocket_url"), str):
        return emit({"ok": False, "error": "managed Chrome returned no CDP websocket", "code": "BROWSER_ENDPOINT_UNAVAILABLE"}, 1)
    # Keep the same session across a manual takeover so the authenticated tab
    # remains the binding. Observation generation is tracked separately below.
    options = [
        *([] if has_session(args) else ["--session", SESSION]),
    ]
    command = [STOCK, *options, *args]
    try:
        result = invoke_guarded(command, capture=True, browser=browser)
    except FileNotFoundError:
        return emit({"ok": False, "error": "desktop-control is not installed", "code": "CONTROL_UNAVAILABLE"}, 1)
    if result.returncode != 0 and command_name(args) == "mcp" and not stock_mcp_response(result.stdout):
        return guarded_mcp_error(result.stdout or result.stderr, "The browser command was rejected.")
    if result.stdout:
        sys.stdout.write(result.stdout)
    if result.stderr:
        sys.stderr.write(result.stderr)
    if result.returncode == 0 and is_snapshot(args):
        # Snapshot output is the observation boundary; the stock client keeps
        # the pinned target and activates it internally before mutations.
        write_observation(browser, session_name(args))
    elif result.returncode == 0 and (is_mutation(command_name(args), args) or invalidates_observation(args)):
        forget_observation(session_name(args))
    return result.returncode


def argument_error(argv: list[str]) -> int | None:
    """Refuse a target override or an ambiguous session before anything runs."""
    override = target_override(argv)
    if override is not None:
        message = f"managed browser commands cannot override the pinned CDP target ({override.split('=', 1)[0]})"
        if command_name(argv) == "mcp":
            return mcp_error(message, "BROWSER_TARGET_MANAGED")
        return emit({"ok": False, "error": message, "code": "BROWSER_TARGET_MANAGED"}, 2)
    _, session_error = resolve_session(argv)
    if session_error is not None:
        if command_name(argv) == "mcp":
            return mcp_error(session_error, "BROWSER_SESSION_INVALID")
        return emit({"ok": False, "error": session_error, "code": "BROWSER_SESSION_INVALID"}, 2)
    return None


def inner_main(argv: list[str]) -> int:
    name = command_name(argv)
    if name == "batch":
        payload_arg = next((item for item in argv[argv.index("batch") + 1 :] if not item.startswith("-")), None) if "batch" in argv else None
        if payload_arg is None:
            return emit(batch_error("Use `browser batch '<json>'` with a declarative action list.", "BATCH_INPUT_INVALID"), 2)
        try:
            raw_payload = json.loads(payload_arg)
        except json.JSONDecodeError:
            return emit(batch_error("The browser batch JSON is invalid.", "BATCH_INPUT_INVALID"), 2)
        payload, validation_error = validate_batch_request(raw_payload)
        if validation_error:
            return emit(validation_error, 2)
        assert payload is not None
        started_at = time.monotonic()
        setup_remaining = payload["maxTimeMs"] / 1000 - (time.monotonic() - started_at)
        if setup_remaining <= 0:
            return emit(batch_error("The batch time limit expired before the managed browser was prepared.", "BATCH_TIME_LIMIT"), 1)
        browser = ensure(False, timeout=setup_remaining, bounded=True)
        if browser is None:
            code = LAST_ERROR_CODE or "BROWSER_ENDPOINT_UNAVAILABLE"
            return emit(batch_error(LAST_ERROR or "The managed browser is unavailable.", code), 1)
        browser_generation = strict_browser_generation()
        control_generation_value = strict_control_generation()
        if browser_generation is None or control_generation_value is None:
            return emit(batch_error("The managed browser/control state is missing or malformed; no action was sent.", "BROWSER_STATE_INVALID"), 1)
        return emit(
            run_batch(
                payload,
                browser,
                started_at,
                {"browserGeneration": browser_generation, "controlGeneration": control_generation_value},
            ),
            0,
        )
    if name == "mcp" and mcp_tool_name(argv) is None and "--help" not in argv and "-h" not in argv:
        return emit({"ok": False, "error": "use `agent-browser mcp call <tool> <json>`; the stdio MCP server is not exposed by this wrapper", "code": "MCP_CALL_REQUIRED"}, 2)
    rejected = argument_error(argv)
    if rejected is not None:
        return rejected
    if bypass(argv):
        # `browser close` is intentionally handled by stock CLI below: it only
        # disconnects the client and must never close the managed Chrome.
        return close_client(argv) if name == "close" else stock(argv)
    browser = ensure(name == "mcp")
    if browser is None:
        if name == "mcp":
            return guarded_mcp_error(LAST_ERROR, "The managed browser is unavailable.")
        return 1
    args = normalized_args(argv)
    if not observation_fresh(browser, session_name(argv)) and is_mutation(name, argv) and not is_safe_after_restart(name, argv):
        if name == "mcp":
            return mcp_error("Take a fresh browser snapshot before mutating the page.", "BROWSER_OBSERVATION_REQUIRED")
        return emit(
            {
                "ok": False,
                "error": "take a fresh browser snapshot before mutating the page",
                "code": "BROWSER_OBSERVATION_REQUIRED",
            },
            1,
        )
    if is_snapshot(argv):
        prepared = prepare_snapshot_target(browser, args)
        if prepared != 0:
            return prepared
    # No tab switch happens after the snapshot; refs remain bound to the page.
    # The stock client may perform its own CDP activation internally.
    return controlled(args, browser)


def main(argv: list[str]) -> int:
    # One action lease covers ensure, target reactivation and the stock command.
    # This prevents a viewer from acquiring control between focus and mutation.
    rejected = argument_error(argv)
    if rejected is not None:
        return rejected
    if (command_name(argv) == "mcp" and mcp_tool_name(argv) is None and "--help" not in argv and "-h" not in argv) or bypass(argv) or not Path(CONTROL).is_file() or lease_held():
        return inner_main(argv)
    command = [sys.executable, str(Path(__file__).resolve()), *argv]
    result = subprocess.run(
        [CONTROL, "run", "--pass-lease", "--", *command],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0 and command_name(argv) == "mcp":
        if stock_mcp_response(result.stdout):
            if result.stdout:
                sys.stdout.write(result.stdout)
            if result.stderr:
                sys.stderr.write(result.stderr)
            return result.returncode
        return guarded_mcp_error(result.stdout or result.stderr, "The browser command was rejected.")
    if result.stdout:
        sys.stdout.write(result.stdout)
    if result.stderr:
        sys.stderr.write(result.stderr)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
