import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./app/api/bots/[slug]/answer/route";

const mocks = vi.hoisted(() => ({
  answerInteraction: vi.fn(),
  botCall: vi.fn(),
  getBot: vi.fn(),
}));

vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/chat/store", () => ({ botCall: mocks.botCall }));
vi.mock("@/lib/eve/client", () => ({
  answerInteraction: mocks.answerInteraction,
}));

const bot = { sessionId: "session-1", slug: "sales" };
const params = { params: Promise.resolve({ slug: bot.slug }) };
const request = (body: unknown) =>
  new Request("http://busy.test/api/bots/sales/answer", {
    body: JSON.stringify(body),
    method: "POST",
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getBot.mockResolvedValue(bot);
  mocks.botCall.mockReturnValue({
    token: vi.fn(),
    url: "https://sales.example",
  });
  mocks.answerInteraction.mockResolvedValue(undefined);
});

describe("answer route", () => {
  it.each([
    { interactionId: "q-1" },
    { interactionId: "q-1", optionId: "" },
    { interactionId: "q-1", text: "" },
  ])("rejects an answer without an option or text: %j", async (body) => {
    expect((await POST(request(body), params)).status).toBe(400);
    expect(mocks.answerInteraction).not.toHaveBeenCalled();
  });

  it("passes a choice answer without rewriting the native payload", async () => {
    expect(
      (await POST(request({ interactionId: "q-1", optionId: "xlsx" }), params))
        .status
    ).toBe(200);
    expect(mocks.answerInteraction).toHaveBeenCalledWith(
      expect.anything(),
      "session-1",
      { interactionId: "q-1", optionId: "xlsx" }
    );
  });

  it("passes a free-form answer", async () => {
    expect(
      (
        await POST(
          request({ interactionId: "q-1", text: "use November" }),
          params
        )
      ).status
    ).toBe(200);
    expect(mocks.answerInteraction).toHaveBeenCalledWith(
      expect.anything(),
      "session-1",
      { interactionId: "q-1", text: "use November" }
    );
  });

  it("returns not found without a live session", async () => {
    mocks.getBot.mockResolvedValueOnce({ ...bot, sessionId: null });
    expect(
      (await POST(request({ interactionId: "q-1", optionId: "xlsx" }), params))
        .status
    ).toBe(404);
  });

  it("does not hide an eve transport failure", async () => {
    mocks.answerInteraction.mockRejectedValueOnce(
      new Error("eve answer failed")
    );
    await expect(
      POST(request({ interactionId: "q-1", optionId: "xlsx" }), params)
    ).rejects.toThrow("eve answer failed");
  });
});
