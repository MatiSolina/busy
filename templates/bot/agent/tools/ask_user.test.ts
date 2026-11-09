import { describe, expect, it, vi } from "vitest";
import askUser from "./ask_user";

const tool = askUser as unknown as {
  execute: (input: unknown, ctx: unknown) => Promise<unknown>;
};
const chat = (ask: ReturnType<typeof vi.fn>) => ({
  ask,
  session: { auth: { current: { principalId: "hub", principalType: "app" } } },
});
const input = {
  allowFreeText: false,
  options: [{ label: "Delete them", style: "danger" }, { label: "Keep them" }],
  question: "Delete the 12 drafts?",
};

describe("ask_user", () => {
  it("shows the options as buttons and returns the chosen label", async () => {
    const ask = vi.fn(async () => ({ optionId: "1", status: "answered" }));
    await expect(tool.execute(input, chat(ask))).resolves.toEqual({
      answer: "Keep them",
      status: "answered",
    });
    expect(ask).toHaveBeenCalledWith({
      allowFreeform: false,
      display: "select",
      options: [
        { id: "0", label: "Delete them", style: "danger" },
        { id: "1", label: "Keep them" },
      ],
      prompt: "Delete the 12 drafts?",
    });
  });

  it("returns typed text, and tells the model when the user moved on", async () => {
    await expect(
      tool.execute(
        input,
        chat(vi.fn(async () => ({ status: "answered", text: "Only old ones" })))
      )
    ).resolves.toMatchObject({ answer: "Only old ones" });
    await expect(
      tool.execute(input, chat(vi.fn(async () => ({ status: "cancelled" }))))
    ).resolves.toMatchObject({ status: "interrupted" });
  });

  it("never asks in a consultation", async () => {
    const ask = vi.fn();
    const consult = {
      ask,
      session: {
        auth: {
          current: {
            principalId: "busy-hub:consultation:a:b",
            principalType: "user",
          },
        },
      },
    };
    await tool.execute(input, consult).catch(() => null);
    expect(ask).not.toHaveBeenCalled();
  });
});
