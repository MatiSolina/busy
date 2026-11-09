import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FAST_INDEX_BASE } from "./fast-path";

const mocks = vi.hoisted(() => {
  const tables = {
    bots: { name: "bots" },
    codeTasks: { name: "codeTasks" },
    consultations: { name: "consultations" },
    cursors: { name: "cursors" },
    events: { name: "events" },
    memories: { name: "memories" },
    messages: { name: "messages" },
  };
  return {
    access: vi.fn(),
    createGateway: vi.fn(),
    db: vi.fn(),
    inserted: [] as unknown[],
    oidc: vi.fn(),
    tables,
    updated: [] as unknown[],
  };
});

vi.mock("../db", () => ({ db: mocks.db, ...mocks.tables }));
const slots = vi.hoisted(() => ({
  consumeFastSlot: vi.fn(),
  releaseFastSlot: vi.fn(),
  reserveFastSlot: vi.fn(),
}));
vi.mock("./fast-slots", () => ({
  ...slots,
  FastSlotLost: class FastSlotLost extends Error {},
}));
vi.mock("./send", () => ({
  recentHistory: async () => "User: hi\nYou: hello",
}));
vi.mock("../ai/subscription-store", () => ({
  getSubscriptionAccess: mocks.access,
}));
vi.mock("@vercel/oidc", () => ({ getVercelOidcToken: mocks.oidc }));
vi.mock("ai", async (original) => {
  const actual = await original<typeof import("ai")>();
  return {
    ...actual,
    createGateway: mocks.createGateway.mockImplementation(actual.createGateway),
  };
});

const {
  FAST_FIRST_OUTPUT_MS,
  fastIneligible,
  fastModel,
  persistAck,
  runFastReply,
} = await import("./fast-reply");

const bot = {
  billing: "gateway",
  description: "Helps.",
  historyPending: false,
  id: "11111111-1111-4111-8111-111111111111",
  instructions: "Be kind.",
  model: "moonshotai/kimi-k3",
  name: "Ana",
  sessionId: "session-1",
  slug: "ana",
} as unknown as Parameters<typeof runFastReply>[0]["bot"];
const messageId = "22222222-2222-4222-8222-222222222222";

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 7, total: 7 },
  outputTokens: { reasoning: 0, text: 3, total: 3 },
};
const model = (chunks: unknown[]) =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          ...chunks,
          {
            finishReason: { raw: undefined, unified: "stop" },
            type: "finish",
            usage,
          },
        ] as never,
      }),
    }),
  });
const text = (...deltas: string[]) => [
  { id: "t", type: "text-start" },
  ...deltas.map((delta) => ({ delta, id: "t", type: "text-delta" })),
  { id: "t", type: "text-end" },
];
const escalate = {
  input: "{}",
  toolCallId: "c1",
  toolName: "escalate",
  type: "tool-call",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inserted = [];
  mocks.updated = [];
  slots.reserveFastSlot.mockResolvedValue({ index: FAST_INDEX_BASE, line: 41 });
  slots.consumeFastSlot.mockResolvedValue(undefined);
  slots.releaseFastSlot.mockResolvedValue(undefined);
  const results = new Map<unknown, unknown[]>([
    [mocks.tables.bots, [{ sessionId: "session-1" }]],
    [mocks.tables.memories, [{ content: "The user likes tea." }]],
    [mocks.tables.cursors, [{ nextLine: 42 }]],
    [mocks.tables.events, [{ index: null }]],
  ]);
  const q = {
    insert: () => ({
      values: (rows: unknown[]) => {
        mocks.inserted.push(...rows);
        return Promise.resolve();
      },
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: async () => results.get(table) ?? [],
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        insert: () => ({
          values: (rows: unknown[]) => {
            mocks.inserted.push(...rows);
            return Promise.resolve();
          },
        }),
        update: () => ({
          set: (values: unknown) => ({
            where: () => {
              mocks.updated.push(values);
              return Promise.resolve();
            },
          }),
        }),
      }),
  };
  mocks.db.mockReturnValue(q);
});

describe("runFastReply", () => {
  it("streams, then stores the exchange after eve's last line and accepts the message", async () => {
    const lines: unknown[] = [];
    const result = await runFastReply(
      { bot, messageId, model: model(text("Ho", "la")), text: "hola" },
      (line) => lines.push(line)
    );
    expect(result).toMatchObject({
      escalated: false,
      inputTokens: 7,
      outputTokens: 3,
      reply: "Hola",
    });
    expect(result.ttftMs).toBeGreaterThanOrEqual(0);
    const types = lines.map((l) =>
      "fact" in (l as object)
        ? (l as { fact: { type: string } }).fact.type
        : Object.keys(l as object)[0]
    );
    expect(types).toEqual([
      "delivery.consumed",
      "turn.started",
      "progress",
      "progress",
      "content.completed",
      "turn.settled",
    ]);
    expect(
      mocks.inserted.map((r) => {
        const row = r as { index: number; line: number; sessionId: string };
        return [row.sessionId, row.line, row.index - FAST_INDEX_BASE];
      })
    ).toEqual([
      ["session-1", 41, 0],
      ["session-1", 41, 1],
      ["session-1", 41, 2],
      ["session-1", 41, 3],
    ]);
    expect(mocks.updated).toEqual([
      { deliveryId: `fast:${messageId}`, status: "accepted" },
    ]);
    expect(slots.consumeFastSlot).toHaveBeenCalledOnce();
    expect(slots.releaseFastSlot).not.toHaveBeenCalled();
  });

  it("stores a reaction alone on the settle, with no reply row", async () => {
    const react = {
      input: JSON.stringify({ emoji: "👍" }),
      toolCallId: "r1",
      toolName: "react",
      type: "tool-call",
    };
    const result = await runFastReply(
      { bot, messageId, model: model([react]), text: "gracias!" },
      () => {
        // Rows are checked through what was stored.
      }
    );
    expect(result).toMatchObject({ escalated: false, reply: "" });
    const stored = mocks.inserted as {
      data: { data: Record<string, unknown> };
      type: string;
    }[];
    expect(stored.map((r) => r.type)).toEqual([
      "delivery.consumed",
      "turn.started",
      "turn.settled",
    ]);
    expect(stored[2]?.data.data).toMatchObject({ reaction: "👍" });
  });

  it("puts the bot's instructions, memory and recent chat in the prompt", async () => {
    const m = model(text("ok"));
    await runFastReply({ bot, messageId, model: m, text: "hola" }, () => {
      // Lines are covered above.
    });
    const prompt = JSON.stringify(m.doStreamCalls[0]?.prompt);
    expect(prompt).toContain("You are Ana. Helps.");
    expect(prompt).toContain("Be kind.");
    expect(prompt).toContain("The user likes tea.");
    expect(prompt).toContain("User: hi");
    expect(m.doStreamCalls[0]?.tools?.map((t) => t.name)).toEqual([
      "escalate",
      "react",
    ]);
  });

  it("escalates before any text: nothing is shown or stored", async () => {
    const lines: unknown[] = [];
    const result = await runFastReply(
      { bot, messageId, model: model([escalate]), text: "hola" },
      (line) => lines.push(line)
    );
    expect(result.escalated).toBe(true);
    expect(lines).toEqual([]);
    expect(mocks.inserted).toEqual([]);
    expect(mocks.updated).toEqual([]);
    expect(slots.releaseFastSlot).toHaveBeenCalledWith(
      "session-1",
      { index: FAST_INDEX_BASE, line: 41 },
      messageId
    );
  });

  it("carries the model's status phrase on escalation", async () => {
    const result = await runFastReply(
      {
        bot,
        messageId,
        model: model([
          {
            ...escalate,
            input: JSON.stringify({ status: "Finding leads for Acme…" }),
          },
        ]),
        text: "find me leads",
      },
      () => undefined
    );
    expect(result).toMatchObject({
      escalated: true,
      status: "Finding leads for Acme",
    });
  });

  it("gives up on a silent model so the message reaches the bot", async () => {
    vi.useFakeTimers();
    try {
      const silent = new MockLanguageModelV4({
        doStream: async ({ abortSignal }) => ({
          stream: new ReadableStream({
            start(controller) {
              abortSignal?.addEventListener("abort", () =>
                controller.error(new DOMException("aborted", "AbortError"))
              );
            },
          }),
        }),
      });
      const run = runFastReply(
        { bot, messageId, model: silent, text: "hola" },
        () => undefined
      );
      const failed = expect(run).rejects.toMatchObject({
        name: "TimeoutError",
      });
      await vi.advanceTimersByTimeAsync(FAST_FIRST_OUTPUT_MS);
      await failed;
      expect(mocks.inserted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("escalates after a draft: the draft is retracted and nothing is stored", async () => {
    const lines: unknown[] = [];
    const result = await runFastReply(
      {
        bot,
        messageId,
        model: model([...text("Let me"), escalate]),
        text: "hola",
      },
      (line) => lines.push(line)
    );
    expect(result.escalated).toBe(true);
    expect(lines.at(-1)).toEqual({ retract: true });
    expect(mocks.inserted).toEqual([]);
  });

  it("with FAST_PATH_ACK, keeps a line written before escalating, without storing it yet", async () => {
    const lines: unknown[] = [];
    const m = model([...text("Busco ", "vuelos."), escalate]);
    const result = await runFastReply(
      { ack: true, bot, messageId, model: m, text: "buscá vuelos" },
      (line) => lines.push(line)
    );
    expect(result).toMatchObject({
      ack: {
        reply: "Busco vuelos.",
        slot: { index: FAST_INDEX_BASE, line: 41 },
      },
      escalated: true,
    });
    expect(result.ttftMs).toBeGreaterThanOrEqual(0);
    expect(lines).not.toContainEqual({ retract: true });
    expect(mocks.inserted).toEqual([]);
    // Kept for persistAck: the reservation is not released.
    expect(slots.releaseFastSlot).not.toHaveBeenCalled();
    expect(JSON.stringify(m.doStreamCalls[0]?.prompt)).toContain(
      "ONE short sentence"
    );
  });

  it("a message with files or a link always goes on to the bot after its ack", async () => {
    const lines: unknown[] = [];
    const m = model([...text("Abro el link y te cuento.")]);
    const result = await runFastReply(
      {
        ack: true,
        bot,
        messageId,
        model: m,
        mustEscalate: "url",
        text: "mirá https://example.com",
      },
      (line) => lines.push(line)
    );
    // The model answered without escalate: the link still reaches the bot, and the line stays.
    expect(result).toMatchObject({
      ack: { reply: "Abro el link y te cuento." },
      escalated: true,
    });
    expect(lines).not.toContainEqual({ retract: true });
    expect(mocks.inserted).toEqual([]);
    expect(JSON.stringify(m.doStreamCalls[0]?.prompt)).toContain(
      "a link you cannot open here"
    );
  });

  it("with FAST_PATH_ACK, an escalation before any text is unchanged", async () => {
    const lines: unknown[] = [];
    const result = await runFastReply(
      { ack: true, bot, messageId, model: model([escalate]), text: "hola" },
      (line) => lines.push(line)
    );
    expect(result).toEqual({ escalated: true, reply: "", ttftMs: undefined });
    expect(lines).toEqual([]);
  });

  it("stores a kept ack under eve's delivery id, without touching the message", async () => {
    const rows = await persistAck(
      bot,
      { reply: "Busco vuelos.", slot: { index: FAST_INDEX_BASE, line: 41 } },
      messageId,
      "buscá vuelos",
      "delivery-1"
    );
    expect(rows.map((r) => r.type)).toEqual([
      "delivery.consumed",
      "turn.started",
      "content.completed",
    ]);
    expect(mocks.inserted).toHaveLength(3);
    expect(
      (mocks.inserted[0] as { data: { data: { deliveryId: string } } }).data
        .data.deliveryId
    ).toBe("delivery-1");
    expect(mocks.updated).toEqual([]);
  });

  it("drops the ack when eve took the message in a replacement session", async () => {
    const replaced = {
      ...bot,
      sessionId: "session-0",
    } as typeof bot;
    await expect(
      persistAck(
        replaced,
        { reply: "Busco vuelos.", slot: { index: FAST_INDEX_BASE, line: 41 } },
        messageId,
        "buscá vuelos",
        "delivery-1"
      )
    ).rejects.toThrow("session_replaced");
    expect(mocks.inserted).toEqual([]);
  });

  it("retracts and rethrows when the model fails mid-reply", async () => {
    const lines: unknown[] = [];
    const failing = model([
      ...text("Ho"),
      { error: new Error("boom"), type: "error" },
    ]);
    await expect(
      runFastReply({ bot, messageId, model: failing, text: "hola" }, (line) =>
        lines.push(line)
      )
    ).rejects.toThrow();
    expect(lines.at(-1)).toEqual({ retract: true });
    expect(mocks.inserted).toEqual([]);
    expect(slots.releaseFastSlot).toHaveBeenCalledOnce();
  });
});

describe("fastModel billing", () => {
  it("token-pass pays with the team's Token Pass key through AI Gateway", async () => {
    vi.stubEnv("TOKEN_PASS_API_KEY", "tp-key");
    await fastModel({ ...bot, billing: "token-pass" });
    expect(mocks.createGateway).toHaveBeenCalledWith({ apiKey: "tp-key" });
    expect(mocks.oidc).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("gateway pays with the hub's own AI Gateway credentials", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    vi.stubEnv("AI_GATEWAY_API_KEY", undefined as unknown as string);
    mocks.oidc.mockResolvedValue("oidc-token");
    await fastModel(bot);
    expect(mocks.createGateway).toHaveBeenCalledWith({ apiKey: "oidc-token" });
    vi.unstubAllEnvs();
  });

  it("chatgpt goes to the subscription upstream with the shared grant and body filter", async () => {
    mocks.access.mockResolvedValue({
      credentials: { accessToken: "grant-token", accountId: "acct" },
      models: [{ id: "gpt-6.1", label: "GPT" }],
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 500 }));
    const subscribed = { ...bot, billing: "chatgpt", model: "chatgpt/gpt-6.1" };
    await expect(
      runFastReply(
        {
          bot: subscribed as typeof bot,
          messageId,
          model: await fastModel(subscribed as typeof bot),
          text: "hola",
        },
        () => undefined
      )
    ).rejects.toThrow();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer grant-token"
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-6.1",
      store: false,
      stream: true,
    });
    fetchMock.mockRestore();
  });

  it("refuses a subscription model the grant doesn't offer", async () => {
    mocks.access.mockResolvedValue({ credentials: {}, models: [] });
    await expect(
      fastModel({ ...bot, billing: "grok", model: "grok/grok-5" } as typeof bot)
    ).rejects.toThrow("subscription_model_unavailable");
  });
});

describe("fastIneligible", () => {
  it("needs a ready session and a model the billing covers", async () => {
    expect(await fastIneligible({ ...bot, sessionId: null }, messageId)).toBe(
      "no_session"
    );
    expect(
      await fastIneligible({ ...bot, historyPending: true }, messageId)
    ).toBe("no_session");
    vi.stubEnv("TOKEN_PASS_API_KEY", "tp-key");
    expect(
      await fastIneligible(
        { ...bot, billing: "token-pass", model: "anthropic/claude-sonnet-5.5" },
        messageId
      )
    ).toBe("model");
    vi.unstubAllEnvs();
  });
});

describe("fastReasoningEffort", () => {
  it("lowers ChatGPT's reasoning by default and leaves other providers alone", async () => {
    const { fastReasoningEffort } = await import("./fast-reply");
    expect(fastReasoningEffort("chatgpt", undefined)).toBe("low");
    expect(fastReasoningEffort("chatgpt", "minimal")).toBe("minimal");
    expect(fastReasoningEffort("chatgpt", "none")).toBeUndefined();
    expect(fastReasoningEffort("grok", undefined)).toBeUndefined();
    expect(fastReasoningEffort("gateway", "low")).toBeUndefined();
  });
});
