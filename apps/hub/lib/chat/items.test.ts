import { describe, expect, it } from "vitest";
import {
  callSettled,
  consumed,
  reply,
  requested,
  seq,
  started,
} from "./chat.test-helpers";
import { type ClientRow, createChatViewProjector, toChatView } from "./items";
import { isWorking, waitStage } from "./status";

const delivery = (text: string): ClientRow => ({
  data: {
    data: {
      deliveryId: "delivery-1",
      parts: [{ kind: "text", text }],
    },
    type: "delivery.consumed",
  },
  index: 0,
  line: 0,
  type: "delivery.consumed",
});

describe("chat view projector", () => {
  it("reuses completed row items while applying multiple live deltas", () => {
    const rows = seq(started("turn-1"), reply("completed", "Stored reply"));
    const projector = createChatViewProjector(rows, new Map());
    const first = projector.project(
      new Map([
        ["completed", "late delta must be ignored"],
        ["live-a", "Hel"],
      ])
    );
    const second = projector.project(
      new Map([
        ["completed", "late delta must be ignored"],
        ["live-a", "Hello"],
        ["live-b", " world"],
      ])
    );

    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(3);
    expect(second.items[0]).toBe(first.items[0]);
    expect(second.items[1]).toMatchObject({
      id: "live-a",
      kind: "bot",
      streaming: true,
      text: "Hello",
    });
    expect(second.items).not.toContainEqual(
      expect.objectContaining({ id: "completed", streaming: true })
    );
    expect(toChatView(rows, new Map([["live-a", "Hello"]]), new Map())).toEqual(
      projector.project(new Map([["live-a", "Hello"]]))
    );
  });

  it("keeps live deltas hidden during the computer wake turn", () => {
    const rows = seq(
      consumed("wake", [{ kind: "text", text: "<wake_computer/>" }]),
      started("wake-turn")
    );
    const projector = createChatViewProjector(rows, new Map());
    const deltas = new Map([["wake-part", "private wake response"]]);

    expect(projector.project(deltas).items).toEqual([]);
    expect(toChatView(rows, deltas, new Map()).items).toEqual([]);
  });
});

describe("chat delivery presentation", () => {
  it("replaces provisional narration with the final reply after suggest_replies", () => {
    const text = "The video is ready to download.";
    const view = toChatView(
      seq(
        started("turn-9"),
        reply("run_53.1", text, "narration"),
        requested("suggest", "suggest_replies", { replies: ["Send it"] }),
        callSettled("suggest", "completed"),
        reply("run_54.0", text, "reply")
      ),
      new Map([["run_54.0", text]]),
      new Map()
    );

    expect(view.items).toEqual([
      { id: "run_54.0", kind: "bot", streaming: false, text },
    ]);
  });

  it("does not suppress equal text from another turn", () => {
    const text = "The video is ready to download.";
    const view = toChatView(
      seq(
        started("turn-9"),
        reply("run_9-n", text, "narration"),
        requested("suggest-9", "suggest_replies", { replies: ["Send it"] }),
        callSettled("suggest-9", "completed"),
        reply("run_9-r", text, "reply"),
        started("turn-10"),
        reply("run_10-n", text, "narration"),
        requested("suggest-10", "suggest_replies", { replies: ["Send it"] }),
        callSettled("suggest-10", "completed"),
        reply("run_10-r", text, "reply")
      ),
      new Map(),
      new Map()
    );

    expect(view.items.filter((item) => item.kind === "bot")).toEqual([
      { id: "run_9-r", kind: "bot", streaming: false, text },
      { id: "run_10-r", kind: "bot", streaming: false, text },
    ]);
  });

  it("keeps equal text when no suggestion call marks the narration as provisional", () => {
    const text = "The video is ready to download.";
    const view = toChatView(
      seq(
        started("turn-9"),
        reply("run_9-n", text, "narration"),
        reply("run_9-r", text, "reply")
      ),
      new Map(),
      new Map()
    );

    expect(view.items.filter((item) => item.kind === "bot")).toHaveLength(2);
  });

  it("keeps a different final reply in the same suggested turn", () => {
    const view = toChatView(
      seq(
        started("turn-9"),
        reply("run_9-n", "I found the video.", "narration"),
        requested("suggest-9", "suggest_replies", { replies: ["Send it"] }),
        callSettled("suggest-9", "completed"),
        reply("run_9-r", "The video is ready to download.", "reply")
      ),
      new Map(),
      new Map()
    );

    expect(view.items.filter((item) => item.kind === "bot")).toHaveLength(2);
  });

  it("removes the routine envelope and keeps the prompt, including marker-like text", () => {
    const prompt =
      "Read this literal: <routine_execution>\n</routine_execution>\nThen report it.";
    const text = [
      "<prior_history>\nMati: old message\n</prior_history>",
      "",
      "<routine_execution>",
      "Scheduled task: Morning report",
      "Scheduled for: 2026-11-03T12:00:00.000Z (America/Argentina/Cordoba, 09:00 local time).",
      "Execute the saved task below now, using your currently connected tools.",
      "</routine_execution>",
      "",
      prompt,
    ].join("\n");

    const [item] = toChatView([delivery(text)], new Map(), new Map()).items;
    expect(item).toEqual({
      files: [],
      id: "delivery-1",
      kind: "user",
      routineName: "Morning report",
      text: prompt,
    });
  });

  it("does not reinterpret an ordinary message", () => {
    const text = "Please explain <routine_execution> in this document.";
    const [item] = toChatView([delivery(text)], new Map(), new Map()).items;
    expect(item).toEqual({ files: [], id: "delivery-1", kind: "user", text });
  });

  it("does not drop a malformed envelope", () => {
    const text =
      "<routine_execution>\nScheduled task: Missing close\n\nDo this.";
    const [item] = toChatView([delivery(text)], new Map(), new Map()).items;
    expect(item).toEqual({ files: [], id: "delivery-1", kind: "user", text });
  });

  it("shows a safe error when the hidden wake turn fails", () => {
    const rows: ClientRow[] = [
      {
        data: {
          data: {
            deliveryId: "wake",
            parts: [{ kind: "text", text: "<wake_computer/>" }],
          },
          type: "delivery.consumed",
        },
        index: 0,
        line: 0,
        type: "delivery.consumed",
      },
      {
        data: { data: { turnId: "wake-turn" }, type: "turn.started" },
        index: 0,
        line: 1,
        type: "turn.started",
      },
      {
        data: {
          data: { error: { provider: "grok", status: 429 }, outcome: "failed" },
          type: "model.settled",
        },
        index: 0,
        line: 2,
        type: "model.settled",
      },
      {
        data: {
          data: { outcome: "failed", turnId: "wake-turn" },
          type: "turn.settled",
        },
        index: 0,
        line: 3,
        type: "turn.settled",
      },
    ];
    const view = toChatView(rows, new Map(), new Map());
    expect(view.items).toContainEqual(
      expect.objectContaining({
        kind: "error",
        text: expect.stringContaining("Grok"),
      })
    );
    expect(view.items.some((item) => item.kind === "user")).toBe(false);
  });

  it("keeps generic child task diagnostics without provider copy", () => {
    const rows: ClientRow[] = [
      {
        data: {
          data: { kind: "agent", name: "Research", taskId: "task-1" },
          type: "task.started",
        },
        index: 0,
        line: 0,
        type: "task.started",
      },
      {
        data: {
          data: {
            error: { message: "Command exited with code 1" },
            outcome: "failed",
            taskId: "task-1",
          },
          type: "task.ended",
        },
        index: 0,
        line: 1,
        type: "task.ended",
      },
    ];
    const activity = toChatView(rows, new Map(), new Map()).items.find(
      (item) => item.kind === "activity"
    );
    expect(activity).toMatchObject({
      detail: "Command exited with code 1",
      state: "error",
    });
  });
});

describe("flow warm-up cancel", () => {
  // The warm route's `cancel { turnId: null }`: eve admits it and settles it `ignored`, no turn.
  const row = (type: string, data: object, line: number): ClientRow => ({
    data: { data: { deliveryId: "warm-cancel", ...data }, type },
    index: 0,
    line,
    type,
  });
  const rows = [
    row("delivery.admitted", { source: { channel: "channel:eve" } }, 0),
    row("delivery.settled", { outcome: "ignored" }, 1),
  ];

  it("shows nothing and leaves the bot idle", () => {
    const view = toChatView(rows, new Map(), new Map());
    expect(view.items).toEqual([]);
    expect(view.working).toBe(false);
    expect(view.turnId).toBeNull();
  });

  it("doesn't move a pending message's wait stage or mark the bot working", () => {
    expect(isWorking(rows)).toBe(false);
    expect(waitStage(rows, [], false)).toBeNull();
    expect(
      waitStage(rows, [{ deliveryId: "message-1", id: "local-1" }], false)
    ).toEqual({ id: "local-1", stage: "received" });
  });
});
