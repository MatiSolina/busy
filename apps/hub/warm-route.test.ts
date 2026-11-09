import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./app/api/bots/[slug]/warm/route";

const mocks = vi.hoisted(() => ({
  cancelTurn: vi.fn(),
  getBot: vi.fn(),
  log: vi.fn(),
  prewarmSession: vi.fn(),
}));

vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/chat/store", () => ({ botCall: (slug: string) => ({ slug }) }));
vi.mock("@/lib/eve/client", () => ({
  cancelTurn: mocks.cancelTurn,
  prewarmSession: mocks.prewarmSession,
}));
vi.mock("@/lib/chat/observability", () => ({
  errorCodeOf: () => "Error",
  logChatObservation: mocks.log,
  requestIdOf: () => undefined,
}));

const bot = { sessionId: "session-1", slug: "assistant", status: "ready" };
const warm = () =>
  POST(
    new Request("http://busy.test/api/bots/assistant/warm", { method: "POST" }),
    {
      params: Promise.resolve({ slug: "assistant" }),
    }
  );

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("BOT_PREWARM", "1");
  mocks.getBot.mockResolvedValue(bot);
  mocks.prewarmSession.mockResolvedValue("ready");
});
afterEach(() => vi.unstubAllEnvs());

describe("bot warm route", () => {
  it("does nothing while the flag is off", async () => {
    vi.stubEnv("BOT_PREWARM", "");
    const res = await warm();
    expect(res.status).toBe(204);
    expect(mocks.getBot).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it("prewarms the bot's session and logs duration and outcome", async () => {
    const res = await warm();
    expect(await res.json()).toEqual({ status: "ready" });
    expect(mocks.prewarmSession).toHaveBeenCalledWith(
      { slug: "assistant" },
      "session-1"
    );
    expect(mocks.log).toHaveBeenCalledWith(
      "message.warm",
      expect.objectContaining({
        botSlug: "assistant",
        durationMs: expect.any(Number),
        outcome: "success",
        status: "ready",
      })
    );
  });

  it("never creates a session for a bot without one", async () => {
    mocks.getBot.mockResolvedValue({ ...bot, sessionId: null });
    expect((await warm()).status).toBe(204);
    expect(mocks.prewarmSession).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith(
      "message.warm",
      expect.objectContaining({ outcome: "skipped" })
    );
  });

  it("reports a failed prewarm without throwing", async () => {
    mocks.prewarmSession.mockRejectedValue(
      new Error("eve prewarm failed: 500")
    );
    expect((await warm()).status).toBe(502);
    expect(mocks.log).toHaveBeenCalledWith(
      "message.warm",
      expect.objectContaining({ errorCode: "Error", outcome: "failed" })
    );
  });

  it("wakes flow with a no-op cancel when only BUSY_EVE_WARM_FLOW is on", async () => {
    vi.stubEnv("BOT_PREWARM", "");
    vi.stubEnv("BUSY_EVE_WARM_FLOW", "1");
    await warm();
    expect(mocks.prewarmSession).not.toHaveBeenCalled();
    expect(mocks.cancelTurn).toHaveBeenCalledWith(
      { slug: "assistant" },
      "session-1",
      null
    );
    expect(mocks.log).toHaveBeenCalledWith(
      "message.warm",
      expect.objectContaining({ flow: "woken", variant: "flow" })
    );
  });

  it("prewarms first, then wakes flow", async () => {
    vi.stubEnv("BUSY_EVE_WARM_FLOW", "1");
    await warm();
    expect(mocks.prewarmSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.cancelTurn.mock.invocationCallOrder[0] ?? 0
    );
    expect(mocks.log).toHaveBeenCalledWith(
      "message.warm",
      expect.objectContaining({ flow: "woken", variant: "prewarm+flow" })
    );
  });

  it("skips the cancel when the prewarm already queued work on flow", async () => {
    vi.stubEnv("BUSY_EVE_WARM_FLOW", "1");
    mocks.prewarmSession.mockResolvedValue("accepted");
    await warm();
    expect(mocks.cancelTurn).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith(
      "message.warm",
      expect.objectContaining({ flow: "skipped", status: "accepted" })
    );
  });
});
