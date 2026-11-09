import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH, POST, PUT } from "./app/api/bots/[slug]/live/route";

const mocks = vi.hoisted(() => ({
  desktopControl: vi.fn(),
  getBot: vi.fn(),
  keepOn: vi.fn(),
  openLive: vi.fn(),
  openSession: vi.fn(),
  sendToBot: vi.fn(),
}));

vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/chat/send", () => ({
  openSession: mocks.openSession,
  sendToBot: mocks.sendToBot,
}));
vi.mock("@/lib/chat/items", () => ({ WAKE_MESSAGE: "<wake_computer/>" }));
vi.mock("@/lib/keep-on", () => ({ keepOn: mocks.keepOn }));
vi.mock("@/lib/live", () => ({
  desktopControl: mocks.desktopControl,
  KEEP_ON_MS: 600_000,
  NEW_COMPUTER_WAIT_MS: 90_000,
  openLive: mocks.openLive,
  WATCH_MS: 90_000,
}));

const viewerId = "11111111-1111-4111-8111-111111111111";
const bot = {
  id: "bot-1",
  sessionId: "session-1",
  slug: "lawyer",
  status: "ready",
};
const ctx = () => ({ params: Promise.resolve({ slug: bot.slug }) });
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/bots/lawyer/live", {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getBot.mockResolvedValue(bot);
  mocks.openLive.mockResolvedValue({
    password: "synthetic",
    url: "wss://fixture.invalid",
    viewOnly: false,
  });
  mocks.desktopControl.mockResolvedValue({
    expiresAt: Date.now() + 75_000,
    ok: true,
  });
  mocks.keepOn.mockResolvedValue(undefined);
});

describe("Live connection and control are separate operations", () => {
  it("preconnects the screen without acquiring the input lease", async () => {
    const response = await POST(req("POST", { mode: "observe" }), ctx());
    expect(response.status).toBe(200);
    expect(mocks.openLive).toHaveBeenCalledWith(
      bot,
      "control",
      0,
      expect.any(String)
    );
    expect(mocks.desktopControl).not.toHaveBeenCalled();
  });

  it("acknowledges control only after the VM grants this viewer's lease", async () => {
    const response = await PATCH(
      req("PATCH", { mode: "control", viewerId }),
      ctx()
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(mocks.desktopControl).toHaveBeenCalledWith(
      bot,
      "acquire",
      viewerId,
      expect.any(String)
    );
    expect(mocks.keepOn).toHaveBeenCalledWith(bot, 600_000);
  });

  it("returns a busy lease without claiming that input is available", async () => {
    mocks.desktopControl.mockResolvedValue({
      code: "CONTROL_BUSY",
      error: "Another viewer owns control.",
      ok: false,
    });
    const response = await PATCH(
      req("PATCH", { mode: "control", viewerId }),
      ctx()
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "CONTROL_BUSY",
      ok: false,
    });
    expect(mocks.keepOn).not.toHaveBeenCalled();
  });

  it("releases control without reopening or waking the screen", async () => {
    const response = await PATCH(
      req("PATCH", { mode: "observe", viewerId }),
      ctx()
    );
    expect(response.status).toBe(200);
    expect(mocks.desktopControl).toHaveBeenCalledWith(
      bot,
      "release",
      viewerId,
      expect.any(String)
    );
    expect(mocks.openLive).not.toHaveBeenCalled();
    expect(mocks.openSession).not.toHaveBeenCalled();
    expect(mocks.sendToBot).not.toHaveBeenCalled();
  });

  it("treats a late release as completed without overwriting another owner", async () => {
    mocks.desktopControl.mockResolvedValue({
      code: "CONTROL_LOST",
      error: "Lease no longer belongs to this viewer.",
      ok: false,
    });
    const response = await PATCH(
      req("PATCH", { mode: "observe", viewerId }),
      ctx()
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      code: "CONTROL_LOST",
      ok: false,
    });
    expect(mocks.keepOn).not.toHaveBeenCalled();
  });

  it("renews the named owner while an ordinary watch heartbeat never acquires control", async () => {
    expect((await PUT(req("PUT", { viewerId }), ctx())).status).toBe(200);
    expect(mocks.desktopControl).toHaveBeenCalledExactlyOnceWith(
      bot,
      "renew",
      viewerId
    );
    mocks.desktopControl.mockClear();
    expect((await PUT(req("PUT"), ctx())).status).toBe(200);
    expect(mocks.desktopControl).not.toHaveBeenCalled();
  });

  it("reports a lost renewal so the client must lock input", async () => {
    mocks.desktopControl.mockResolvedValue({
      code: "CONTROL_LOST",
      error: "Expired.",
      ok: false,
    });
    const response = await PUT(req("PUT", { viewerId }), ctx());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "CONTROL_LOST",
      ok: false,
    });
    expect(mocks.keepOn).not.toHaveBeenCalled();
  });

  it("rejects malformed ownership before running any VM command", async () => {
    expect(
      (
        await PATCH(
          req("PATCH", { mode: "control", viewerId: "not-a-uuid" }),
          ctx()
        )
      ).status
    ).toBe(400);
    expect((await PUT(req("PUT", { viewerId: 12 }), ctx())).status).toBe(400);
    expect(mocks.desktopControl).not.toHaveBeenCalled();
    expect(mocks.openLive).not.toHaveBeenCalled();
  });
});
