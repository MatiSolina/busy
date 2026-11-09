import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defined } from "../test-utils";
import { markComputerOpened, runningJobs, shouldStop } from "./lifecycle";

describe("shouldStop", () => {
  const as = (principalId: string) => ({
    current: { principalId, principalType: "app" },
  });
  const hub = as("owner:mati-solina:project:busy-hub:environment:production");
  const bot = as("owner:mati-solina:project:bot-lawyer:environment:production");
  const parent = {
    callId: "c1",
    rootSessionId: "chat",
    sessionId: "chat",
    turn: { id: "t1", sequence: 1 },
  };
  const chat = { auth: hub, id: "chat" };
  const consultation = { auth: bot, id: "q1" };

  it("stops the main chat's computer, even one opened before the marker existed", () => {
    expect(shouldStop({ idle: true, owner: null, session: chat })).toBe(true);
    expect(shouldStop({ idle: true, owner: "chat", session: chat })).toBe(true);
  });

  it("keeps it on while anything is about to use it", () => {
    expect(shouldStop({ idle: false, owner: "chat", session: chat })).toBe(
      false
    );
    expect(
      shouldStop({ idle: false, owner: "q1", session: consultation })
    ).toBe(false);
  });

  it("stops a consultation's computer only if that consultation opened it", () => {
    expect(shouldStop({ idle: true, owner: "q1", session: consultation })).toBe(
      true
    );
    // Never opened one: asking for it would create it.
    expect(shouldStop({ idle: true, owner: null, session: consultation })).toBe(
      false
    );
  });

  it("never stops from a built-in agent copy, which shares its parent's computer", () => {
    const copy = { auth: hub, id: "copy", parent };
    expect(shouldStop({ idle: true, owner: null, session: copy })).toBe(false);
    // A copy that opened the computer first recorded its parent's id.
    expect(shouldStop({ idle: true, owner: "chat", session: copy })).toBe(
      false
    );
    expect(
      shouldStop({ idle: true, owner: "q1", session: { ...copy, auth: bot } })
    ).toBe(false);
  });
});

describe("markComputerOpened", () => {
  it("never throws, even outside an eve context", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      // Deliberate no-op: suppress expected warning output in this test.
    });
    expect(() => markComputerOpened("s1")).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("runningJobs", () => {
  const root = mkdtempSync(join(tmpdir(), "jobs-"));
  const job = (id: string, files: Record<string, string>) => {
    mkdirSync(join(root, id));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(root, id, name), content);
    }
  };
  const check = (dir = root) =>
    execFileSync("bash", ["-c", runningJobs(dir)], { encoding: "utf8" }).trim();
  const sleepers: number[] = [];

  afterEach(() => {
    for (const pid of sleepers.splice(0)) {
      process.kill(-pid);
    }
    rmSync(root, { force: true, recursive: true });
    mkdirSync(root);
  });

  it("finds nothing without jobs", () => {
    expect(check(join(root, "missing"))).toBe("");
    expect(check()).toBe("");
  });

  it("ignores finished jobs, dead processes and dirs without a pid", () => {
    const dead = spawnSync("true").pid;
    job("done", { exit: "0", pid: String(process.pid) });
    job("killed", { pid: String(dead) });
    job("odd", {});
    expect(check()).toBe("");
  });

  it("finds a job whose process group is alive", () => {
    // detached: its own process group, like eve's background jobs.
    const sleeper = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    sleepers.push(defined(sleeper.pid));
    job("done", { exit: "0", pid: String(sleeper.pid) });
    job("live", { pid: String(sleeper.pid) });
    expect(check()).toBe("running");
  });
});
