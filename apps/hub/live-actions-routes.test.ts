import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as fill } from "./app/api/bots/[slug]/form/route";
import {
  POST as startTeach,
  DELETE as stopTeach,
} from "./app/api/bots/[slug]/teach/route";
import {
  DEMO_ID,
  FILL_SCRIPT,
  RECORDER,
  START_RECORDER,
  teachMessage,
} from "./lib/live-actions";

const m = vi.hoisted(() => ({
  answerInteraction: vi.fn(),
  computer: vi.fn(),
  getBot: vi.fn(),
  runCommand: vi.fn(),
}));
vi.mock("@/lib/bots/service", () => ({ getBot: m.getBot }));
vi.mock("@/lib/chat/store", () => ({ botCall: () => ({ url: "x" }) }));
vi.mock("@/lib/eve/client", () => ({
  answerInteraction: m.answerInteraction,
}));
vi.mock("./lib/live", () => ({ computer: m.computer }));

const SECRET = "hunter2-Sup3rS3cret";
const bot = { sessionId: "s-1", slug: "sales" };
const params = { params: Promise.resolve({ slug: "sales" }) };
const req = (body: unknown, method = "POST") =>
  new Request("http://busy.test/api/bots/sales/x", {
    body: JSON.stringify(body),
    method,
  });
const finished = (stdout: string, exitCode = 0) => ({
  exitCode,
  stderr: async () => "",
  stdout: async () => stdout,
});
const form = {
  fields: [
    { id: "user", target: "@e3", value: "me@example.com" },
    { id: "pass", target: "#pw", value: SECRET },
  ],
  interactionId: "q-1",
};

let logs: unknown[];
beforeEach(() => {
  vi.resetAllMocks();
  m.getBot.mockResolvedValue(bot);
  m.computer.mockResolvedValue({
    name: "box",
    sandbox: { runCommand: m.runCommand, status: "running" },
  });
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...args) => {
    logs.push(args);
  });
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args);
  });
});

describe("form route", () => {
  it.each([
    null,
    { interactionId: "q-1" },
    { ...form, fields: [] },
    { ...form, fields: [{ id: "Bad Id", target: "@e1", value: "x" }] },
    { ...form, fields: [{ id: "a", target: "@e1", value: "" }] },
    { ...form, fields: [{ id: "a", target: "--help", value: "x" }] },
  ])("rejects %j without touching the computer", async (body) => {
    const res = await fill(req(body), params);
    expect(res.status).toBe(400);
    expect(m.runCommand).not.toHaveBeenCalled();
    expect(m.answerInteraction).not.toHaveBeenCalled();
  });

  it("never hands the browser CLI a value it could read as an option", () => {
    expect(FILL_SCRIPT).toContain('f["value"].startswith("-")');
    expect(FILL_SCRIPT).toContain('f["target"].startswith("-")');
  });

  it("does not echo values in a validation error", async () => {
    const res = await fill(
      req({ ...form, fields: [{ id: "x", target: "", value: SECRET }] }),
      params
    );
    expect(await res.text()).not.toContain(SECRET);
  });

  it("passes values only in the env and answers with ids", async () => {
    m.runCommand.mockResolvedValue(finished('{"failed": []}\n'));
    const res = await fill(req(form), params);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ failed: [], ok: true });

    const [command] = m.runCommand.mock.calls[0];
    expect(command.cmd).toBe("python3");
    expect(command.args).toEqual(["-c", FILL_SCRIPT]);
    expect(JSON.stringify(command.args)).not.toContain(SECRET);
    expect(JSON.parse(command.env.BUSY_FORM)).toEqual(form.fields);

    expect(m.answerInteraction).toHaveBeenCalledWith(expect.anything(), "s-1", {
      interactionId: "q-1",
      optionId: "filled",
    });
    // Nothing that leaves this route (answer → eve's event log, response, logs) carries a value.
    const outward = JSON.stringify([
      m.answerInteraction.mock.calls,
      body,
      logs,
    ]);
    expect(outward).not.toContain(SECRET);
    expect(outward).not.toContain("me@example.com");
  });

  it("answers failed with the ids the computer couldn't fill", async () => {
    m.runCommand.mockResolvedValue(finished('{"failed": ["pass", "nope"]}'));
    const res = await fill(req(form), params);
    expect(await res.json()).toEqual({ failed: ["pass"], ok: false });
    expect(m.answerInteraction).toHaveBeenCalledWith(expect.anything(), "s-1", {
      interactionId: "q-1",
      optionId: "failed",
      text: "pass",
    });
  });

  it("fails every field, without logging values, when the sandbox throws", async () => {
    m.runCommand.mockRejectedValue(new Error(`boom ${SECRET}`));
    const res = await fill(req(form), params);
    expect(await res.json()).toEqual({ failed: ["user", "pass"], ok: false });
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it("fails every field when the bot has no computer", async () => {
    m.computer.mockResolvedValue(null);
    expect(await (await fill(req(form), params)).json()).toMatchObject({
      failed: ["user", "pass"],
    });
  });
});

describe("teach route", () => {
  it("starts a detached recorder in a new demo folder", async () => {
    m.runCommand.mockResolvedValue(finished(""));
    const res = await startTeach(req(null), params);
    const { id } = await res.json();
    expect(id).toMatch(DEMO_ID);
    const [command] = m.runCommand.mock.calls[0];
    expect(command).toEqual({
      args: ["-c", START_RECORDER, "teach", RECORDER, `/data/demos/${id}`],
      cmd: "bash",
    });
    expect(START_RECORDER).toContain("setsid nohup python3");
    expect(RECORDER).toContain(
      '"desktop", "screenshot", shot, "--screen", "0"'
    );
    expect(RECORDER).toContain("n < 300");
    expect(RECORDER).toContain("< 600");
  });

  it("does not wake a stopped computer", async () => {
    m.computer.mockResolvedValue({
      name: "box",
      sandbox: { runCommand: m.runCommand, status: "stopped" },
    });
    expect((await startTeach(req(null), params)).status).toBe(409);
    expect(m.runCommand).not.toHaveBeenCalled();
  });

  it("stops it and returns the message for the bot", async () => {
    m.runCommand.mockResolvedValue(finished("12 95\n"));
    const id = "2026-11-09-10-00-00-abcd";
    const res = await stopTeach(req({ id }, "DELETE"), params);
    expect(await res.json()).toEqual({
      frames: 12,
      message: teachMessage(id, { frames: 12, seconds: 95 }),
      seconds: 95,
    });
    expect(m.runCommand.mock.calls[0][0].args.at(-1)).toBe(`/data/demos/${id}`);
    expect(teachMessage(id, { frames: 12, seconds: 95 })).toContain(
      "12 frames over 1 min 35 s"
    );
  });

  it.each([{ id: "../etc" }, { id: "a b" }, {}])(
    "rejects a bad id %j",
    async (body) => {
      expect((await stopTeach(req(body, "DELETE"), params)).status).toBe(400);
      expect(m.runCommand).not.toHaveBeenCalled();
    }
  );
});
