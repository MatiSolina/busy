import { beforeEach, describe, expect, it, vi } from "vitest";
import requestForm, { formResult } from "./request_form";

const holdComputer = vi.hoisted(() => vi.fn());
vi.mock("../lib/computer", () => ({ holdComputer }));

interface Ctx {
  ask: ReturnType<typeof vi.fn>;
  session: { auth: unknown; id: string };
}
const tool = requestForm as unknown as {
  execute: (input: unknown, ctx: Ctx) => Promise<unknown>;
  inputSchema: { safeParse: (v: unknown) => { success: boolean } };
};
const input = {
  fields: [
    { id: "username", kind: "email", label: "Email", target: "@e3" },
    { id: "password", kind: "password", label: "Password", target: "@e4" },
  ],
  site: "the bank",
  task: "download statements",
};
const chat = (ask: Ctx["ask"]): Ctx => ({
  ask,
  session: {
    auth: { current: { principalId: "hub", principalType: "app" } },
    id: "chat",
  },
});

beforeEach(() => {
  holdComputer.mockReset().mockResolvedValue(true);
});

describe("request_form", () => {
  it("holds the computer while asking and returns ids, never values", async () => {
    const ask = vi.fn(() => {
      expect(holdComputer).toHaveBeenLastCalledWith("chat", true);
      return Promise.resolve({ optionId: "filled", status: "answered" });
    });
    const result = await tool.execute(input, chat(ask));
    expect(result).toEqual({ fields: ["username", "password"], filled: true });
    expect(holdComputer.mock.calls).toEqual([
      ["chat", true],
      ["chat", false],
    ]);
    // The question never carries field targets or values: only the prompt and the options.
    expect(JSON.stringify(ask.mock.calls[0])).not.toContain("@e4");
  });

  it("reports the fields the hub couldn't fill and points at request_login", async () => {
    const ask = vi.fn(async () => ({
      optionId: "failed",
      status: "answered",
      text: "password,bogus",
    }));
    await expect(tool.execute(input, chat(ask))).resolves.toEqual({
      failed: ["password"],
      filled: false,
      next: expect.stringContaining("request_login"),
    });
  });

  it("releases the computer when the ask fails", async () => {
    const ask = vi.fn(() => {
      throw new Error("turn stopped");
    });
    await expect(tool.execute(input, chat(ask))).rejects.toThrow(
      "turn stopped"
    );
    expect(holdComputer).toHaveBeenLastCalledWith("chat", false);
  });

  it("refuses in a consultation without asking or holding", async () => {
    const ask = vi.fn();
    const result = await tool.execute(input, {
      ask,
      session: {
        auth: {
          current: {
            principalId: "owner:t:project:bot-lawyer:environment:production",
            principalType: "app",
          },
        },
        id: "q1",
      },
    });
    expect(result).toMatchObject({ filled: false });
    expect(ask).not.toHaveBeenCalled();
    expect(holdComputer).not.toHaveBeenCalled();
  });

  it("maps every answer to a value-free result", () => {
    const ids = ["a"];
    expect(formResult({ optionId: "done", status: "answered" }, ids)).toEqual(
      expect.objectContaining({ fields: ids, filled: true })
    );
    expect(formResult({ status: "unavailable" }, ids)).toMatchObject({
      failed: ids,
      filled: false,
    });
    expect(formResult({ status: "cancelled" }, ids)).toMatchObject({
      filled: false,
    });
    expect(
      formResult({ optionId: "failed", status: "answered" }, ids)
    ).toMatchObject({ failed: ids });
  });

  it("rejects duplicate ids and unknown kinds", () => {
    expect(tool.inputSchema.safeParse(input).success).toBe(true);
    expect(
      tool.inputSchema.safeParse({
        ...input,
        fields: [input.fields[0], input.fields[0]],
      }).success
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({
        ...input,
        fields: [{ ...input.fields[0], kind: "ssn" }],
      }).success
    ).toBe(false);
  });
});
