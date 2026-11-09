import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// browser-wrapper.py runs for real against the real desktop-control.py (its kernel lease, its manual
// owner, its lease proof), a stub desktop-browser that reports a managed endpoint, and a stub stock
// agent-browser that records its arguments and the browser target it was given.
const SCRIPT = new URL("./browser-wrapper.py", import.meta.url).pathname;
const CONTROL_SCRIPT = new URL("./desktop-control.py", import.meta.url)
  .pathname;
const OBSERVATION_FILE = /^[0-9a-f]{32}\.json$/u;
const WS = "ws://127.0.0.1:9222/devtools/browser/test";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function box() {
  const root = mkdtempSync(join(tmpdir(), "browser-wrapper-"));
  roots.push(root);
  const desktopBrowser = join(root, "desktop-browser");
  writeFileSync(
    desktopBrowser,
    // Like the real helper, it also leaves the state in the runtime directory (the batch reads it).
    `#!/bin/sh\nmkdir -p "$BUSY_DESKTOP_RUNTIME"\nstate='{"ok":true,"generation":'"\${BROWSER_GENERATION:-1}"',"cdp":{"websocket_url":"${WS}"}}'\nprintf '%s\\n' "$state" > "$BUSY_DESKTOP_RUNTIME/browser.json"\nprintf '%s\\n' "$state"\n`,
    { mode: 0o755 }
  );
  const stock = join(root, "stock");
  writeFileSync(
    stock,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this fixture intentionally preserves shell parameter expansion literally
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$TEST_LOG/stock"\nprintf \'%s|%s|%s\\n\' "$*" "${AGENT_BROWSER_CDP:-}" "${AGENT_BROWSER_AUTO_CONNECT:-}" >> "$TEST_LOG/stock-env"\nif (: >&7) 2>/dev/null; then echo open; else echo closed; fi >> "$TEST_LOG/stock-fd7"\ncase " $* " in *" mcp call "*) [ "$STOCK_ERROR" = 1 ] && { printf \'%s\\n\' \'{"content":[{"type":"text","text":"tab gone"}],"structuredContent":{"response":{"success":false,"error":"tab gone","code":"tab_gone"}},"isError":true,"_meta":{"agentBrowserVersion":"0.41.1"}}\'; exit 1; } ;; esac\ncase " $* " in *" snapshot "*) printf \'%s\\n\' \'{"success":true,"data":{"snapshot":"page"}}\' ;; *" tab list "*) printf \'%s\\n\' \'{"success":true,"data":{"tabs":[{"tabId":"t1","targetId":"target-1","active":true}]}}\' ;; *) printf \'%s\\n\' \'{"success":true}\' ;; esac\n',
    { mode: 0o755 }
  );
  // The real helper, behind a shim that logs each call (exec keeps every inherited descriptor).
  const controlShim = join(root, "control");
  writeFileSync(
    controlShim,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TEST_LOG/control"\nexec python3 ${CONTROL_SCRIPT} "$@"\n`,
    { mode: 0o755 }
  );
  const runtime = join(root, "runtime");
  const log = join(root, "log");
  mkdirSync(log);
  return { control: controlShim, desktopBrowser, log, root, runtime, stock };
}
type Box = ReturnType<typeof box>;

function env(b: Box, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    BUSY_AGENT_BROWSER_STOCK_COMMAND: b.stock,
    BUSY_DESKTOP_BROWSER_COMMAND: b.desktopBrowser,
    BUSY_DESKTOP_CONTROL_COMMAND: b.control,
    BUSY_DESKTOP_RUNTIME: b.runtime,
    TEST_LOG: b.log,
    ...extra,
  };
}

function run(b: Box, args: string[], extra: Record<string, string> = {}) {
  return spawnSync("python3", [SCRIPT, ...args], {
    encoding: "utf8",
    env: env(b, extra),
  });
}

function control(b: Box, ...args: string[]) {
  return spawnSync("python3", [CONTROL_SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, BUSY_DESKTOP_RUNTIME: b.runtime },
  });
}

const lines = (b: Box, name: string) =>
  existsSync(join(b.log, name))
    ? readFileSync(join(b.log, name), "utf8").trim().split("\n")
    : [];
const stockCalls = (b: Box) => lines(b, "stock");

function batch(actions: unknown[], options: Record<string, unknown> = {}) {
  return JSON.stringify({ actions, ...options });
}

describe("browser wrapper", { timeout: 30_000 }, () => {
  it("delegates version without booting or acquiring desktop control", () => {
    const b = box();
    const result = run(b, ["--version"]);
    expect(result.status).toBe(0);
    expect(readFileSync(join(b.log, "stock"), "utf8")).toContain("--version");
    expect(lines(b, "control")).toEqual([]);
  });

  it("requires a fresh snapshot, then focuses the active tab under one guarded action", () => {
    const b = box();
    const blocked = run(b, ["click", "@e1"]);
    expect(blocked.status).toBe(1);
    expect(JSON.parse(blocked.stdout)).toMatchObject({
      code: "BROWSER_OBSERVATION_REQUIRED",
    });

    expect(run(b, ["snapshot", "--json"]).status).toBe(0);
    const click = run(b, ["click", "@e1"]);
    expect(click.status).toBe(0);
    const calls = stockCalls(b);
    expect(calls).toEqual(
      expect.arrayContaining([
        "--session busy-live tab list --json",
        "--session busy-live tab t1",
        "--session busy-live snapshot --json",
        "--session busy-live click @e1",
      ])
    );
    expect(
      calls.filter((call) => call === "--session busy-live tab t1")
    ).toHaveLength(1);
    // Each guarded command took the lease once, with proof for the wrapper.
    expect(
      lines(b, "control").filter((l) => l.startsWith("run --pass-lease --"))
    ).toHaveLength(3);
    // The stock CLI (which starts a daemon) never inherits the lease.
    expect(new Set(lines(b, "stock-fd7"))).toEqual(new Set(["closed"]));
  });

  it("returns a valid tools/call error envelope for a manual-control conflict", () => {
    const b = box();
    expect(control(b, "acquire", "viewer-a").status).toBe(0);
    const result = run(b, ["mcp", "call", "agent_browser_fill", "{}"]);
    expect(result.status).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({
      _meta: { agentBrowserVersion: "0.41.1" },
      isError: true,
    });
    expect(envelope.structuredContent.response).toMatchObject({
      code: "USER_CONTROL_ACTIVE",
      success: false,
    });
    expect(envelope.content[0].type).toBe("text");
    expect(stockCalls(b)).toEqual([]);
  });

  it("preserves stock MCP tab_gone recovery data", () => {
    const b = box();
    expect(run(b, ["snapshot", "--json"]).status).toBe(0);
    const result = run(b, ["mcp", "call", "agent_browser_fill", "{}"], {
      STOCK_ERROR: "1",
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      isError: true,
      structuredContent: { response: { code: "tab_gone" } },
    });
  });

  it("preserves stock JSON-RPC argument errors", () => {
    const b = box();
    writeFileSync(
      b.stock,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"error":{"code":-32602,"message":"Invalid arguments"},"_meta":{"agentBrowserVersion":"0.41.1"}}\'\nexit 1\n',
      { mode: 0o755 }
    );
    const result = run(b, ["mcp", "call", "agent_browser_open", "{}"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      _meta: { agentBrowserVersion: "0.41.1" },
      error: { code: -32_602, message: "Invalid arguments" },
    });
  });

  it("runs a short declarative batch under one wrapper invocation and returns final evidence", () => {
    const b = box();
    const result = run(b, [
      "batch",
      batch([
        { action: "open", url: "https://example.com" },
        { action: "wait_ms", ms: 1 },
      ]),
    ]);
    expect(result.status).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value).toMatchObject({
      executedCount: 2,
      finalSnapshotOk: true,
      partialSideEffects: true,
      requestedCount: 2,
      success: true,
    });
    const calls = readFileSync(join(b.log, "stock"), "utf8").trim().split("\n");
    expect(
      calls.filter((call) => call.includes("mcp call")).length
    ).toBeGreaterThanOrEqual(3);
    expect(value.results).toHaveLength(2);
  });

  it("allows a full-page scroll without a selector", () => {
    const b = box();
    const result = run(b, [
      "batch",
      batch([{ action: "scroll", amount: 500, direction: "down" }]),
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      executedCount: 1,
      finalSnapshotOk: true,
      success: true,
    });
    expect(readFileSync(join(b.log, "stock"), "utf8")).toContain(
      "mcp call agent_browser_scroll"
    );
  });

  it("rejects an invalid optional scroll selector before any action", () => {
    const b = box();
    const result = run(b, [
      "batch",
      batch([
        { action: "open", url: "https://example.com" },
        { action: "scroll", amount: 500, direction: "down", selector: "" },
      ]),
    ]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: "BATCH_ARGUMENT_INVALID" },
      success: false,
    });
    expect(() => readFileSync(join(b.log, "stock"), "utf8")).toThrow();
  });

  it("validates the entire batch before any browser action, including eval denial and path traversal", () => {
    const b = box();
    const result = run(b, [
      "batch",
      batch([
        { action: "open", url: "https://example.com" },
        { action: "eval", code: "document.body" },
      ]),
    ]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: "BATCH_ACTION_NOT_ALLOWED" },
      success: false,
    });
    expect(() => readFileSync(join(b.log, "stock"), "utf8")).toThrow();

    const pathResult = run(b, [
      "batch",
      batch([{ action: "screenshot", path: "/data/../secrets.png" }]),
    ]);
    expect(pathResult.status).toBe(2);
    expect(JSON.parse(pathResult.stdout)).toMatchObject({
      error: { code: "BATCH_ARGUMENT_INVALID" },
    });
  });

  it("stops after a partial error and retains action evidence", () => {
    const b = box();
    const result = run(
      b,
      [
        "batch",
        batch([
          { action: "open", url: "https://example.com" },
          { action: "click", selector: "@e1" },
        ]),
      ],
      { STOCK_ERROR: "1" }
    );
    expect(result.status).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value).toMatchObject({
      attemptedCount: 1,
      executedCount: 0,
      finalSnapshotError: { code: "tab_gone" },
      finalSnapshotOk: false,
      partialSideEffects: true,
      stoppedReason: "action_error",
      success: false,
    });
    expect(value.results[0]).toMatchObject({
      action: "open",
      attempted: true,
      success: false,
    });
    expect(value.recovery).toContain("do not repeat");
  });

  it("checks the control generation before every action and stops after takeover", () => {
    const b = box();
    writeFileSync(
      b.stock,
      `#!/bin/sh
printf '%s\n' "$*" >> "$TEST_LOG/stock"
count=$(wc -l < "$TEST_LOG/stock" | tr -d ' ')
if [ "$count" = 1 ]; then mkdir -p "$BUSY_DESKTOP_RUNTIME"; printf '%s\n' '{"generation":2,"owner":"human","expiresAt":4102444800000}' > "$BUSY_DESKTOP_RUNTIME/control.json"; fi
printf '%s\n' '{"success":true,"structuredContent":{"response":{"success":true,"data":{"ok":true}}}}'
`,
      { mode: 0o755 }
    );
    const result = run(b, [
      "batch",
      batch([
        { action: "open", url: "https://example.com" },
        { action: "wait_ms", ms: 1 },
      ]),
    ]);
    expect(result.status).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value).toMatchObject({
      executedCount: 1,
      finalSnapshotOk: false,
      partialSideEffects: true,
      stoppedReason: "human_takeover",
      success: false,
    });
    expect(value.results[1]).toMatchObject({
      attempted: false,
      success: false,
    });
  });

  it("keeps the batch response within the requested output cap", () => {
    const b = box();
    writeFileSync(
      b.stock,
      `#!/bin/sh
printf '%s\n' "$*" >> "$TEST_LOG/stock"
printf '%s' '{"success":true,"structuredContent":{"response":{"success":true,"data":{"text":"'
head -c 20000 /dev/zero | tr '\\0' a
printf '%s\n' '"}}}}'
`,
      { mode: 0o755 }
    );
    const result = run(b, [
      "batch",
      batch([{ action: "open", url: "https://example.com" }], {
        maxOutputChars: 1024,
      }),
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(1024 + 1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outputLimit: 1024,
      truncated: true,
    });
  });

  it("stops on the batch time limit and marks the in-flight action unknown", () => {
    const b = box();
    writeFileSync(b.stock, "#!/bin/sh\nyes x & wait\n", { mode: 0o755 });
    const result = run(b, [
      "batch",
      batch([{ action: "open", timeoutMs: 1000, url: "https://example.com" }], {
        maxTimeMs: 30_000,
      }),
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: "BATCH_TIME_LIMIT" },
      partialSideEffects: true,
      success: false,
    });
  });

  it("kills a background descendant when the stock shell exits on timeout", () => {
    const b = box();
    writeFileSync(
      b.stock,
      '#!/bin/sh\nsleep 30 & child=$!\nprintf \'%s\\n\' "$child" > "$TEST_LOG/child.pid"\nwait\n',
      { mode: 0o755 }
    );
    const result = run(b, [
      "batch",
      batch([{ action: "open", timeoutMs: 1000, url: "https://example.com" }], {
        maxTimeMs: 30_000,
      }),
    ]);
    expect(result.status).toBe(0);
    const child = Number.parseInt(
      readFileSync(join(b.log, "child.pid"), "utf8"),
      10
    );
    let alive = true;
    try {
      process.kill(child, 0);
    } catch {
      alive = false;
    }
    if (alive) {
      process.kill(child, "SIGKILL");
    }
    expect(alive).toBe(false);
  });

  it("drains noisy stock output without buffering an unbounded response", () => {
    const b = box();
    writeFileSync(
      b.stock,
      "#!/bin/sh\nhead -c 10485760 /dev/zero | tr '\\0' x\nprintf '\\n'\nprintf '%s\\n' '{\"success\":true}'\n",
      { mode: 0o755 }
    );
    const result = run(b, [
      "batch",
      batch([{ action: "open", url: "https://example.com" }]),
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeLessThan(20_000);
    expect(JSON.parse(result.stdout)).toMatchObject({
      finalSnapshotOk: true,
      success: true,
    });
  });

  it("fails closed when the managed browser state is malformed", () => {
    const b = box();
    writeFileSync(
      b.desktopBrowser,
      '#!/bin/sh\nmkdir -p "$BUSY_DESKTOP_RUNTIME"\nprintf \'%s\\n\' \'not-json\' > "$BUSY_DESKTOP_RUNTIME/browser.json"\nprintf \'%s\\n\' \'{"ok":true,"generation":1,"cdp":{"websocket_url":"ws://127.0.0.1:9222/devtools/browser/test"}}\'\n',
      { mode: 0o755 }
    );
    const result = run(b, [
      "batch",
      batch([{ action: "open", url: "https://example.com" }]),
    ]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: "BROWSER_STATE_INVALID" },
    });
    expect(() => readFileSync(join(b.log, "stock"), "utf8")).toThrow();
  });
});

describe("browser wrapper: the managed CDP target (H-41)", {
  timeout: 30_000,
}, () => {
  it.each([
    [["--cdp", "ws://127.0.0.1:9", "snapshot"]],
    [["--cdp=ws://127.0.0.1:9", "snapshot"]],
    [["snapshot", "--cdp", "ws://127.0.0.1:9"]],
    [["snapshot", "--cdp=ws://127.0.0.1:9"]],
    [["--auto-connect", "snapshot"]],
    [["--auto-connect=true", "snapshot"]],
    [["snapshot", "--auto-connect"]],
    [["--no-pin-tab", "click", "@e1"]],
    [["--no-pin-tab=1", "click", "@e1"]],
    [["click", "@e1", "--no-pin-tab"]],
    [["--provider", "browserbase", "snapshot"]],
    [["-p", "browserbase", "snapshot"]],
    [["connect", "9222"]],
    [["close", "--cdp", "ws://127.0.0.1:9"]],
    [["--version", "--cdp=ws://127.0.0.1:9"]],
  ])("refuses %j before reaching the stock CLI or the lease", (args) => {
    const b = box();
    const result = run(b, args);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "BROWSER_TARGET_MANAGED",
      ok: false,
    });
    expect(stockCalls(b)).toEqual([]);
    expect(lines(b, "control")).toEqual([]);
  });

  it("refuses an override after an MCP payload as an MCP error", () => {
    const b = box();
    const result = run(b, [
      "mcp",
      "call",
      "agent_browser_snapshot",
      "{}",
      "--cdp=ws://127.0.0.1:9",
    ]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).structuredContent.response).toMatchObject({
      code: "BROWSER_TARGET_MANAGED",
    });
    expect(stockCalls(b)).toEqual([]);
  });

  it("does not mistake --cdp inside an MCP JSON payload for an option", () => {
    const b = box();
    const payload = '{"text":"--cdp ws://evil","extra":"--cdp=x"}';
    const result = run(b, ["mcp", "call", "agent_browser_snapshot", payload]);
    expect(result.status).toBe(0);
    expect(stockCalls(b)).toContain(
      `--session busy-live mcp call agent_browser_snapshot ${payload}`
    );
  });

  it("gives the stock CLI only the managed endpoint, whatever the caller's environment says", () => {
    const b = box();
    run(b, ["snapshot", "--json"], {
      AGENT_BROWSER_AUTO_CONNECT: "1",
      AGENT_BROWSER_CDP: "ws://127.0.0.1:9/evil",
      AGENT_BROWSER_SESSION: "other",
    });
    for (const line of lines(b, "stock-env")) {
      expect(line.split("|").slice(1)).toEqual([WS, ""]);
    }
    expect(stockCalls(b)).toContain("--session busy-live snapshot --json");
  });

  it.each([
    [["--session=other", "snapshot"]],
    [["snapshot", "--session=other"]],
    [["--session", "a", "snapshot", "--session", "b"]],
    [["snapshot", "--session"]],
    [
      [
        "mcp",
        "call",
        "agent_browser_snapshot",
        '{"session":"b"}',
        "--session",
        "a",
      ],
    ],
  ])("refuses the unsupported or ambiguous session in %j", (args) => {
    const b = box();
    const result = run(b, args);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("BROWSER_SESSION_INVALID");
    expect(stockCalls(b)).toEqual([]);
  });

  it("uses a session given after the command for the gate and for the stock CLI alike", () => {
    const b = box();
    expect(run(b, ["snapshot", "--json", "--session", "work"]).status).toBe(0);
    expect(run(b, ["click", "@e1", "--session", "work"]).status).toBe(0);
    expect(stockCalls(b)).toEqual(
      expect.arrayContaining([
        "--session work tab list --json",
        "snapshot --json --session work",
        "click @e1 --session work",
      ])
    );
  });
});

describe("browser wrapper: observations per session (H-41)", {
  timeout: 30_000,
}, () => {
  it("never lets a snapshot of session A authorize a mutation in session B", () => {
    const b = box();
    expect(run(b, ["--session", "a", "snapshot", "--json"]).status).toBe(0);
    const other = run(b, ["--session", "b", "click", "@e1"]);
    expect(other.status).toBe(1);
    expect(JSON.parse(other.stdout)).toMatchObject({
      code: "BROWSER_OBSERVATION_REQUIRED",
    });
    expect(run(b, ["--session", "a", "click", "@e1"]).status).toBe(0);
    expect(stockCalls(b)).not.toContain("--session b click @e1");
  });

  it("forgets only the session that mutated", () => {
    const b = box();
    run(b, ["--session", "a", "snapshot", "--json"]);
    run(b, ["--session", "b", "snapshot", "--json"]);
    expect(run(b, ["--session", "a", "click", "@e1"]).status).toBe(0);
    expect(run(b, ["--session", "a", "click", "@e2"]).status).toBe(1);
    expect(run(b, ["--session", "b", "click", "@e1"]).status).toBe(0);
  });

  it("invalidates every session's snapshot when control changes hands", () => {
    const b = box();
    run(b, ["--session", "a", "snapshot", "--json"]);
    run(b, ["--session", "b", "snapshot", "--json"]);
    expect(control(b, "acquire", "viewer-a").status).toBe(0);
    expect(control(b, "release", "viewer-a").status).toBe(0);
    for (const session of ["a", "b"]) {
      const result = run(b, ["--session", session, "click", "@e1"]);
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: "BROWSER_OBSERVATION_REQUIRED",
      });
    }
  });

  it("invalidates snapshots taken against an earlier Chrome", () => {
    const b = box();
    run(b, ["snapshot", "--json"], { BROWSER_GENERATION: "1" });
    const result = run(b, ["click", "@e1"], { BROWSER_GENERATION: "2" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "BROWSER_OBSERVATION_REQUIRED",
    });
  });

  it("keeps observation records private, one file per session", () => {
    const b = box();
    run(b, ["--session", "a", "snapshot", "--json"]);
    run(b, ["--session", "../../b", "snapshot", "--json"]);
    const dir = join(b.runtime, "browser-observations");
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX mode checks require masking mode bits
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const files = readdirSync(dir);
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(file).toMatch(OBSERVATION_FILE);
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX mode checks require masking mode bits
      expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    }
  });
});

describe("browser wrapper: manual control is not skipped by an environment variable (H-20)", {
  timeout: 30_000,
}, () => {
  it.each([
    [{ BUSY_DESKTOP_CONTROLLED: "1" }],
    [{ BUSY_BROWSER_WRAPPER_CONTROLLED: "1", BUSY_DESKTOP_CONTROLLED: "1" }],
    [{ BUSY_DESKTOP_LEASE_FD: "7" }],
    [{ BUSY_DESKTOP_LEASE_FD: "0", BUSY_DESKTOP_LEASE_MODE: "manual" }],
  ])("refuses a mutation during manual control with %j", (forged) => {
    const b = box();
    expect(run(b, ["snapshot", "--json"]).status).toBe(0);
    expect(control(b, "acquire", "viewer-a").status).toBe(0);
    const result = run(b, ["click", "@e1"], forged);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: "CONTROL_BUSY" });
    expect(stockCalls(b)).not.toContain("--session busy-live click @e1");
  });
});
