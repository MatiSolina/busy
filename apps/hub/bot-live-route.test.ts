import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./app/api/bot/live/route";

const m = vi.hoisted(() => ({
  botFromRequest: vi.fn(),
  claimShutdown: vi.fn(),
  confirmShutdown: vi.fn(),
  getBot: vi.fn(),
  holdOn: vi.fn(),
  releaseHold: vi.fn(),
  releaseShutdown: vi.fn(),
  reportSandbox: vi.fn(),
}));
vi.mock("@/lib/bot-auth", () => ({ botFromRequest: m.botFromRequest }));
vi.mock("@/lib/bots/service", () => ({ getBot: m.getBot }));
vi.mock("@/lib/keep-on", () => ({ holdOn: m.holdOn }));
vi.mock("@/lib/live", () => ({
  claimShutdown: m.claimShutdown,
  confirmShutdown: m.confirmShutdown,
  isWatched: (row: { liveUntil: Date | null }) =>
    (row.liveUntil?.getTime() ?? 0) > Date.now(),
  releaseHold: m.releaseHold,
  releaseShutdown: m.releaseShutdown,
  reportSandbox: m.reportSandbox,
}));

const claim = "33333333-3333-4333-8333-333333333333";
const bot = {
  id: "bot-1",
  liveUntil: null as Date | null,
  sessionId: "session-a",
  slug: "lawyer",
};
const post = (body: unknown) =>
  POST(
    new Request("http://hub/api/bot/live", {
      body: JSON.stringify(body),
      method: "POST",
    })
  );

beforeEach(() => {
  vi.resetAllMocks();
  m.botFromRequest.mockResolvedValue({ slug: "lawyer" });
  m.getBot.mockResolvedValue({ ...bot });
});

describe("/api/bot/live", () => {
  it("still answers bots on the older template with `watched`", async () => {
    m.getBot.mockResolvedValue({
      ...bot,
      liveUntil: new Date(Date.now() + 60_000),
    });
    const res = await GET(new Request("http://hub/api/bot/live"));
    await expect(res.json()).resolves.toEqual({ watched: true });
  });

  it("rejects callers without the bot's token", async () => {
    m.botFromRequest.mockResolvedValue(new Response("no", { status: 401 }));
    expect((await post({ action: "claim", sessionId: "s" })).status).toBe(401);
  });

  it("claims the current session's shutdown in the hub", async () => {
    m.claimShutdown.mockResolvedValue({
      claim,
      generation: 4,
      sessionId: "session-a",
    });
    const res = await post({ action: "claim", sessionId: "session-a" });
    await expect(res.json()).resolves.toEqual({
      claim,
      generation: 4,
      ok: true,
    });
    expect(m.claimShutdown).toHaveBeenCalledWith("bot-1", "session-a");
  });

  it("denies a claim the hub can't grant", async () => {
    m.claimShutdown.mockResolvedValue(null);
    const res = await post({ action: "claim", sessionId: "session-a" });
    await expect(res.json()).resolves.toEqual({ ok: false });
  });

  it("grants a null claim for a session it doesn't coordinate, valid only while it isn't current", async () => {
    const res = await post({ action: "claim", sessionId: "consultation-1" });
    await expect(res.json()).resolves.toEqual({
      claim: null,
      generation: null,
      ok: true,
    });
    const other = { claim: null, generation: null, sessionId: "q1" };
    await expect(
      (await post({ action: "commit", ...other })).json()
    ).resolves.toEqual({ ok: true });
    const nowCurrent = {
      claim: null,
      generation: null,
      sessionId: "session-a",
    };
    await expect(
      (await post({ action: "commit", ...nowCurrent })).json()
    ).resolves.toEqual({ ok: false });
    expect(m.claimShutdown).not.toHaveBeenCalled();
  });

  it.each([
    ["verify", "checking"],
    ["commit", "stopping"],
  ])("%s re-checks the claim in the hub", async (action, phase) => {
    m.confirmShutdown.mockResolvedValue(false);
    const res = await post({
      action,
      claim,
      generation: 4,
      sessionId: "session-a",
    });
    await expect(res.json()).resolves.toEqual({ ok: false });
    expect(m.confirmShutdown).toHaveBeenCalledWith(
      "bot-1",
      { claim, generation: 4, sessionId: "session-a" },
      phase
    );
  });

  it("holds the computer only for the current session", async () => {
    m.holdOn.mockResolvedValue(null);
    const refused = await post({ action: "hold", sessionId: "old" });
    expect(refused.status).toBe(409);
    m.holdOn.mockResolvedValue(new Date("2026-11-08T14:00:00.000Z"));
    const held = await post({ action: "hold", sessionId: "session-a" });
    await expect(held.json()).resolves.toEqual({
      holdUntil: "2026-11-08T14:00:00.000Z",
      ok: true,
    });
    await post({ action: "unhold", sessionId: "session-a" });
    expect(m.releaseHold).toHaveBeenCalledWith("bot-1", "session-a");
  });

  it.each([
    ["stored", 200],
    ["session", 409],
    ["missing", 422],
    ["invalid", 400],
  ])("answers a sandbox report that is %s with %i", async (result, status) => {
    m.reportSandbox.mockResolvedValue(result);
    const res = await post({
      action: "sandbox",
      name: "eve-sbx-vercel-x",
      sessionId: "session-a",
    });
    expect(res.status).toBe(status);
  });

  it("rejects an unknown action", async () => {
    expect((await post({ action: "stop", sessionId: "s" })).status).toBe(400);
  });
});
