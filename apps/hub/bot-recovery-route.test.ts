import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  botFromRequest: vi.fn(),
  getBot: vi.fn(),
  planRecoveryForSession: vi.fn(),
}));

vi.mock("@/lib/bot-auth", () => ({ botFromRequest: mocks.botFromRequest }));
vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/chat/plan-recovery", () => ({
  planRecoveryForSession: mocks.planRecoveryForSession,
}));

const { GET } = await import("@/app/api/bot/recovery/route");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.botFromRequest.mockReset().mockResolvedValue({ slug: "current-bot" });
  mocks.getBot.mockReset().mockResolvedValue({ id: "owned-bot" });
  mocks.planRecoveryForSession.mockReset().mockResolvedValue(null);
});

describe("trusted plan recovery route", () => {
  it("derives the bot from authentication and returns only its session-bound packet", async () => {
    const packet = {
      botId: "owned-bot",
      plan: { id: "plan-1", revision: 3, steps: [], title: "Saved work" },
      predecessorSessionId: "old-root",
      rootSessionId: "current-root",
      version: 1,
    };
    mocks.planRecoveryForSession.mockResolvedValue(packet);
    const response = await GET(
      new Request("https://hub.test/api/bot/recovery?sessionId=current-root")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(packet);
    expect(mocks.getBot).toHaveBeenCalledWith("current-bot");
    expect(mocks.planRecoveryForSession).toHaveBeenCalledWith(
      "owned-bot",
      "current-root"
    );
  });

  it("returns null when there is no trusted recovery for the requested root", async () => {
    const response = await GET(
      new Request("https://hub.test/api/bot/recovery?sessionId=unrelated-root")
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });

  it("rejects an unauthenticated request before querying recovery state", async () => {
    mocks.botFromRequest.mockResolvedValue(
      new Response("unauthorized", { status: 401 })
    );
    const response = await GET(
      new Request("https://hub.test/api/bot/recovery?sessionId=current-root")
    );
    expect(response.status).toBe(401);
    expect(mocks.getBot).not.toHaveBeenCalled();
    expect(mocks.planRecoveryForSession).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "?sessionId=",
    "?sessionId=first&sessionId=second",
    "?sessionId=current-root&botId=another-bot",
    "?sessionId=current-root&plan=forged",
    `?sessionId=${"s".repeat(201)}`,
  ])(
    "rejects invalid or caller-supplied ownership data: %s",
    async (suffix) => {
      const response = await GET(
        new Request(`https://hub.test/api/bot/recovery${suffix}`)
      );
      expect(response.status).toBe(400);
      expect(mocks.planRecoveryForSession).not.toHaveBeenCalled();
    }
  );

  it("does not turn a failed lookup into an absent or untrusted plan", async () => {
    mocks.planRecoveryForSession.mockRejectedValue(
      new Error("private database detail")
    );
    const response = await GET(
      new Request("https://hub.test/api/bot/recovery?sessionId=current-root")
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private database detail");
  });
});
