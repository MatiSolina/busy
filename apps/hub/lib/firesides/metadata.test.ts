import { describe, expect, it } from "vitest";
import {
  firesideTerminalOutcome,
  runtimeMetadata,
  shouldProjectFiresideTurn,
} from "./metadata";
import { projectRecords } from "./project";
import { archiveInterrupted } from "./state";
import { activate, initialState } from "./test-helpers";

describe("fireside runtime metadata", () => {
  it("preserves actual model/run/trace IDs without content", () => {
    const state = initialState();
    activate(state, "guest");
    projectRecords(state, [
      {
        line: 3,
        record: {
          at: "2026-11-04T20:00:00.000Z",
          facts: [
            {
              data: { turnId: "turn_1" },
              type: "turn.started",
            },
            {
              data: {
                kind: "text",
                partId: "reply",
                phase: "reply",
                trace: {
                  spanId: "0123456789abcdef",
                  traceId: "0123456789abcdef0123456789abcdef",
                },
                value: "private reply content",
              },
              scope: { runId: "run_1", turnId: "turn_1" },
              type: "model.started",
            },
            {
              data: {
                outcome: "completed",
                reply: ["reply"],
                turnId: "turn_1",
              },
              type: "turn.settled",
            },
          ],
        },
      },
    ]);
    const runtime = state.messages[0]?.runtime;
    expect(runtime).toMatchObject({
      model: "grok/grok-4.7",
      provider: "grok",
      sessionId: "fire-guest",
      turnId: "turn_1",
    });
    expect(runtime?.events).toContainEqual(
      expect.objectContaining({
        runId: "run_1",
        spanId: "0123456789abcdef",
        traceId: "0123456789abcdef0123456789abcdef",
        type: "model.started",
      })
    );
    const serialized = JSON.stringify(runtime);
    expect(serialized).not.toContain("private reply content");
    expect(serialized).not.toContain("prompt");
  });

  it("does not invent IDs when the source fact has none", () => {
    const state = initialState();
    activate(state, "guest");
    const runtime = state.active
      ? runtimeMetadata(state.active, state.participants.guest)
      : null;
    expect(runtime?.events).toEqual([]);
  });

  it("maps cancellation to a skipped terminal outcome", () => {
    expect(firesideTerminalOutcome("completed")).toBe("completed");
    expect(firesideTerminalOutcome("cancelled")).toBe("skipped");
    expect(firesideTerminalOutcome("rejected")).toBe("skipped");
    expect(firesideTerminalOutcome("failed")).toBe("failed");
  });

  it("rejects a stale callback even when the row update itself succeeded", () => {
    expect(
      shouldProjectFiresideTurn(
        { messageId: "new-message", revision: 3 },
        { messageId: "old-message", revision: 2 }
      )
    ).toBe(false);
    expect(
      shouldProjectFiresideTurn(
        { messageId: "new-message", revision: 3 },
        { messageId: "new-message", revision: 3 }
      )
    ).toBe(true);
  });

  it("keeps the current delivery turn when an earlier turn shares the batch", () => {
    const state = initialState();
    activate(state, "guest");
    const deliveryId = state.active?.deliveryId;
    projectRecords(state, [
      {
        line: 1,
        record: {
          facts: [{ data: { turnId: "old-turn" }, type: "turn.started" }],
        },
      },
      {
        line: 2,
        record: {
          facts: [
            {
              data: { deliveryId, turnId: "current-turn" },
              type: "delivery.consumed",
            },
            {
              data: { outcome: "completed", turnId: "old-turn" },
              type: "turn.settled",
            },
            {
              data: { outcome: "cancelled", turnId: "current-turn" },
              type: "turn.settled",
            },
            {
              data: {
                kind: "text",
                partId: "partial",
                phase: "reply",
                value: "partial",
              },
              type: "content.completed",
            },
          ],
        },
      },
    ]);
    expect(state.messages[0]?.runtime?.turnId).toBe("current-turn");
  });

  it("marks archived interruption metadata when projectRecords evicts older events", () => {
    const state = initialState();
    activate(state, "guest");
    projectRecords(state, [
      {
        line: 0,
        record: {
          facts: [
            {
              data: {
                kind: "text",
                partId: "partial",
                phase: "reply",
                value: "partial reply",
              },
              type: "content.completed",
            },
          ],
        },
      },
    ]);
    const { active } = state;
    if (!active) {
      throw new Error("Expected an active turn.");
    }
    const metadataFacts = Array.from({ length: 5001 }, (_, index) => ({
      data: { runId: `run-${index}` },
      type: "model.started" as const,
    }));
    expect(() =>
      projectRecords(state, [{ line: 1, record: { facts: metadataFacts } }])
    ).toThrow("Fireside turn exceeded its event limit.");
    expect(active.eventsTruncated).toBe(true);
    expect(active.eventMetadata).toHaveLength(5000);
    expect(active.eventMetadata?.[0]?.runId).toBe("run-1");

    archiveInterrupted(state);

    const runtime = state.messages[0]?.runtime;
    expect(runtime?.events).toHaveLength(5000);
    expect(runtime?.eventsTruncated).toBe(true);
    expect(runtime?.events?.[0]?.line).toBe(1);
    expect(runtime?.events?.at(-1)?.runId).toBe("run-5000");
  });
});
