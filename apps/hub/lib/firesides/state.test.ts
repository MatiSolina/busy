import { describe, expect, it } from "vitest";
import { fixtureRecords } from "../chat/chat.test-helpers";
import { toChatView } from "../chat/items";
import type { StreamRecord } from "../eve/client";
import { projectRecords } from "./project";
import { applyCommand, nextSpeaker, requestCancel, summarize } from "./state";
import { activate, initialState } from "./test-helpers";

function reply(turn = "turn-one", text = "My opinion"): StreamRecord[] {
  return [
    {
      line: 0,
      record: {
        facts: [
          { data: { turnId: turn }, type: "turn.started" },
          {
            data: {
              kind: "text",
              partId: "final",
              phase: "reply",
              value: text,
            },
            type: "content.completed",
          },
          {
            data: { outcome: "completed", reply: ["final"], turnId: turn },
            type: "turn.settled",
          },
        ],
      },
    },
  ];
}

describe("bounded full-agent fireside", () => {
  it("streams only public text, including chunks without a repeated kind", () => {
    const state = initialState();
    activate(state, "guest");
    projectRecords(state, [
      {
        line: 0,
        record: { facts: [{ data: { turnId: "turn" }, type: "turn.started" }] },
      },
      ...[
        { delta: "private reasoning", kind: "reasoning", partId: "thought" },
        { delta: " still private", partId: "thought" },
        { delta: "untyped content", partId: "unknown" },
        { delta: "Visible", kind: "text", partId: "reply" },
        { delta: " reply", partId: "reply" },
      ].map((data, index) => ({
        line: index + 1,
        record: { progress: { data, type: "content.delta" } },
      })),
    ]);
    const { active } = state;
    if (!active) {
      throw new Error("Expected a streaming turn.");
    }
    const view = toChatView(
      active.rows,
      new Map(Object.entries(active.deltas)),
      new Map(),
      () => undefined
    );
    expect(view.items.filter((item) => item.kind === "bot")).toEqual([
      { id: "reply", kind: "bot", streaming: true, text: "Visible reply" },
    ]);
  });
  it("alternates guest then primary, and no runtime event grants more turns", () => {
    const state = initialState();
    expect(nextSpeaker(state)).toBe("guest");
    activate(state, "guest");
    projectRecords(state, reply());
    expect(nextSpeaker(state)).toBe("primary");
    activate(state, "primary");
    projectRecords(state, reply("turn-primary"));
    expect(state.status).toBe("waiting");
    expect(nextSpeaker(state)).toBeNull();
    projectRecords(state, reply("extra"));
    expect(state.messages).toHaveLength(2);
  });
  it("projects the actual Eve v27 fixture and uses only native final reply ids", () => {
    const state = initialState();
    activate(state, "guest");
    projectRecords(state, fixtureRecords);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.text).toBe("Hello, QA Grok!");
    expect(state.remaining).toEqual({ guest: 0, primary: 1 });
    expect(state.active).toBeNull();
  });
  it("does not advance for delivery acknowledgement, narration, or a paused question", () => {
    const state = initialState();
    activate(state, "guest");
    projectRecords(state, [
      {
        line: 0,
        record: {
          facts: [
            {
              data: { deliveryId: state.active?.deliveryId },
              type: "delivery.admitted",
            },
            { data: { turnId: "turn" }, type: "turn.started" },
            {
              data: {
                kind: "text",
                partId: "n",
                phase: "narration",
                value: "Working",
              },
              type: "content.completed",
            },
            {
              data: { awaiting: [{ interactionId: "ask" }] },
              type: "turn.paused",
            },
          ],
        },
      },
    ]);
    expect(state.remaining.guest).toBe(1);
    expect(state.messages).toHaveLength(0);
    expect(nextSpeaker(state)).toBeNull();
  });
  it("fences stale completion after intervention and cancels the old session", () => {
    const state = initialState();
    activate(state, "guest");
    const old = structuredClone(state.active);
    applyCommand(state, {
      id: "human",
      kind: "intervene",
      revision: 1,
      text: "Consider the cost",
    });
    expect(state.cancelSessions).toEqual(["fire-guest"]);
    expect(state.messages[0]?.speaker).toBe("user");
    state.active = old;
    projectRecords(state, reply());
    expect(state.messages).toHaveLength(1);
    expect(state.remaining).toEqual({ guest: 1, primary: 1 });
  });
  it("pause and resume preserve the unspent slot instead of granting two more", () => {
    const state = initialState();
    activate(state, "guest");
    projectRecords(state, reply());
    activate(state, "primary");
    applyCommand(state, {
      id: "pause",
      kind: "pause",
      revision: state.revision,
    });
    state.cancelSessions = [];
    state.participants.primary.sessionId = null;
    applyCommand(state, {
      id: "resume",
      kind: "continue",
      revision: state.revision,
    });
    expect(state.remaining).toEqual({ guest: 0, primary: 1 });
    expect(nextSpeaker(state)).toBe("primary");
  });
  it("retains interrupted output, attributes disagreement, and closing never claims consensus", () => {
    const state = initialState();
    activate(state, "guest");
    projectRecords(state, reply("guest", "Do not ship"));
    activate(state, "primary");
    projectRecords(state, [
      {
        line: 0,
        record: {
          facts: [
            { data: { turnId: "primary" }, type: "turn.started" },
            {
              data: {
                kind: "text",
                partId: "partial",
                phase: "reply",
                value: "Maybe",
              },
              type: "content.completed",
            },
          ],
        },
      },
    ]);
    applyCommand(state, {
      id: "close",
      kind: "close",
      revision: state.revision,
    });
    expect(state.status).toBe("closing");
    expect(state.cancelSessions).toContain("fire-primary");
    expect(state.messages.at(-1)).toMatchObject({
      interrupted: true,
      text: "Maybe",
    });
    expect(state.summary).toContain("Do not ship");
    expect(state.summary).toContain("interrupted");
    expect(state.summary).not.toContain("Maybe");
    expect(summarize(state)).toContain("primary: did not complete");
  });
  it("rejects stale continue but accepts close from a stale tab", () => {
    const state = initialState();
    state.revision = 9;
    expect(() =>
      applyCommand(state, { id: "bad", kind: "continue", revision: 1 })
    ).toThrow("changed");
    applyCommand(state, { id: "close", kind: "close", revision: 1 });
    expect(state.status).toBe("closing");
  });
  it("replay overlap cannot append the same final reply twice", () => {
    const state = initialState();
    activate(state, "guest");
    projectRecords(state, reply());
    projectRecords(state, reply());
    expect(state.messages).toHaveLength(1);
  });
  it("keeps the latest human direction inside the handoff byte budget even after long replies", () => {
    const state = initialState();
    state.messages = [
      { at: "now", id: "g", speaker: "guest", text: "g".repeat(20_000) },
      { at: "now", id: "p", speaker: "primary", text: "p".repeat(20_000) },
      {
        at: "now",
        id: "u",
        speaker: "user",
        text: "Stop and reconsider the cost",
      },
    ];
    expect(summarize(state).slice(0, 8000)).toContain(
      "Stop and reconsider the cost"
    );
    expect(summarize(state).length).toBeLessThan(8000);
  });
});

describe("participant cancellation requests (N-05)", () => {
  it("records one entry per session with its participant and generation, and a repeated close adds nothing", () => {
    const state = initialState();
    activate(state, "guest");
    const at = new Date("2026-11-08T12:00:00.000Z");
    requestCancel(state, "fire-guest", at);
    applyCommand(state, { id: "close", kind: "close", revision: 1 });
    applyCommand(state, { id: "close-2", kind: "close", revision: 9 });
    requestCancel(state, "fire-guest");
    expect(state.cancelSessions).toEqual(["fire-guest", "fire-primary"]);
    expect(state.cancellations?.["fire-guest"]).toEqual({
      attempts: 0,
      computerStopPending: false,
      generation: 0,
      lastError: null,
      nextAttemptAt: null,
      participantId: state.participants.guest.id,
      requestedAt: at.toISOString(),
    });
    expect(Object.keys(state.cancellations ?? {})).toHaveLength(2);
  });
});
