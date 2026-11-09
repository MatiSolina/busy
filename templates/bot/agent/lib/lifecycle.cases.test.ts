import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { defined } from "../test-utils";
import { runningJobs, shouldStop } from "./lifecycle";

type Session = Parameters<typeof shouldStop>[0]["session"];

const as = (principalId: string) => ({
  current: { principalId, principalType: "app" },
});
const hub = as("hub");
const bot = as("owner:mati-solina:project:bot-lawyer:environment:production");
const parent = {
  callId: "c1",
  rootSessionId: "chat",
  sessionId: "chat",
  turn: { id: "t1", sequence: 1 },
};

const sessions: Record<string, Session> = {
  chat: { auth: hub, id: "chat" },
  consultation: { auth: bot, id: "q1" },
  consultationCopy: {
    auth: bot,
    id: "qcopy",
    parent: { ...parent, rootSessionId: "q1", sessionId: "q1" },
  },
  copy: { auth: hub, id: "copy", parent },
  localDev: { auth: as("local-dev"), id: "chat" },
  noAuth: { auth: undefined, id: "chat" },
  oldHubOidc: {
    auth: as("owner:mati-solina:project:busy-hub:environment:production"),
    id: "chat",
  },
  orphanCopy: { auth: { current: null }, id: "copy", parent },
  schedule: { auth: as("eve:app"), id: "sched" },
  unprotected: { auth: { current: null }, id: "chat" },
};

describe("shouldStop: table", () => {
  it.each<[string, keyof typeof sessions, string | null, boolean]>([
    ["the hub chat with no marker", "chat", null, true],
    ["the hub chat it opened", "chat", "chat", true],
    ["the hub chat whatever the marker says", "chat", "q1", true],
    ["an unprotected chat (current null)", "unprotected", null, true],
    ["a chat with no auth at all", "noAuth", null, true],
    ["a chat from the local dev server", "localDev", null, true],
    ["a scheduled session as the app", "schedule", null, true],
    ["a chat from the hub's old OIDC subject", "oldHubOidc", null, true],
    ["a consultation that opened the computer", "consultation", "q1", true],
    ["a consultation that never opened one", "consultation", null, false],
    [
      "a consultation whose marker names the chat",
      "consultation",
      "chat",
      false,
    ],
    ["a consultation with an empty marker", "consultation", "", false],
    ["a copy whose marker names its parent", "copy", "chat", false],
    ["a copy with no marker", "copy", null, false],
    ["a subagent that opened its own computer", "copy", "copy", true],
    [
      "a consultation's copy whose marker names the consultation",
      "consultationCopy",
      "q1",
      false,
    ],
    ["a copy with no caller", "orphanCopy", null, false],
  ])("idle, %s → %s", (_, key, owner, expected) => {
    expect(
      shouldStop({ idle: true, owner, session: defined(sessions[key]) })
    ).toBe(expected);
  });

  it.each(Object.keys(sessions))(
    "never stops while busy: %s with its own marker",
    (key) => {
      const session = defined(sessions[key]);
      expect(shouldStop({ idle: false, owner: session.id, session })).toBe(
        false
      );
    }
  );
});

describe("shouldStop: properties", () => {
  const id = fc.constantFrom("chat", "q1", "copy", "x");
  const owner = fc.option(id, { nil: null });
  const auth = fc.constantFrom(hub, bot, { current: null }, undefined);
  const withParent = fc.boolean();
  const session = fc
    .record({ auth, hasParent: withParent, id })
    .map(({ hasParent, ...s }): Session => (hasParent ? { ...s, parent } : s));
  const opts = { numRuns: 300, seed: 1 };

  it("is false whenever something is about to use the computer", () => {
    fc.assert(
      fc.property(owner, session, (o, s) => {
        expect(shouldStop({ idle: false, owner: o, session: s })).toBe(false);
      }),
      opts
    );
  });

  it("for any session with a parent, stops iff the marker names that session", () => {
    fc.assert(
      fc.property(owner, session, (o, s) => {
        const child = { ...s, parent };
        expect(shouldStop({ idle: true, owner: o, session: child })).toBe(
          o === child.id
        );
      }),
      opts
    );
  });

  it("always stops an idle top-level session that isn't a consultation", () => {
    fc.assert(
      fc.property(
        owner,
        id,
        fc.constantFrom(hub, { current: null }, undefined),
        (o, i, a) => {
          expect(
            shouldStop({ idle: true, owner: o, session: { auth: a, id: i } })
          ).toBe(true);
        }
      ),
      opts
    );
  });

  it("never lets a consultation stop a computer it didn't open", () => {
    fc.assert(
      fc.property(owner, id, withParent, (o, i, p) => {
        const s: Session = p
          ? { auth: bot, id: i, parent }
          : { auth: bot, id: i };
        expect(shouldStop({ idle: true, owner: o, session: s })).toBe(o === i);
      }),
      opts
    );
  });
});

describe("runningJobs: script text", () => {
  it("defaults to eve's job folder", () => {
    expect(runningJobs()).toContain("/tmp/.eve/jobs/*/");
  });

  it("puts the given root in the glob", () => {
    expect(runningJobs("/srv/jobs")).toContain("for d in /srv/jobs/*/;");
    expect(runningJobs("/srv/jobs")).not.toContain("/tmp/.eve/jobs");
  });

  it("ends with true so a missing folder never fails the command", () => {
    expect(runningJobs().trimEnd().endsWith("; true")).toBe(true);
  });
});

describe("runningJobs: against real folders", () => {
  const root = mkdtempSync(join(tmpdir(), "jobs-cases-"));
  const job = (id: string, files: Record<string, string>) => {
    mkdirSync(join(root, id));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(root, id, name), content);
    }
  };
  const exec = () =>
    spawnSync("bash", ["-c", runningJobs(root)], { encoding: "utf8" });
  const check = () =>
    execFileSync("bash", ["-c", runningJobs(root)], {
      encoding: "utf8",
    }).trim();
  const children: ChildProcess[] = [];
  const sleeper = (detached = true) => {
    const child = spawn("sleep", ["30"], { detached, stdio: "ignore" });
    children.push(child);
    return defined(child.pid);
  };

  afterEach(() => {
    for (const child of children.splice(0)) {
      child.kill("SIGKILL");
    }
    rmSync(root, { force: true, recursive: true });
    mkdirSync(root);
  });
  afterAll(() => rmSync(root, { force: true, recursive: true }));

  it("ignores a pid file with garbage", () => {
    job("garbage", { pid: "not-a-pid" });
    expect(check()).toBe("");
  });

  it("ignores an empty pid file", () => {
    job("empty", { pid: "" });
    expect(check()).toBe("");
  });

  it("reads a pid followed by a newline", () => {
    job("live", { pid: `${sleeper()}\n` });
    expect(check()).toBe("running");
  });

  it("treats an empty exit file as finished", () => {
    job("done", { exit: "", pid: String(sleeper()) });
    expect(check()).toBe("");
  });

  it("counts a live process that leads no process group as gone", () => {
    // Not detached: it shares the test runner's group, so `kill -0 -- -pid` finds no group.
    job("child", { pid: String(sleeper(false)) });
    expect(check()).toBe("");
  });

  it("prints one line per live job", () => {
    job("a", { pid: String(sleeper()) });
    job("b", { pid: String(sleeper()) });
    job("c", { exit: "0", pid: String(sleeper()) });
    expect(check().split("\n")).toEqual(["running", "running"]);
  });

  it("ignores plain files next to the job folders", () => {
    writeFileSync(join(root, "pid"), String(sleeper()));
    expect(check()).toBe("");
  });

  it.each([
    [
      "no jobs",
      () => {
        // Deliberate no-op fixture.
      },
    ],
    ["a live job", () => job("live", { pid: String(sleeper()) })],
    ["a broken job", () => job("odd", { pid: "x" })],
  ])("exits 0 with %s", (_, setup) => {
    setup();
    expect(exec().status).toBe(0);
  });
});
