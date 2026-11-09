import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import instructions from "../instructions/computer-image";
import {
  BOT_BASE_IMAGE_VERSION,
  classifyImage,
  imageNotice,
} from "../lib/computer-image";
import { markComputerOpened } from "../lib/lifecycle";
import hook from "./computer-image";

// eve's durable state only exists inside a running step: a Map stands in for it (as in
// suspend.test.ts), so lib/computer-image.ts and lib/lifecycle.ts run for real.
const { states } = vi.hoisted(() => ({ states: new Map<string, unknown>() }));
vi.mock("eve/context", () => ({
  defineState: (name: string, init: () => unknown) => ({
    get: () => (states.has(name) ? states.get(name) : init()),
    update: (fn: (v: unknown) => unknown) =>
      states.set(name, fn(states.has(name) ? states.get(name) : init())),
  }),
}));

type Handler = (event: unknown, ctx: unknown) => Promise<void>;
const turnStarted = (hook.events as unknown as Record<"turn.started", Handler>)[
  "turn.started"
];

let marker: string | null;
let sandbox: { readTextFile: ReturnType<typeof vi.fn> };
let getSandbox: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;
const start = () => turnStarted({}, { getSandbox, session: { id: "chat" } });
const image = () =>
  states.get("busy.computer-image") as
    | { expected: string; found: string | null; status: string }
    | undefined;

// A defineDynamic keeps its resolver under a symbol.
const resolveInstructions = () => {
  const t = instructions as unknown as Record<symbol, unknown>;
  const key = Object.getOwnPropertySymbols(t).find(
    (k) => typeof t[k] === "function"
  );
  return (t[key as symbol] as (ctx: unknown) => unknown)({});
};

beforeEach(() => {
  states.clear();
  marker = "8";
  sandbox = {
    readTextFile: vi.fn(() => Promise.resolve(marker)),
  };
  getSandbox = vi.fn(() => Promise.resolve(sandbox));
  warn = vi.spyOn(console, "warn").mockImplementation(() => {
    // Deliberate no-op: suppress expected warning output in this test.
  });
});
afterEach(() => warn.mockRestore());

describe("classifyImage", () => {
  it.each([
    ["9", "9", "current"],
    ["8", "9", "stale"],
    [null, "9", "unknown"],
  ] as const)("marker %s against %s is %s", (found, expected, status) => {
    expect(classifyImage(found, expected)).toBe(status);
  });
});

describe("the image check at the start of a turn", () => {
  it("never opens a computer the session doesn't have", async () => {
    await start();
    expect(getSandbox).not.toHaveBeenCalled();
    expect(image()).toBeUndefined();
  });

  it("detects a resumed computer from an older image, which the selector never saw again", async () => {
    markComputerOpened("chat");
    await start();
    expect(sandbox.readTextFile).toHaveBeenCalledWith({
      path: "/etc/busy-image-version",
    });
    expect(image()).toMatchObject({
      expected: BOT_BASE_IMAGE_VERSION,
      found: "8",
      status: "stale",
    });
  });

  it("checks once per session and expected version, then again after a deployment changes it", async () => {
    markComputerOpened("chat");
    await start();
    await start();
    expect(sandbox.readTextFile).toHaveBeenCalledTimes(1);
    // A deployment that expects another version finds the record of the old expectation.
    states.set("busy.computer-image", { ...image(), expected: "8" });
    await start();
    expect(sandbox.readTextFile).toHaveBeenCalledTimes(2);
  });

  it("only reads: no command, no write, no reset", async () => {
    markComputerOpened("chat");
    await start();
    expect(Object.keys(sandbox)).toEqual(["readTextFile"]);
  });

  it("never fails the turn when the computer can't be reached", async () => {
    markComputerOpened("chat");
    getSandbox.mockRejectedValueOnce(new Error("quota"));
    await expect(start()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe("what the agent is told", () => {
  it("says nothing for a current computer or before any check", async () => {
    expect(resolveInstructions()).toBeNull();
    markComputerOpened("chat");
    marker = BOT_BASE_IMAGE_VERSION;
    await start();
    expect(resolveInstructions()).toBeNull();
  });

  it.each([
    ["8", "8"],
    [null, "an image without a version marker"],
  ])(
    "explains an older computer (marker %s) and asks for the user, not a reset",
    async (found, shown) => {
      markComputerOpened("chat");
      marker = found;
      await start();
      const notice = imageNotice(image() as never);
      expect(notice).toContain(shown);
      expect(notice).toContain("Do not try to repair, reinstall or reset");
      expect(notice).toContain("/data is kept");
      expect(resolveInstructions()).toMatchObject({ content: notice });
    }
  );
});
