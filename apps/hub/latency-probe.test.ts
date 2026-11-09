import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./app/api/cron/latency-probe/route";
import { probeBot } from "./lib/chat/latency-probe";

const mocks = vi.hoisted(() => ({
  deliverMessage: vi.fn(),
  ensureMessage: vi.fn(),
  followTurn: vi.fn(),
  getBot: vi.fn(),
  loadChatTrace: vi.fn(),
  markMessageFailed: vi.fn(),
  syncBot: vi.fn(),
}));
vi.mock("node:timers/promises", () => ({
  setTimeout: () => Promise.resolve(),
}));
vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));
vi.mock("./lib/chat/deliver", () => ({
  deliverMessage: mocks.deliverMessage,
  ensureMessage: mocks.ensureMessage,
  followTurn: mocks.followTurn,
  markMessageFailed: mocks.markMessageFailed,
  payloadHash: () => "hash",
}));
vi.mock("./lib/chat/store", () => ({ syncBot: mocks.syncBot }));
vi.mock("./lib/chat/trace-query", () => ({
  loadChatTrace: mocks.loadChatTrace,
}));

const bot = { id: "bot-id", sessionId: "s1", slug: "qa", status: "ready" };
const at = (offsetMs: number) => new Date(1_000_000 + offsetMs).toISOString();
const settledTrace = {
  correlation: { sessionId: "s1" },
  stages: {
    delivery: { admittedAt: at(200) },
    modelAttempts: [
      {
        durationMs: 1500,
        provider: "openai",
        queueDurationMs: 30,
        turnToModelMs: 120,
        usage: null,
      },
    ],
    turn: {
      durationMs: 2000,
      endAt: at(2500),
      outcome: "completed",
      startAt: at(500),
    },
  },
  usage: {
    totals: { cacheReadTokens: 900, inputTokens: 1000, outputTokens: 12 },
  },
};

const logged = () =>
  vi
    .mocked(console.info)
    .mock.calls.map(([line]) => JSON.parse(String(line)))
    .filter((line) => line.event === "latency.probe");

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  vi.stubEnv("CRON_SECRET", "cron-test-secret");
  mocks.getBot.mockResolvedValue(bot);
  mocks.ensureMessage.mockResolvedValue({ row: {} });
  mocks.deliverMessage.mockResolvedValue({ deliveryId: "d1" });
  mocks.followTurn.mockResolvedValue(undefined);
  mocks.syncBot.mockResolvedValue(undefined);
});

describe("latency probe cron", () => {
  const call = (auth?: string) =>
    GET(
      new Request("http://busy.test/api/cron/latency-probe", {
        headers: auth ? { authorization: auth } : {},
      })
    );

  it("rejects requests without the cron bearer", async () => {
    vi.stubEnv("LATENCY_PROBE_ENABLED", "1");
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect(mocks.getBot).not.toHaveBeenCalled();
  });

  it("does nothing unless LATENCY_PROBE_ENABLED is 1", async () => {
    vi.stubEnv("LATENCY_PROBE_ENABLED", "");
    const response = await call("Bearer cron-test-secret");
    expect(await response.json()).toEqual({ enabled: false });
    expect(mocks.getBot).not.toHaveBeenCalled();
  });

  it("probes the four QA bots when enabled", async () => {
    vi.stubEnv("LATENCY_PROBE_ENABLED", "1");
    mocks.loadChatTrace.mockResolvedValue(settledTrace);
    const response = await call("Bearer cron-test-secret");
    expect(await response.json()).toEqual({
      bots: 4,
      enabled: true,
      failed: 0,
    });
    expect(mocks.getBot.mock.calls.map(([slug]) => slug)).toContain(
      "qa-1104-operaciones-gateway"
    );
    expect(mocks.deliverMessage).toHaveBeenCalledTimes(4);
  });
});

describe("probeBot", () => {
  it("logs per-stage latency and tokens, never the prompt", async () => {
    mocks.loadChatTrace
      .mockResolvedValueOnce({
        ...settledTrace,
        stages: { ...settledTrace.stages, turn: { endAt: null } },
      })
      .mockResolvedValue(settledTrace);
    await probeBot("qa", 60_000);
    expect(mocks.syncBot).toHaveBeenCalledTimes(2);
    expect(mocks.followTurn).toHaveBeenCalledWith(bot, "d1");
    const [line] = logged();
    expect(line).toMatchObject({
      ackMs: 0,
      admittedLagMs: 200,
      botSlug: "qa",
      cachedTokens: 900,
      deliveryId: "d1",
      durationMs: 2500,
      inputTokens: 1000,
      modelMs: 1500,
      modelQueueMs: 30,
      outcome: "completed",
      turnMs: 2000,
      turnStartLagMs: 300,
      turnToModelMs: 120,
    });
    expect(JSON.stringify(line)).not.toContain("BUSY_PROBE");
    const [{ text }] = mocks.deliverMessage.mock.calls[0] ?? [{}];
    expect(text).toContain("Do not call tools");
  });

  it("logs a timeout when the turn does not settle in time", async () => {
    let now = 1_000_000;
    vi.mocked(Date.now).mockImplementation(() => {
      now += 10_000;
      return now;
    });
    mocks.loadChatTrace.mockResolvedValue(null);
    await probeBot("qa", 30_000);
    expect(logged()[0]).toMatchObject({ outcome: "timeout" });
  });

  it("marks the message failed and logs only an error code when delivery fails", async () => {
    mocks.deliverMessage.mockRejectedValue(new Error("secret provider body"));
    mocks.markMessageFailed.mockResolvedValue(undefined);
    await probeBot("qa");
    expect(mocks.markMessageFailed).toHaveBeenCalledOnce();
    const [line] = logged();
    expect(line).toMatchObject({ errorCode: "Error", outcome: "failed" });
    expect(JSON.stringify(line)).not.toContain("secret");
  });

  it("skips bots that are not ready", async () => {
    mocks.getBot.mockResolvedValue({ ...bot, status: "creating" });
    await probeBot("qa");
    expect(mocks.ensureMessage).not.toHaveBeenCalled();
    expect(logged()[0]).toMatchObject({ outcome: "not_ready" });
  });
});
