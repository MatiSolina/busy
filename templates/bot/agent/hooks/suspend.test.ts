import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markComputerOpened, runningJobs } from "../lib/lifecycle";
import { defined } from "../test-utils";
import hook from "./suspend";

// eve's durable state and session view only exist inside a running step: stand-ins here.
const { states, idle } = vi.hoisted(() => ({
  idle: vi.fn<(view: unknown) => boolean>(),
  states: new Map<string, unknown>(),
}));
vi.mock("eve/context", () => ({
  defineState: (name: string, init: () => unknown) => ({
    get: () => (states.has(name) ? states.get(name) : init()),
    update: (fn: (v: unknown) => unknown) =>
      states.set(name, fn(states.has(name) ? states.get(name) : init())),
  }),
}));
vi.mock("eve/events", () => ({ idle }));
const { hubFetch } = vi.hoisted(() => ({ hubFetch: vi.fn() }));
vi.mock("../lib/hub", () => ({ hubFetch }));

type Handler = (event: unknown, ctx: unknown) => Promise<void>;
const turnSettled = (hook.events as unknown as Record<"turn.settled", Handler>)[
  "turn.settled"
];

const as = (principalId: string) => ({
  current: { principalId, principalType: "app" },
  initiator: null,
});
const hub = as("hub");
const bot = as("owner:t:project:bot-lawyer:environment:production");
const parent = {
  callId: "c1",
  rootSessionId: "chat",
  sessionId: "chat",
  turn: { id: "t1", sequence: 1 },
};

let sandbox: { run: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
let getSandbox: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;

const settle = (
  session: { id: string; auth: unknown; parent?: unknown },
  abortSignal = new AbortController().signal
) =>
  turnSettled(
    {},
    {
      getSandbox,
      occurrence: { abortSignal },
      session,
      view: { marker: "view" },
    }
  );

// A stand-in for the hub's handshake (apps/hub/app/api/bot/live): each action answers from here.
const CLAIM = "33333333-3333-4333-8333-333333333333";
type Answer = () => Response | Promise<Response>;
let answers: Record<string, Answer>;
let actions: string[];
const ok = (body: Record<string, unknown>) => () => Response.json(body);

beforeEach(() => {
  states.clear();
  idle.mockReset().mockReturnValue(true);
  actions = [];
  answers = {
    claim: ok({ claim: CLAIM, generation: 3, ok: true }),
    commit: ok({ ok: true }),
    release: ok({ ok: true }),
    verify: ok({ ok: true }),
  };
  hubFetch
    .mockReset()
    .mockImplementation(async (_path: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { action: string };
      actions.push(body.action);
      return await (answers[body.action] ?? ok({ ok: false }))();
    });
  sandbox = {
    run: vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "" })),
    stop: vi.fn(async () => {
      // Deliberate no-op: this mock only records that stop was called.
    }),
  };
  getSandbox = vi.fn(async () => sandbox);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {
    // Deliberate no-op: suppress expected warning output in this test.
  });
});
afterEach(() => warn.mockRestore());

describe("suspend hook", () => {
  it("stops the chat's computer when the turn settles with nothing left", async () => {
    await settle({ auth: hub, id: "chat" });
    expect(sandbox.stop).toHaveBeenCalledTimes(1);
  });

  it("asks eve whether the session is idle from this turn's view", async () => {
    await settle({ auth: hub, id: "chat" });
    expect(idle).toHaveBeenCalledWith({ marker: "view" });
  });

  it("checks for background jobs with eve's job folder before stopping", async () => {
    await settle({ auth: hub, id: "chat" });
    expect(sandbox.run).toHaveBeenCalledTimes(2);
    expect(
      (defined(defined(sandbox.run.mock.calls[0])[0]) as { command: string })
        .command
    ).toBe(runningJobs());
    expect(
      (defined(defined(sandbox.run.mock.calls[1])[0]) as { command: string })
        .command
    ).toBe("desktop-browser stop");
    expect(defined(sandbox.run.mock.invocationCallOrder[0])).toBeLessThan(
      defined(sandbox.run.mock.invocationCallOrder[1])
    );
    expect(defined(sandbox.run.mock.invocationCallOrder[1])).toBeLessThan(
      defined(sandbox.stop.mock.invocationCallOrder[0])
    );
  });

  it("leaves the computer on while a message, task or compaction is pending", async () => {
    idle.mockReturnValue(false);
    await settle({ auth: hub, id: "chat" });
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it.each([
    ["one job", "running\n"],
    ["several jobs", "running\nrunning\n"],
  ])(
    "leaves it on with %s still running in the background",
    async (_, stdout) => {
      sandbox.run.mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout });
      await settle({ auth: hub, id: "chat" });
      expect(sandbox.stop).not.toHaveBeenCalled();
    }
  );

  it("stops when the job check prints only whitespace", async () => {
    sandbox.run.mockResolvedValueOnce({
      exitCode: 0,
      stderr: "",
      stdout: " \n\t\n",
    });
    await settle({ auth: hub, id: "chat" });
    expect(sandbox.stop).toHaveBeenCalledTimes(1);
  });

  it("still stops compute when closing the desktop browser fails", async () => {
    sandbox.run
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" })
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr: "close failed",
        stdout: "",
      });
    await settle({ auth: hub, id: "chat" });
    expect(sandbox.stop).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "suspend: could not close the desktop browser",
      expect.objectContaining({ exitCode: 1, sessionId: "chat" })
    );
  });

  it("stops a consultation's computer that the consultation opened", async () => {
    markComputerOpened("q1");
    await settle({ auth: bot, id: "q1" });
    expect(sandbox.stop).toHaveBeenCalledTimes(1);
  });

  it("never wakes a computer a consultation didn't open", async () => {
    await settle({ auth: bot, id: "q1" });
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("never stops from a copy that shares its parent's computer", async () => {
    markComputerOpened("chat");
    await settle({ auth: hub, id: "copy", parent });
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the stop fails",
      () => sandbox.stop.mockRejectedValueOnce(new Error("409")),
    ],
    [
      "the job check fails",
      () => sandbox.run.mockRejectedValueOnce(new Error("timeout")),
    ],
    [
      "the computer can't be reached",
      () => getSandbox.mockRejectedValueOnce(new Error("gone")),
    ],
    [
      "eve can't read the view",
      () =>
        idle.mockImplementationOnce(() => {
          throw new Error("no view");
        }),
    ],
  ])("only warns when %s", async (_, fail) => {
    fail();
    await expect(settle({ auth: hub, id: "chat" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "suspend: could not stop the computer",
      expect.objectContaining({ sessionId: "chat" })
    );
  });

  it("doesn't stop after a failed job check", async () => {
    sandbox.run.mockRejectedValueOnce(new Error("timeout"));
    await settle({ auth: hub, id: "chat" });
    expect(sandbox.stop).not.toHaveBeenCalled();
  });

  it("bounds the job check by the occurrence's signal", async () => {
    await settle({ auth: hub, id: "chat" }, AbortSignal.abort());
    expect(
      (
        defined(defined(sandbox.run.mock.calls[0])[0]) as {
          signal: AbortSignal;
        }
      ).signal.aborted
    ).toBe(true);
  });

  describe("the hub's shutdown claim", () => {
    const sent = () =>
      hubFetch.mock.calls.map(
        ([, init]) => JSON.parse(String((init as RequestInit).body)) as unknown
      );

    it("claims this session, re-checks before Chrome, commits before the stop, then releases", async () => {
      await settle({ auth: hub, id: "chat" });
      expect(actions).toEqual(["claim", "verify", "commit", "release"]);
      expect(sent()[0]).toEqual({ action: "claim", sessionId: "chat" });
      expect(sent()[2]).toEqual({
        action: "commit",
        claim: CLAIM,
        generation: 3,
        sessionId: "chat",
      });
      expect(hubFetch).toHaveBeenCalledWith(
        "/api/bot/live",
        expect.objectContaining({ method: "POST" })
      );
      // claim → jobs → verify → close Chrome → commit → stop.
      const order = (n: number) =>
        defined(hubFetch.mock.invocationCallOrder[n]);
      const run = (n: number) =>
        defined(sandbox.run.mock.invocationCallOrder[n]);
      expect(order(0)).toBeLessThan(run(0));
      expect(run(0)).toBeLessThan(order(1));
      expect(order(1)).toBeLessThan(run(1));
      expect(run(1)).toBeLessThan(order(2));
      expect(order(2)).toBeLessThan(
        defined(sandbox.stop.mock.invocationCallOrder[0])
      );
    });

    it("keeps the computer on when the hub denies the claim (the user watching, a message, a login)", async () => {
      answers.claim = ok({ ok: false });
      await settle({ auth: hub, id: "chat" });
      expect(getSandbox).not.toHaveBeenCalled();
      expect(sandbox.stop).not.toHaveBeenCalled();
      expect(actions).toEqual(["claim"]);
    });

    it.each([
      ["answers an error", () => new Response("boom", { status: 500 })],
      ["answers something else", () => Response.json({ watched: false })],
      [
        "answers a claim without its generation",
        () => Response.json({ claim: CLAIM, ok: true }),
      ],
    ])("never stops when the hub %s", async (_, answer) => {
      answers.claim = answer;
      await settle({ auth: hub, id: "chat" });
      expect(sandbox.stop).not.toHaveBeenCalled();
      expect(getSandbox).not.toHaveBeenCalled();
    });

    it("never stops when the hub can't be reached, and retries the claim only once", async () => {
      answers.claim = () => Promise.reject(new TypeError("fetch failed"));
      await settle({ auth: hub, id: "chat" });
      expect(actions).toEqual(["claim", "claim"]);
      expect(sandbox.stop).not.toHaveBeenCalled();
    });

    it("leaves Chrome and the computer alone when the claim is lost before closing Chrome", async () => {
      answers.verify = ok({ ok: false });
      await settle({ auth: hub, id: "chat" });
      expect(sandbox.run).toHaveBeenCalledTimes(1); // only the job check
      expect(sandbox.stop).not.toHaveBeenCalled();
      expect(actions).toEqual(["claim", "verify", "release"]);
    });

    it("doesn't stop when Live opens between the first query and the stop", async () => {
      // The hub granted the claim and the re-check; the user opens Live while Chrome closes, which
      // advances the generation: the commit right before sandbox.stop() fails.
      let opened!: () => void;
      const liveOpened = new Promise<void>((r) => {
        opened = r;
      });
      sandbox.run.mockImplementation(({ command }: { command: string }) => {
        if (command === "desktop-browser stop") {
          opened();
        }
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
      });
      answers.commit = async () => {
        await liveOpened;
        return Response.json({ ok: false });
      };
      await settle({ auth: hub, id: "chat" });
      expect(sandbox.stop).not.toHaveBeenCalled();
      expect(actions).toEqual(["claim", "verify", "commit", "release"]);
    });

    it("doesn't stop when the commit can't be verified", async () => {
      answers.commit = () => new Response("down", { status: 503 });
      await settle({ auth: hub, id: "chat" });
      expect(sandbox.stop).not.toHaveBeenCalled();
    });

    it("stops a computer the hub doesn't coordinate with a null claim, without a release", async () => {
      answers.claim = ok({ claim: null, generation: null, ok: true });
      markComputerOpened("q1");
      await settle({ auth: bot, id: "q1" });
      expect(sandbox.stop).toHaveBeenCalledOnce();
      expect(actions).toEqual(["claim", "verify", "commit"]);
    });

    it("releases the claim when the stop fails", async () => {
      sandbox.stop.mockRejectedValueOnce(new Error("409"));
      await settle({ auth: hub, id: "chat" });
      expect(actions.at(-1)).toBe("release");
    });

    it("doesn't ask the hub when the computer stays on anyway", async () => {
      idle.mockReturnValue(false);
      await settle({ auth: hub, id: "chat" });
      expect(hubFetch).not.toHaveBeenCalled();
    });
  });
});
