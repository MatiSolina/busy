import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./app/api/bots/[slug]/messages/route";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  db: vi.fn(),
  fileForMessage: vi.fn(),
  getBot: vi.fn(),
  keepOn: vi.fn(),
  linkFileProvenance: vi.fn(),
  messages: { table: "messages" },
  row: null as Record<string, unknown> | null,
  sendToBot: vi.fn(),
  start: vi.fn(),
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/chat/send", () => ({ sendToBot: mocks.sendToBot }));
vi.mock("@/lib/db", () => ({
  db: mocks.db,
  messageDeliveryAttempts: {},
  messages: mocks.messages,
}));
vi.mock("@/lib/files", () => ({ fileForMessage: mocks.fileForMessage }));
vi.mock("@/lib/keep-on", () => ({ keepOn: mocks.keepOn }));
vi.mock("@/lib/library-objects", () => ({
  linkFileProvenance: mocks.linkFileProvenance,
}));
vi.mock("@/lib/live", () => ({ KEEP_ON_MS: 600_000 }));
vi.mock("@/lib/routines/schedule", () => ({
  validTimeZone: () => true,
}));
vi.mock("@/workflows/sync-turn", () => ({ syncTurnWorkflow: vi.fn() }));
vi.mock("drizzle-orm", () => ({
  and: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  isNull: vi.fn(() => ({})),
  ne: vi.fn(() => ({})),
}));
vi.mock("workflow/api", () => ({ start: mocks.start }));

const bot = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "assistant",
  status: "ready" as const,
};
const messageId = "22222222-2222-4222-8222-222222222222";
const PAYLOAD_HASH_RE = /^[0-9a-f]{64}$/u;

const context = () => ({ params: Promise.resolve({ slug: bot.slug }) });
const request = (body: unknown) =>
  new Request("http://busy.test/api/bots/assistant/messages", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.row = null;
  mocks.getBot.mockResolvedValue(bot);
  mocks.fileForMessage.mockResolvedValue(undefined);
  mocks.keepOn.mockResolvedValue(undefined);
  mocks.linkFileProvenance.mockResolvedValue(undefined);
  mocks.sendToBot
    .mockRejectedValueOnce(new Error("temporary"))
    .mockResolvedValue({
      deliveryId: "delivery-1",
    });
  mocks.start.mockResolvedValue(undefined);
  mocks.db.mockReturnValue({
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => {
          const inserted = !mocks.row;
          mocks.row ??= { ...values, status: "pending" };
          return { returning: () => (inserted ? [mocks.row] : []) };
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: async () => (mocks.row ? [mocks.row] : []),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          if (mocks.row) {
            mocks.row = { ...mocks.row, ...values };
          }
        },
      }),
    }),
  });
});

describe("message idempotency", () => {
  it("persists the payload before send and resends it on retry", async () => {
    const body = { id: messageId, text: "Research this." };
    const first = await POST(request(body), context());

    expect(first.status).toBe(502);
    expect(mocks.row).toEqual(
      expect.objectContaining({
        payloadHash: expect.stringMatching(PAYLOAD_HASH_RE),
        status: "failed",
      })
    );

    const second = await POST(request(body), context());

    expect(second.status).toBe(200);
    expect(mocks.sendToBot).toHaveBeenCalledTimes(2);
    expect(mocks.sendToBot).toHaveBeenLastCalledWith(
      bot,
      expect.objectContaining({ id: messageId, text: "Research this." }),
      expect.any(Object)
    );
  });

  it("keeps the hash that messages stored while skills could be picked have", async () => {
    await POST(request({ id: messageId, text: "Research this." }), context());
    // The payload shape every message had before, with no skill picked.
    const before = JSON.stringify({
      botId: bot.id,
      clientContext: null,
      fileIds: [],
      selectedSkills: [],
      text: "Research this.",
    });
    expect(mocks.row?.payloadHash).toBe(
      createHash("sha256").update(before).digest("hex")
    );
  });

  it("retries a message stored with picked skills, without their content", async () => {
    const selectedSkills = [
      {
        capabilityId: "33333333-3333-4333-8333-333333333333",
        skillName: "research",
      },
    ];
    // A message stored before the picker was removed: its hash covers the skill references.
    const before = JSON.stringify({
      botId: bot.id,
      clientContext: null,
      fileIds: [],
      selectedSkills,
      text: "Research this.",
    });
    mocks.row = {
      botId: bot.id,
      clientContext: null,
      fileIds: [],
      id: messageId,
      payloadHash: createHash("sha256").update(before).digest("hex"),
      status: "failed",
      text: "Research this.",
    };
    mocks.sendToBot.mockReset();
    mocks.sendToBot.mockResolvedValue({ deliveryId: "delivery-1" });

    const retried = await POST(
      request({ id: messageId, selectedSkills, text: "Research this." }),
      context()
    );

    expect(retried.status).toBe(200);
    expect(mocks.sendToBot).toHaveBeenCalledWith(
      bot,
      {
        files: [],
        id: messageId,
        text: "Research this.",
      },
      expect.any(Object)
    );
  });

  it("rejects a changed payload for the same UUID without sending", async () => {
    await POST(request({ id: messageId, text: "Research this." }), context());
    const sends = mocks.sendToBot.mock.calls.length;

    const changed = await POST(
      request({ id: messageId, text: "Changed." }),
      context()
    );

    expect(changed.status).toBe(409);
    expect(mocks.sendToBot).toHaveBeenCalledTimes(sends);
  });

  it("rejects a UUID another bot already used, in JSON", async () => {
    await POST(request({ id: messageId, text: "Research this." }), context());
    mocks.getBot.mockResolvedValue({
      ...bot,
      id: "33333333-3333-4333-8333-333333333333",
    });

    const other = await POST(
      request({ id: messageId, text: "Research this." }),
      context()
    );

    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({
      error: "This message id belongs to another bot.",
    });
  });
});
