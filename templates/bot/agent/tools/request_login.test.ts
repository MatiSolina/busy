import { beforeEach, describe, expect, it, vi } from "vitest";
import requestLogin from "./request_login";

const holdComputer = vi.hoisted(() => vi.fn());
vi.mock("../lib/computer", () => ({ holdComputer }));

interface Ctx {
  ask: ReturnType<typeof vi.fn>;
  session: { auth: unknown; id: string };
}
const tool = requestLogin as unknown as {
  execute: (input: unknown, ctx: Ctx) => Promise<unknown>;
};
const input = { site: "the tax office", task: "download invoices" };
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

describe("request_login keeps the computer while the user logs in (H-17)", () => {
  it("holds it before asking and releases it once the user answers", async () => {
    const ask = vi.fn(() => {
      expect(holdComputer).toHaveBeenLastCalledWith("chat", true);
      return Promise.resolve({ optionId: "done", status: "answered" });
    });
    await expect(tool.execute(input, chat(ask))).resolves.toMatchObject({
      loggedIn: true,
    });
    expect(holdComputer.mock.calls).toEqual([
      ["chat", true],
      ["chat", false],
    ]);
  });

  it("releases it when the question is withdrawn or the ask fails", async () => {
    await tool.execute(
      input,
      chat(vi.fn(async () => ({ status: "cancelled" })))
    );
    expect(holdComputer).toHaveBeenLastCalledWith("chat", false);
    holdComputer.mockClear();
    await expect(
      tool.execute(
        input,
        chat(
          vi.fn(() => {
            throw new Error("turn stopped");
          })
        )
      )
    ).rejects.toThrow("turn stopped");
    expect(holdComputer.mock.calls).toEqual([
      ["chat", true],
      ["chat", false],
    ]);
  });

  it("still asks when the hub can't hold it (the sandbox timeout bounds it)", async () => {
    holdComputer.mockResolvedValue(false);
    const ask = vi.fn(async () => ({ status: "answered" }));
    await tool.execute(input, chat(ask));
    expect(ask).toHaveBeenCalledOnce();
  });

  it("never holds a computer from a consultation", async () => {
    const ask = vi.fn();
    await tool.execute(input, {
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
    expect(ask).not.toHaveBeenCalled();
    expect(holdComputer).not.toHaveBeenCalled();
  });
});
