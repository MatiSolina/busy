import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("desktop-browser managed-process identity", () => {
  it("accepts normal and rewritten argv shapes but rejects a profile prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-browser-identity-"));
    roots.push(root);
    const script = `
import importlib.util, pathlib
spec = importlib.util.spec_from_file_location("desktop_browser", "images/bot-base/desktop-browser.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
profile = str(pathlib.Path.home() / ".config" / "busy-chrome-profile")
state = {"profile": profile, "pid": 123, "process_instance": "instance", "pid_starttime": "start"}
m.process_alive = lambda pid: True
m.process_starttime = lambda pid: "start"
for cmdline in (["/opt/google-chrome", "--user-data-dir=" + profile], ["/opt/google-chrome --user-data-dir=" + profile + " --remote-debugging-port=1"], ["/opt/google-chrome", "--user-data-dir=" + profile + "-evil"]):
    m.process_cmdline = lambda pid, cmdline=cmdline: cmdline
    print("1" if m.managed_process(state) else "0")
`;
    const result = spawnSync("python3", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, HOME: root },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["1", "1", "0"]);
  });
});
