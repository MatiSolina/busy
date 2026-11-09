import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  refreshRoutineRun,
  routineAwaitingInput,
  routineTerminalForEvents,
} from "./lib/routines/monitor";

const h = vi.hoisted(() => ({
  afterSyncFacts: null as Record<string, unknown>[] | null,
  bot: null as Record<string, unknown> | null,
  cursorOf: vi.fn(),
  facts: [] as Record<string, unknown>[],
  messageUpdates: [] as Record<string, unknown>[],
  readStream: vi.fn(),
  routineBotCall: vi.fn(),
  run: null as Record<string, unknown> | null,
  saver: vi.fn(),
  syncSession: vi.fn(),
  updated: [] as Record<string, unknown>[],
}));

const tables = vi.hoisted(() => ({
  bots: { id: {} },
  events: { data: {}, index: {}, line: {}, sessionId: {}, type: {} },
  messages: { deliveryId: {}, id: {}, status: {} },
  runs: { botId: {}, id: {}, status: {} },
}));

vi.mock("@/lib/db", () => {
  class Query {
    table: unknown;
    constructor(table?: unknown) {
      this.table = table;
    }
    from(table: unknown) {
      this.table = table;
      return this;
    }
    where() {
      return this;
    }
    orderBy() {
      return this;
    }
    // biome-ignore lint/suspicious/noThenProperty: this fake query intentionally implements a thenable.
    then(
      resolve: (value: unknown[]) => unknown,
      reject?: (error: unknown) => unknown
    ) {
      let rows: Record<string, unknown>[] = [];
      if (this.table === tables.runs && h.run) {
        rows = [h.run];
      } else if (this.table === tables.bots && h.bot) {
        rows = [h.bot];
      } else if (this.table === tables.events) {
        rows = h.facts;
      }
      return Promise.resolve(rows).then(resolve, reject);
    }
  }
  return {
    bots: tables.bots,
    db: () => ({
      select: () => ({ from: (table: unknown) => new Query(table) }),
      update: (table: unknown) => ({
        set: (changes: Record<string, unknown>) => ({
          where: () => {
            if (table === tables.messages) {
              h.messageUpdates.push(changes);
            }
            return {
              returning: () => {
                if (table === tables.messages) {
                  return Promise.resolve([]);
                }
                if (h.run && h.run.status === "dispatched") {
                  h.run = { ...h.run, ...changes };
                  h.updated.push(changes);
                  return Promise.resolve([
                    { id: h.run.id, status: h.run.status },
                  ]);
                }
                return Promise.resolve([]);
              },
            };
          },
        }),
      }),
    }),
    events: tables.events,
    messages: tables.messages,
    routineRuns: tables.runs,
  };
});

vi.mock("@/lib/chat/store", () => ({
  cursorOf: h.cursorOf,
  saver: h.saver,
}));
vi.mock("@/lib/chat/sync", () => ({ syncSession: h.syncSession }));
vi.mock("@/lib/eve/client", () => ({
  createSession: vi.fn(),
  endSession: vi.fn(),
  readStream: h.readStream,
}));
vi.mock("@/lib/routines/call", () => ({ routineBotCall: h.routineBotCall }));

const runId = "11111111-1111-4111-8111-111111111111";
const fixedNow = new Date("2026-11-02T12:00:00.000Z");

beforeEach(() => {
  h.run = {
    botId: "bot-id",
    deliveryId: "routine-delivery",
    id: runId,
    sessionId: "pinned-session",
    status: "dispatched",
  };
  h.bot = { id: "bot-id", sessionId: "new-current-session", slug: "sales" };
  h.facts = [];
  h.afterSyncFacts = null;
  h.updated = [];
  h.messageUpdates = [];
  h.cursorOf.mockReset().mockResolvedValue(0);
  h.routineBotCall
    .mockReset()
    .mockReturnValue({ token: vi.fn(), url: "https://sales.example" });
  h.readStream.mockReset().mockImplementation(async function* () {
    yield* [];
  });
  h.saver.mockReset().mockReturnValue(vi.fn());
  h.syncSession
    .mockReset()
    .mockImplementation(
      async ({ read }: { read: (start: number) => AsyncIterable<unknown> }) => {
        for await (const _item of read(0)) {
          String(_item);
        }
        if (h.afterSyncFacts) {
          h.facts = h.afterSyncFacts;
        }
      }
    );
});

describe("routineAwaitingInput", () => {
  const paused = {
    data: {
      deliveryId: "routine-delivery",
      outcome: "awaiting-input",
      turnId: "routine-turn",
    },
    type: "delivery.settled",
  };
  const pause = (ids: string[]) => ({
    data: {
      awaiting: ids.map((interactionId) => ({ interactionId })),
      turnId: "routine-turn",
    },
    type: "turn.paused",
  });
  const answered = (interactionId: string) => ({
    data: { interactionId },
    type: "interaction.settled",
  });

  it("is waiting while any request of the latest pause is unanswered", () => {
    expect(routineAwaitingInput("routine-delivery", [paused])).toBe(true);
    expect(
      routineAwaitingInput("routine-delivery", [
        paused,
        pause(["sign-in", "question"]),
        answered("sign-in"),
      ])
    ).toBe(true);
    expect(
      routineAwaitingInput("routine-delivery", [
        paused,
        pause(["question"]),
        answered("question"),
      ])
    ).toBe(false);
    // Paused again after the first answer.
    expect(
      routineAwaitingInput("routine-delivery", [
        paused,
        pause(["question"]),
        answered("question"),
        pause(["approval"]),
      ])
    ).toBe(true);
  });

  it("ignores other deliveries, other turns and handled deliveries", () => {
    expect(
      routineAwaitingInput("other-delivery", [paused, pause(["question"])])
    ).toBe(false);
    expect(
      routineAwaitingInput("routine-delivery", [
        { ...paused, data: { ...paused.data, outcome: "handled" } },
        pause(["question"]),
      ])
    ).toBe(false);
    expect(
      routineAwaitingInput("routine-delivery", [
        paused,
        pause(["question"]),
        answered("question"),
        {
          data: {
            awaiting: [{ interactionId: "other" }],
            turnId: "human-turn",
          },
          type: "turn.paused",
        },
      ])
    ).toBe(false);
  });
});

describe("routineTerminalForEvents", () => {
  it("waits for the routine turn and ignores another turn settling first", () => {
    expect(
      routineTerminalForEvents("routine-delivery", [
        {
          data: { outcome: "completed", turnId: "human-turn" },
          type: "turn.settled",
        },
        {
          data: {
            deliveryId: "routine-delivery",
            outcome: "handled",
            turnId: "routine-turn",
          },
          type: "delivery.settled",
        },
      ])
    ).toBeNull();
    expect(
      routineTerminalForEvents("routine-delivery", [
        {
          data: { outcome: "completed", turnId: "human-turn" },
          type: "turn.settled",
        },
        {
          data: {
            deliveryId: "routine-delivery",
            outcome: "handled",
            turnId: "routine-turn",
          },
          type: "delivery.settled",
        },
        {
          data: { outcome: "completed", turnId: "routine-turn" },
          type: "turn.settled",
        },
      ])?.status
    ).toBe("succeeded");
  });

  it("maps delivery rejection and turn cancellation without exposing provider errors", () => {
    expect(
      routineTerminalForEvents("d", [
        {
          data: { deliveryId: "d", outcome: "rejected" },
          type: "delivery.settled",
        },
      ])
    ).toEqual({
      error: "The routine delivery was not accepted.",
      status: "failed",
    });
    expect(
      routineTerminalForEvents("d", [
        {
          data: { deliveryId: "d", outcome: "refused" },
          type: "delivery.settled",
        },
      ])?.status
    ).toBe("failed");
    expect(
      routineTerminalForEvents("d", [
        {
          data: { deliveryId: "d", outcome: "awaiting-input", turnId: "t" },
          type: "delivery.settled",
        },
        { data: { outcome: "completed", turnId: "t" }, type: "turn.settled" },
      ])?.status
    ).toBe("succeeded");
    expect(
      routineTerminalForEvents("d", [
        {
          data: { deliveryId: "d", outcome: "awaiting-input", turnId: "t" },
          type: "delivery.settled",
        },
        {
          data: { outcome: "completed", turnId: "other" },
          type: "turn.settled",
        },
      ])
    ).toBeNull();
    expect(
      routineTerminalForEvents("d", [
        {
          data: { deliveryId: "d", outcome: "handled", turnId: "t" },
          type: "delivery.settled",
        },
        {
          data: {
            error: "secret provider detail",
            outcome: "cancelled",
            turnId: "t",
          },
          type: "turn.settled",
        },
      ])
    ).toEqual({ error: "The routine was cancelled.", status: "cancelled" });
  });
});

describe("refreshRoutineRun", () => {
  it("reads the session pinned on the run after the bot has rotated", async () => {
    h.afterSyncFacts = [
      {
        data: {
          data: {
            deliveryId: "routine-delivery",
            outcome: "handled",
            turnId: "routine-turn",
          },
          type: "delivery.settled",
        },
      },
      {
        data: {
          data: { outcome: "completed", turnId: "routine-turn" },
          type: "turn.settled",
        },
      },
    ];
    expect(await refreshRoutineRun(runId, fixedNow)).toBe(true);
    expect(h.routineBotCall).toHaveBeenCalledWith("sales", runId);
    expect(h.readStream).toHaveBeenCalledWith(
      expect.anything(),
      "pinned-session",
      0,
      false
    );
    expect(h.updated[0]).toMatchObject({ status: "succeeded" });
    expect(h.messageUpdates[0]).toMatchObject({
      deliveryId: "routine-delivery",
      status: "accepted",
    });
  });

  it("does not reread eve when the exact terminal facts are already persisted", async () => {
    h.facts = [
      {
        data: {
          data: {
            deliveryId: "routine-delivery",
            outcome: "handled",
            turnId: "routine-turn",
          },
          type: "delivery.settled",
        },
      },
      {
        data: {
          data: { outcome: "completed", turnId: "routine-turn" },
          type: "turn.settled",
        },
      },
    ];
    h.readStream.mockImplementation(async function* () {
      yield* [];
      throw new Error("remote stream should not be called");
    });
    expect(await refreshRoutineRun(runId, fixedNow)).toBe(true);
    expect(h.readStream).not.toHaveBeenCalled();
    expect(h.updated[0]).toMatchObject({ status: "succeeded" });
  });

  it("leaves an accepted run pending until its own turn settles", async () => {
    h.facts = [
      {
        data: {
          data: {
            deliveryId: "routine-delivery",
            outcome: "handled",
            turnId: "routine-turn",
          },
          type: "delivery.settled",
        },
      },
    ];
    expect(await refreshRoutineRun(runId, fixedNow)).toBe(false);
    expect(h.updated).toHaveLength(0);
  });

  it("keeps the transport receipt accepted when the routine turn fails", async () => {
    h.facts = [
      {
        data: {
          data: {
            deliveryId: "routine-delivery",
            outcome: "handled",
            turnId: "routine-turn",
          },
          type: "delivery.settled",
        },
      },
      {
        data: {
          data: {
            error: { message: "private provider detail" },
            outcome: "failed",
            turnId: "routine-turn",
          },
          type: "turn.settled",
        },
      },
    ];
    expect(await refreshRoutineRun(runId, fixedNow)).toBe(true);
    expect(h.updated[0]).toMatchObject({ status: "failed" });
    expect(h.messageUpdates).toEqual([
      { deliveryId: "routine-delivery", status: "accepted" },
    ]);
  });

  it("fails a run when its pinned session ended before settlement", async () => {
    h.facts = [
      {
        data: {
          data: {
            error: { message: "private provider detail" },
            outcome: "failed",
          },
          type: "session.ended",
        },
      },
    ];
    expect(await refreshRoutineRun(runId, fixedNow)).toBe(true);
    expect(h.updated[0]).toEqual({
      error:
        "The bot session ended before this routine could finish. Check the chat.",
      finishedAt: fixedNow,
      status: "failed",
    });
    expect(h.messageUpdates).toEqual([
      { deliveryId: "routine-delivery", status: "accepted" },
    ]);
  });

  it("propagates a stream failure and does not mark the run failed", async () => {
    h.readStream.mockImplementation(async function* () {
      yield* [];
      throw new Error("provider secret should not be persisted");
    });
    await expect(refreshRoutineRun(runId, fixedNow)).rejects.toThrow(
      "provider secret"
    );
    expect(h.updated).toHaveLength(0);
    expect(h.run?.status).toBe("dispatched");
  });

  it("fails a pinned session that Eve definitively reports as unavailable", async () => {
    h.readStream.mockImplementation(async function* () {
      yield* [];
      throw new Error("eve stream failed: 404 session_not_active");
    });
    expect(await refreshRoutineRun(runId, fixedNow)).toBe(true);
    expect(h.updated[0]).toMatchObject({
      error:
        "The bot session is no longer available; this routine result could not be verified. Check the chat before running it again.",
      status: "failed",
    });
    expect(h.messageUpdates[0]).toMatchObject({
      deliveryId: "routine-delivery",
      status: "accepted",
    });
  });
  it("uses only the matching model failure when a turn settlement omits its error", () => {
    expect(
      routineTerminalForEvents("d", [
        {
          data: { deliveryId: "d", outcome: "handled", turnId: "t" },
          type: "delivery.settled",
        },
        {
          data: {
            error: { provider: "grok", status: 429 },
            outcome: "failed",
            turnId: "other",
          },
          type: "model.settled",
        },
        {
          data: {
            error: { provider: "grok", status: 429 },
            outcome: "failed",
            turnId: "t",
          },
          type: "model.settled",
        },
        { data: { outcome: "failed", turnId: "t" }, type: "turn.settled" },
      ])
    ).toEqual({
      error: "Grok is busy right now. Try again in a moment.",
      status: "failed",
    });
  });

  it("keeps the provider and next action when a routine model is rate limited", () => {
    expect(
      routineTerminalForEvents("d", [
        {
          data: { deliveryId: "d", outcome: "handled", turnId: "t" },
          type: "delivery.settled",
        },
        {
          data: {
            error: {
              code: "rate_limit_exceeded",
              provider: "grok",
              status: 429,
            },
            outcome: "failed",
            turnId: "t",
          },
          type: "turn.settled",
        },
      ])
    ).toEqual({
      error: "Grok is busy right now. Try again in a moment.",
      status: "failed",
    });
  });
});
