import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it as test } from "vitest";

// Parser parity of the real pinned agent-browser 0.41.1 binary, which the wrapper's argument checks
// rely on (H-41). Opt-in, because the binary isn't a repo dependency:
//
//   AGENT_BROWSER_PARSER_BIN=/path/to/agent-browser-<platform>   the binary as this host sees it
//   AGENT_BROWSER_PARSER_WRAP="docker run --rm -i --platform linux/amd64 --network none -v <bin dir>:/ab:ro debian:bookworm-slim"
//   AGENT_BROWSER_PARSER_TARGET=/ab/agent-browser-linux-x64     the binary inside the wrapper, if any
//
// Nothing here starts a browser: `session info` only reports the parsed session, and the CDP cases
// point at a closed loopback port.
const BIN = process.env.AGENT_BROWSER_PARSER_BIN;
const WRAP = (process.env.AGENT_BROWSER_PARSER_WRAP ?? "")
  .split(" ")
  .filter(Boolean);
const TARGET = process.env.AGENT_BROWSER_PARSER_TARGET ?? BIN ?? "";
const home = mkdtempSync(join(tmpdir(), "ab-parser-"));
afterAll(() => rmSync(home, { force: true, recursive: true }));

function stock(args: string[]) {
  const [cmd, ...rest] = WRAP.length
    ? [...WRAP, "env", "HOME=/tmp", TARGET, ...args]
    : [TARGET, ...args];
  const result = spawnSync(cmd ?? "", rest, {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
    timeout: 60_000,
  });
  const last = (result.stdout || result.stderr).trim().split("\n").at(-1);
  return { json: JSON.parse(last ?? "null"), status: result.status };
}

describe.runIf(BIN)(
  "agent-browser 0.41.1 parser (real binary)",
  { timeout: 120_000 },
  () => {
    test("reports the pinned version", () => {
      const [cmd, ...rest] = WRAP.length
        ? [...WRAP, TARGET, "--version"]
        : [TARGET, "--version"];
      expect(spawnSync(cmd ?? "", rest, { encoding: "utf8" }).stdout).toContain(
        "0.41.1"
      );
    });

    test.each([
      [["--session", "probe", "session", "info", "--json"], "probe"],
      [["session", "info", "--json", "--session", "probe"], "probe"],
      // Silently ignored after the command: the wrapper refuses it.
      [["session", "info", "--json", "--session=probe"], "default"],
    ])("parses %j as session %s", (args, session) => {
      const { json, status } = stock(args);
      expect(status).toBe(0);
      expect(json.data.session).toBe(session);
    });

    test.each([
      ["--session=probe"],
      ["--cdp=ws://127.0.0.1:9"],
      ["--auto-connect=true"],
      ["--no-pin-tab=1"],
    ])("rejects %s before the command as an unknown command", (flag) => {
      const { json, status } = stock([flag, "session", "info", "--json"]);
      expect(status).toBe(1);
      expect(json.type).toBe("unknown_command");
    });

    test.each([
      [
        [
          "--session",
          "busy-live",
          "--cdp",
          "ws://127.0.0.1:9",
          "snapshot",
          "--json",
        ],
      ],
      [
        [
          "--session",
          "busy-live",
          "snapshot",
          "--json",
          "--cdp",
          "ws://127.0.0.1:9",
        ],
      ],
    ])(
      "honours a separated --cdp in %j: the wrapper must refuse it everywhere",
      (args) => {
        const { json, status } = stock(args);
        expect(status).toBe(1);
        expect(String(json.error)).toContain("CDP WebSocket connect failed");
      }
    );

    test("resolves the same session in the wrapper and in the binary", () => {
      const dir = mkdtempSync(join(tmpdir(), "ab-parser-wrapper-"));
      try {
        const desktopBrowser = join(dir, "desktop-browser");
        writeFileSync(
          desktopBrowser,
          '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"generation":1,"cdp":{"websocket_url":"ws://127.0.0.1:9"}}\'\n',
          { mode: 0o755 }
        );
        const stockShim = join(dir, "stock");
        writeFileSync(
          stockShim,
          `#!/bin/sh\nexec ${[...WRAP, ...(WRAP.length ? ["env", "HOME=/tmp"] : []), TARGET].join(" ")} "$@"\n`,
          { mode: 0o755 }
        );
        const result = spawnSync(
          "python3",
          [
            new URL("./browser-wrapper.py", import.meta.url).pathname,
            "session",
            "info",
            "--json",
            "--session",
            "work",
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              BUSY_AGENT_BROWSER_STOCK_COMMAND: stockShim,
              BUSY_DESKTOP_BROWSER_COMMAND: desktopBrowser,
              BUSY_DESKTOP_CONTROL_COMMAND: join(dir, "absent"),
              BUSY_DESKTOP_RUNTIME: join(dir, "runtime"),
              HOME: home,
            },
            timeout: 60_000,
          }
        );
        const json = JSON.parse(
          result.stdout.trim().split("\n").at(-1) ?? "null"
        );
        expect(json.data.session).toBe("work");
      } finally {
        rmSync(dir, { force: true, recursive: true });
      }
    });
  }
);
