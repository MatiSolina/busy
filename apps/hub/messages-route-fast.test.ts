import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./app/api/bots/[slug]/messages/route";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  db: vi.fn(),
  fastIneligible: vi.fn(),
  getBot: vi.fn(),
  log: vi.fn(),
  pendingFastExchanges: vi.fn(),
  persistAck: vi.fn(),
  runFastReply: vi.fn(),
  sendToBot: vi.fn(),
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/chat/send", () => ({ sendToBot: mocks.sendToBot }));
vi.mock("@/lib/chat/fast-reply", () => ({
  fastIneligible: mocks.fastIneligible,
  pendingFastExchanges: mocks.pendingFastExchanges,
  persistAck: mocks.persistAck,
  runFastReply: mocks.runFastReply,
}));
vi.mock("@/lib/chat/observability", () => ({
  errorCodeOf: () => "Error",
  logChatObservation: mocks.log,
  requestIdOf: () => undefined,
}));
vi.mock("@/lib/files", () => ({ fileForMessage: vi.fn() }));
vi.mock("@/lib/keep-on", () => ({ keepOn: vi.fn() }));
vi.mock("@/lib/live", () => ({ KEEP_ON_MS: 600_000 }));
vi.mock("@/workflows/sync-turn", () => ({ syncTurnWorkflow: vi.fn() }));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: mocks.db,
  messageDeliveryAttempts: {},
  messages: {},
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  isNull: vi.fn(() => ({})),
  ne: vi.fn(() => ({})),
}));

const bot = {
  billing: "gateway",
  id: "11111111-1111-4111-8111-111111111111",
  sessionId: "session-1",
  slug: "ana",
  status: "ready" as const,
};
const id = "22222222-2222-4222-8222-222222222222";
let stored: Record<string, unknown>;

beforeEach(() => {
  vi.resetAllMocks();
  stored = {
    botId: bot.id,
    clientContext: null,
    createdAt: new Date("2026-11-05T12:00:00Z"),
    fileIds: [],
    id,
    payloadHash: null,
    status: "pending",
    text: "",
  };
  mocks.getBot.mockResolvedValue(bot);
  mocks.sendToBot.mockResolvedValue({ deliveryId: "delivery-1" });
  mocks.fastIneligible.mockResolvedValue(null);
  mocks.pendingFastExchanges.mockResolvedValue([]);
  mocks.db.mockReturnValue({
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({ returning: () => [stored] }),
      }),
    }),
    // The delivery identity's admitting session (none in this fixture).
    select: () => ({ from: () => ({ where: () => [] }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          stored = { ...stored, ...values };
        },
      }),
    }),
  });
});
afterEach(() => vi.unstubAllEnvs());

const post = (text: string) => {
  stored.text = text;
  return POST(
    new Request("http://busy.test/api/bots/ana/messages", {
      body: JSON.stringify({ id, text }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    { params: Promise.resolve({ slug: bot.slug }) }
  );
};
const lines = async (response: Response) =>
  (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("fast path in POST /messages", () => {
  it("changes nothing with the flag off", async () => {
    mocks.runFastReply.mockResolvedValue({ escalated: false, reply: "hi" });
    const response = await post("hola");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ deliveryId: "delivery-1" });
    expect(mocks.fastIneligible).not.toHaveBeenCalled();
    expect(mocks.runFastReply).not.toHaveBeenCalled();
    expect(mocks.pendingFastExchanges).not.toHaveBeenCalled();
    expect(mocks.sendToBot).toHaveBeenCalledWith(
      bot,
      expect.not.objectContaining({ clientContext: expect.anything() }),
      expect.any(Object)
    );
  });

  it("only applies to listed bots", async () => {
    vi.stubEnv("FAST_PATH_BOTS", "someone-else");
    await post("hola");
    expect(mocks.runFastReply).not.toHaveBeenCalled();
  });

  it("answers a simple message itself, without eve", async () => {
    vi.stubEnv("FAST_PATH_BOTS", "ana");
    mocks.runFastReply.mockImplementation(async (_input, emit) => {
      emit({ fact: { type: "delivery.consumed" } });
      emit({ progress: { data: { delta: "Hi" }, type: "content.delta" } });
      return await Promise.resolve({
        escalated: false,
        inputTokens: 5,
        reply: "Hi",
        ttftMs: 12,
      });
    });
    const response = await post("hola");
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    expect(await lines(response)).toEqual([
      { fact: { type: "delivery.consumed" } },
      { progress: { data: { delta: "Hi" }, type: "content.delta" } },
      { deliveryId: `fast:${id}` },
    ]);
    expect(mocks.sendToBot).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith(
      "message.fast",
      expect.objectContaining({
        decision: "fast",
        escalated: false,
        inputTokens: 5,
        provider: "gateway",
        ttftMs: 12,
      })
    );
  });

  it("hands an escalated message to the bot the normal way", async () => {
    vi.stubEnv("FAST_PATH_BOTS", "*");
    mocks.runFastReply.mockResolvedValue({ escalated: true, reply: "" });
    const response = await post("hola");
    expect(await lines(response)).toEqual([{ deliveryId: "delivery-1" }]);
    expect(mocks.sendToBot).toHaveBeenCalledOnce();
    expect(stored.status).toBe("accepted");
    expect(mocks.after).toHaveBeenCalledOnce();
  });

  it("keeps an ack: delivers with it as context, then swaps the draft for the stored rows", async () => {
    vi.stubEnv("FAST_PATH_BOTS", "*");
    const ack = { reply: "Busco vuelos.", slot: { index: 1e9, line: 41 } };
    mocks.runFastReply.mockResolvedValue({
      ack,
      escalated: true,
      reply: "",
      ttftMs: 300,
    });
    mocks.persistAck.mockResolvedValue([{ type: "delivery.consumed" }]);
    const response = await post("hola");
    expect(await lines(response)).toEqual([
      { fact: { type: "delivery.consumed" } },
      { deliveryId: "delivery-1" },
    ]);
    expect(mocks.sendToBot).toHaveBeenCalledOnce();
    expect(mocks.sendToBot).toHaveBeenCalledWith(
      bot,
      expect.objectContaining({
        clientContext: expect.objectContaining({ quickAck: "Busco vuelos." }),
      }),
      expect.any(Object)
    );
    expect(mocks.persistAck).toHaveBeenCalledWith(
      bot,
      ack,
      id,
      "hola",
      "delivery-1",
      expect.any(Object)
    );
    expect(mocks.log).toHaveBeenCalledWith(
      "message.fast",
      expect.objectContaining({ acked: true, ackMs: 300, escalated: true })
    );
  });

  it("drops the ack when eve doesn't take the message", async () => {
    vi.stubEnv("FAST_PATH_BOTS", "*");
    mocks.runFastReply.mockResolvedValue({
      ack: { reply: "Busco.", slot: { index: 1e9, line: 41 } },
      escalated: true,
      reply: "",
    });
    mocks.sendToBot.mockRejectedValue(new Error("eve down"));
    const response = await post("hola");
    expect(await lines(response)).toEqual([
      { retract: true },
      { error: "message_delivery_failed" },
    ]);
    expect(mocks.sendToBot).toHaveBeenCalledOnce();
    expect(mocks.persistAck).not.toHaveBeenCalled();
  });

  it("falls back to the bot when the fast model fails", async () => {
    vi.stubEnv("FAST_PATH_BOTS", "*");
    mocks.runFastReply.mockRejectedValue(new Error("provider down"));
    const response = await post("hola");
    expect(await lines(response)).toEqual([{ deliveryId: "delivery-1" }]);
    expect(mocks.log).toHaveBeenCalledWith(
      "message.fast",
      expect.objectContaining({ escalated: true, outcome: "failed" })
    );
  });

  it("sends actions and busy bots the normal way, with pending fast exchanges as context", async () => {
    vi.stubEnv("FAST_PATH_BOTS", "*");
    mocks.pendingFastExchanges.mockResolvedValue([
      { reply: "¡Hola!", text: "hola" },
    ]);
    const response = await post("buscá vuelos a Madrid");
    expect(await response.json()).toEqual({ deliveryId: "delivery-1" });
    expect(mocks.fastIneligible).not.toHaveBeenCalled();
    expect(mocks.pendingFastExchanges).toHaveBeenCalledWith(
      bot.id,
      stored.createdAt
    );
    expect(mocks.sendToBot).toHaveBeenCalledWith(
      bot,
      expect.objectContaining({
        clientContext: expect.objectContaining({
          recentQuickReplies: [{ mati: "hola", you: "¡Hola!" }],
        }),
        text: "buscá vuelos a Madrid",
      }),
      expect.any(Object)
    );
    expect(mocks.log).toHaveBeenCalledWith(
      "message.fast",
      expect.objectContaining({ decision: "action", outcome: "skipped" })
    );

    mocks.fastIneligible.mockResolvedValue("busy");
    await post("hola");
    expect(mocks.runFastReply).not.toHaveBeenCalled();
  });
});
