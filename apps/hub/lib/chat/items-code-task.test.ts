import { describe, expect, it } from "vitest";
import { type ClientRow, toChatView } from "./items";

const consults = new Map<string, { id: string; peerName: string }>();
const TASK_ID = "11111111-1111-5111-8111-111111111111";

function facts(...entries: [string, Record<string, unknown>][]): ClientRow[] {
  return entries.map(([type, data], line) => ({
    data: { data, type },
    index: 0,
    line,
    type,
  }));
}

function delivery(text: string): ClientRow {
  return {
    data: {
      data: { deliveryId: "delivery-1", parts: [{ kind: "text", text }] },
      type: "delivery.consumed",
    },
    index: 0,
    line: 1,
    type: "delivery.consumed",
  };
}

describe("code task result envelope", () => {
  it("does not display the service envelope as a user message", () => {
    const view = toChatView(
      [
        delivery(
          "<code_task_result>\nTask: task-1\n</code_task_result>\nPlease summarize it."
        ),
        {
          data: { data: { turnId: "turn-1" }, type: "turn.started" },
          index: 0,
          line: 2,
          type: "turn.started",
        },
      ],
      new Map(),
      consults
    );
    expect(view.items.filter((item) => item.kind === "user")).toHaveLength(0);
  });

  it("keeps ordinary user text visible", () => {
    const view = toChatView(
      [delivery("Please fix the login form.")],
      new Map(),
      consults
    );
    expect(view.items).toEqual([
      {
        files: [],
        id: "delivery-1",
        kind: "user",
        text: "Please fix the login form.",
      },
    ]);
  });
});

describe("conversational code work", () => {
  it("places one real task card between the tool result and the reply", () => {
    const rows = facts(
      [
        "call.requested",
        { callId: "start-1", capability: { name: "start_code_task" } },
      ],
      [
        "call.settled",
        {
          callId: "start-1",
          outcome: "completed",
          output: { taskId: TASK_ID },
        },
      ],
      [
        "content.completed",
        {
          kind: "text",
          partId: "reply",
          phase: "reply",
          value: "I started the change.",
        },
      ],
      [
        "call.requested",
        { callId: "retry-1", capability: { name: "start_code_task" } },
      ],
      [
        "call.settled",
        {
          callId: "retry-1",
          outcome: "completed",
          output: { taskId: TASK_ID },
        },
      ]
    );
    const { items } = toChatView(rows, new Map(), consults);
    expect(items.map((item) => item.kind)).toEqual([
      "activity",
      "code-task",
      "bot",
      "activity",
    ]);
    expect(items.filter((item) => item.kind === "code-task")).toEqual([
      { id: `code-task:${TASK_ID}`, kind: "code-task", taskId: TASK_ID },
    ]);
  });

  it.each([
    ["prepare_code_repository", "completed", { taskId: TASK_ID }],
    ["start_code_task", "failed", { taskId: TASK_ID }],
    ["start_code_task", "cancelled", { taskId: TASK_ID }],
    [
      "start_code_task",
      "completed",
      { error: "Repository not connected", taskId: TASK_ID },
    ],
    ["start_code_task", "completed", { taskId: "https://example.com" }],
  ])("does not show unaccepted work for %s / %s", (name, outcome, output) => {
    const rows = facts(
      ["call.requested", { callId: "call", capability: { name } }],
      ["call.settled", { callId: "call", outcome, output }]
    );
    expect(
      toChatView(rows, new Map(), consults).items.some(
        (item) => item.kind === "code-task"
      )
    ).toBe(false);
  });

  it("marks only the repository tool's own question as GitHub setup", () => {
    const rows = facts(
      [
        "call.requested",
        { callId: "setup", capability: { name: "prepare_code_repository" } },
      ],
      [
        "interaction.opened",
        {
          interactionId: "setup-question",
          request: { kind: "question", prompt: "Connect GitHub" },
          subject: { callId: "setup" },
        },
      ],
      [
        "call.requested",
        { callId: "ordinary", capability: { name: "ask_question" } },
      ],
      [
        "interaction.opened",
        {
          interactionId: "ordinary-question",
          request: { kind: "question", prompt: "Connect GitHub" },
          subject: { callId: "ordinary" },
        },
      ]
    );
    const questions = toChatView(rows, new Map(), consults).items.filter(
      (item) => item.kind === "interaction"
    );
    expect(questions[0]).toMatchObject({ setup: "code-repository" });
    expect(questions[1]).not.toHaveProperty("setup");
  });
});
