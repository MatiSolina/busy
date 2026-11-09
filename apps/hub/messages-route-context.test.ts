import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./app/api/bots/[slug]/messages/route";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  db: vi.fn(),
  fileForMessage: vi.fn(),
  getBot: vi.fn(),
  keepOn: vi.fn(),
  messages: { table: "messages" },
  sendToBot: vi.fn(),
  start: vi.fn(),
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/chat/send", () => ({ sendToBot: mocks.sendToBot }));
vi.mock("@/lib/files", () => ({ fileForMessage: mocks.fileForMessage }));
vi.mock("@/lib/keep-on", () => ({ keepOn: mocks.keepOn }));
vi.mock("@/lib/live", () => ({ KEEP_ON_MS: 600_000 }));
vi.mock("@/workflows/sync-turn", () => ({ syncTurnWorkflow: vi.fn() }));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/lib/db", () => ({
  db: mocks.db,
  messageDeliveryAttempts: {},
  messages: mocks.messages,
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  isNull: vi.fn(() => ({})),
  ne: vi.fn(() => ({})),
}));

const bot = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "assistant",
  status: "ready" as const,
};
const messageRow = {
  botId: bot.id,
  clientContext: null,
  fileIds: [] as string[],
  id: "22222222-2222-4222-8222-222222222222",
  payloadHash: null,
  status: "pending",
  text: "",
};
let storedRow: Record<string, unknown> | null;
const context = () => ({ params: Promise.resolve({ slug: bot.slug }) });

beforeEach(() => {
  vi.resetAllMocks();
  storedRow = { ...messageRow };
  mocks.getBot.mockResolvedValue(bot);
  mocks.sendToBot.mockResolvedValue({ deliveryId: "delivery-1" });
  mocks.fileForMessage.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue(undefined);
  mocks.keepOn.mockResolvedValue(undefined);
  mocks.db.mockReturnValue({
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => {
          const inserted = !storedRow;
          storedRow ??= { ...values, status: "pending" };
          return { returning: () => (inserted ? [storedRow] : []) };
        },
      }),
    }),
    select: () => ({
      from: () => ({ where: () => (storedRow ? [storedRow] : []) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          if (storedRow) {
            storedRow = { ...storedRow, ...values };
          }
        },
      }),
    }),
  });
});

const request = (body: unknown) =>
  new Request("http://busy.test/api/bots/assistant/messages", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

describe("message browser context", () => {
  it("acknowledges a persisted delivery without waiting for maintenance", async () => {
    storedRow = { ...messageRow, text: "Hello" };
    mocks.start.mockReturnValue(new Promise(() => undefined));
    mocks.keepOn.mockReturnValue(new Promise(() => undefined));

    const response = await POST(
      request({ id: messageRow.id, text: "Hello" }),
      context()
    );

    expect(await response.json()).toEqual({ deliveryId: "delivery-1" });
    expect(storedRow?.status).toBe("accepted");
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.keepOn).not.toHaveBeenCalled();

    const maintenance = mocks.after.mock.calls[0]?.[0]() as Promise<void>;
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.keepOn).toHaveBeenCalledOnce();
    // Both jobs intentionally remain pending; neither holds up the acknowledgement.
    expect(maintenance).toBeInstanceOf(Promise);
  }, 1000);

  it("keeps an accepted delivery successful when maintenance fails", async () => {
    storedRow = { ...messageRow, text: "Hello" };
    mocks.start.mockRejectedValue(new Error("workflow unavailable"));
    mocks.keepOn.mockRejectedValue(new Error("watch unavailable"));

    const response = await POST(
      request({ id: messageRow.id, text: "Hello" }),
      context()
    );

    expect(response.status).toBe(200);
    await expect(mocks.after.mock.calls[0]?.[0]()).resolves.toBeUndefined();
    expect(storedRow?.status).toBe("accepted");
  });

  it("returns the same accepted delivery on retry without starting more work", async () => {
    storedRow = { ...messageRow, text: "Hello" };
    const body = { id: messageRow.id, text: "Hello" };

    await POST(request(body), context());
    const retry = await POST(request(body), context());

    expect(await retry.json()).toEqual({ deliveryId: "delivery-1" });
    expect(mocks.sendToBot).toHaveBeenCalledOnce();
    expect(mocks.after).toHaveBeenCalledOnce();
  });

  it("forwards a valid browser time zone without changing visible text", async () => {
    const text = "Todos los días a las 9 hacé el resumen.";
    storedRow = {
      ...messageRow,
      clientContext: { timeZone: "America/Argentina/Cordoba" },
      text,
    };
    const response = await POST(
      request({
        clientContext: { timeZone: "America/Argentina/Cordoba" },
        id: messageRow.id,
        text,
      }),
      context()
    );
    expect(response.status).toBe(200);
    expect(mocks.sendToBot).toHaveBeenCalledWith(
      bot,
      expect.objectContaining({
        clientContext: { timeZone: "America/Argentina/Cordoba" },
        id: messageRow.id,
        text,
      }),
      expect.any(Object)
    );
  });

  it("rejects an invalid time zone before sending to the bot", async () => {
    const response = await POST(
      request({
        clientContext: { timeZone: "Mars/Olympus" },
        id: messageRow.id,
        text: "Create a routine.",
      }),
      context()
    );
    expect(response.status).toBe(400);
    expect(mocks.getBot).not.toHaveBeenCalled();
    expect(mocks.sendToBot).not.toHaveBeenCalled();
  });

  it("keeps the context optional for ordinary messages", async () => {
    storedRow = { ...messageRow, text: "Hello" };
    const response = await POST(
      request({ id: messageRow.id, text: "Hello" }),
      context()
    );
    expect(response.status).toBe(200);
    expect(mocks.sendToBot).toHaveBeenCalledWith(
      bot,
      expect.not.objectContaining({ clientContext: expect.anything() }),
      expect.any(Object)
    );
  });

  it("does not expose transport or provider error details", async () => {
    storedRow = null;
    mocks.sendToBot.mockRejectedValue(
      new Error("upstream bearer secret: do-not-send-this")
    );

    const response = await POST(
      request({ id: messageRow.id, text: "Hello" }),
      context()
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.code).toBe("message_delivery_failed");
    expect(body.error).toBe("message_delivery_failed");
    expect(body.message).not.toContain("do-not-send-this");
    expect(body.message).toBe("Busy could not send this message.");
  });
});
