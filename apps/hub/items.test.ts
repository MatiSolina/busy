import { describe, expect, it } from "vitest";
import {
  callSettled,
  requested,
  row,
  seq,
  settled,
  view,
} from "@/lib/chat/chat.test-helpers";

describe("eve task and interaction projections", () => {
  it("renders one stable activity for a resumable task and its repeated calls", () => {
    const rows = [
      row(0, "turn.started", { turnId: "turn-1" }),
      row(1, "task.started", {
        kind: "agent",
        name: "file worker",
        startedBy: { callId: "call-1" },
        taskId: "task-1",
      }),
      row(2, "call.started", { callId: "call-1", taskId: "task-1" }),
      row(3, "call.settled", { callId: "call-1", outcome: "completed" }),
      row(4, "call.started", { callId: "call-2", taskId: "task-1" }),
      row(5, "call.settled", { callId: "call-2", outcome: "completed" }),
    ];
    const tasks = view(rows).items.filter(
      (item) => item.kind === "activity" && item.taskId
    );
    expect(tasks).toEqual([
      {
        id: "task-1",
        kind: "activity",
        state: "done",
        taskId: "task-1",
        taskKind: "agent",
        tool: "file worker",
      },
    ]);
  });

  it("keeps the brief of a child task next to its label", () => {
    const rows = [
      row(0, "turn.started", { turnId: "turn-1" }),
      row(1, "call.requested", {
        callId: "call-1",
        capability: { kind: "agent", label: "Review the repo.", name: "agent" },
        input: { message: "Review the repo. Return a summary." },
      }),
      row(2, "task.started", {
        kind: "agent",
        name: "agent",
        startedBy: { callId: "call-1" },
        taskId: "task-1",
      }),
    ];
    expect(view(rows).items.filter((item) => item.kind === "activity")).toEqual(
      [
        {
          detail: "Review the repo.",
          id: "task-1",
          kind: "activity",
          state: "running",
          taskId: "task-1",
          taskKind: "agent",
          tool: "agent",
        },
      ]
    );
  });

  it.each([
    ["failed", "error", "worker failed"],
    ["cancelled", "stopped", "worker cancelled"],
  ] as const)(
    "lets task.ended replace an earlier completed call for a %s task",
    (outcome, state, reason) => {
      const rows = [
        row(0, "task.started", {
          kind: "agent",
          name: "file worker",
          startedBy: { callId: "call-1" },
          taskId: "task-1",
        }),
        row(1, "call.started", { callId: "call-1", taskId: "task-1" }),
        row(2, "call.settled", { callId: "call-1", outcome: "completed" }),
        row(3, "task.ended", {
          outcome,
          reason,
          taskId: "task-1",
        }),
        // A replayed/late call must not overwrite the authoritative terminal task.
        row(4, "call.started", { callId: "call-2", taskId: "task-1" }),
        row(5, "call.settled", { callId: "call-2", outcome: "completed" }),
      ];

      expect(view(rows).items).toContainEqual(
        expect.objectContaining({
          detail: reason,
          error: reason,
          kind: "activity",
          state,
          taskId: "task-1",
        })
      );
    }
  );

  it("handles call.requested before call.started and waits for all active calls", () => {
    const first = row(1, "call.requested", {
      callId: "call-1",
      capability: { name: "file worker" },
    });
    first.data.scope = { taskId: "task-1" };
    const second = row(3, "call.requested", {
      callId: "call-2",
      capability: { name: "file worker" },
    });
    second.data.scope = { taskId: "task-1" };
    const rows = [
      row(0, "task.started", {
        kind: "agent",
        name: "file worker",
        startedBy: { callId: "call-1" },
        taskId: "task-1",
      }),
      first,
      row(2, "call.started", { callId: "call-1", taskId: "task-1" }),
      second,
      row(4, "call.started", { callId: "call-2", taskId: "task-1" }),
      row(5, "call.settled", { callId: "call-1", outcome: "completed" }),
      row(6, "call.settled", { callId: "call-2", outcome: "completed" }),
    ];
    expect(
      view(rows).items.filter((item) => item.kind === "activity" && item.taskId)
    ).toEqual([
      {
        id: "task-1",
        kind: "activity",
        state: "done",
        taskId: "task-1",
        taskKind: "agent",
        tool: "file worker",
      },
    ]);
  });

  it("does not turn a peer task into a second consultation card", () => {
    const rows = [
      row(0, "call.requested", {
        callId: "peer-call",
        capability: { name: "peer-1" },
      }),
      row(1, "task.started", {
        kind: "agent",
        name: "peer-1",
        startedBy: { callId: "peer-call" },
        taskId: "peer-task",
      }),
      row(2, "call.settled", { callId: "peer-call", outcome: "completed" }),
    ];
    const { items } = view(rows, {
      slot: (slot) => (slot === 1 ? "Lawyer" : undefined),
    });
    expect(items.filter((item) => item.kind === "consult")).toHaveLength(2);
    expect(
      items.filter(
        (item) => item.kind === "consult" && item.direction === "from"
      )
    ).toHaveLength(1);
    expect(
      items.filter((item) => item.kind === "activity" && item.taskId)
    ).toHaveLength(0);
  });

  it("finds an agent continuation taskId in call input when scope has none", () => {
    const request = row(1, "call.requested", {
      callId: "call-1",
      capability: { kind: "agent", name: "researcher" },
      input: { message: "continue", taskId: "task-1" },
    });
    const rows = [
      row(0, "task.started", {
        kind: "agent",
        name: "researcher",
        startedBy: { callId: "call-0" },
        taskId: "task-1",
      }),
      request,
      row(2, "call.started", { callId: "call-1", taskId: "task-1" }),
      row(3, "call.settled", { callId: "call-1", outcome: "completed" }),
    ];
    expect(
      view(rows).items.filter((item) => item.kind === "activity" && item.taskId)
    ).toEqual([
      {
        id: "task-1",
        kind: "activity",
        state: "done",
        taskId: "task-1",
        taskKind: "agent",
        tool: "researcher",
      },
    ]);
  });

  it("maps a cancelled call to stopped without reporting an error", () => {
    const rows = [
      row(0, "task.started", {
        kind: "agent",
        name: "file worker",
        startedBy: { callId: "call-1" },
        taskId: "task-1",
      }),
      row(1, "call.started", { callId: "call-1", taskId: "task-1" }),
      row(2, "call.settled", {
        callId: "call-1",
        outcome: "interrupted",
        reason: "task-cancel",
      }),
    ];
    expect(view(rows).items).toContainEqual(
      expect.objectContaining({
        kind: "activity",
        state: "stopped",
        taskId: "task-1",
      })
    );
    expect(view(rows).items).not.toContainEqual(
      expect.objectContaining({ kind: "error" })
    );
  });

  it("renders choices, free text, approvals, and relayed child origins", () => {
    const rows = seq(
      [
        "interaction.opened",
        {
          interactionId: "q-1",
          request: {
            display: "select",
            kind: "question",
            options: [{ id: "xlsx", label: "Excel" }],
            prompt: "Which format?",
            title: "Format",
          },
          subject: { turnId: "turn-1" },
        },
      ],
      [
        "interaction.opened",
        {
          interactionId: "a-1",
          request: {
            display: "confirmation",
            kind: "approval",
            options: [
              { id: "approve", label: "Send", style: "primary" },
              { id: "deny", label: "No", style: "danger" },
            ],
            prompt: "Send it?",
          },
          subject: { callId: "call-1" },
        },
      ],
      [
        "interaction.opened",
        {
          interactionId: "child-1",
          origin: {
            call: { callId: "child-call", name: "publish" },
            interactionId: "child-origin",
            sessionId: "child-session",
          },
          request: {
            allowFreeform: true,
            display: "text",
            kind: "question",
            prompt: "Need a source",
          },
          subject: { taskId: "task-1" },
        },
      ]
    );
    const interactions = view(rows).items.filter(
      (item) => item.kind === "interaction"
    );
    expect(interactions).toHaveLength(3);
    expect(interactions[0]).toMatchObject({
      interactionId: "q-1",
      options: [{ id: "xlsx", label: "Excel", style: "secondary" }],
      state: "open",
      type: "question",
    });
    expect(interactions[1]).toMatchObject({
      interactionId: "a-1",
      state: "open",
      type: "approval",
    });
    expect(
      interactions[1]?.kind === "interaction" && interactions[1].options?.[0]
    ).toMatchObject({ id: "approve", style: "primary" });
    expect(interactions[2]).toMatchObject({
      interactionId: "child-1",
      origin: { callId: "child-call", sessionId: "child-session" },
    });
  });

  it("settles the native interaction and leaves the prompt non-actionable", () => {
    const rows = seq(
      [
        "interaction.opened",
        {
          interactionId: "q-1",
          request: {
            kind: "question",
            options: [{ id: "one", label: "One" }],
            prompt: "Which?",
          },
          subject: { turnId: "turn-1" },
        },
      ],
      [
        "response.submitted",
        {
          interactionId: "q-1",
          responseId: "response-1",
          value: { optionId: "one" },
        },
      ],
      [
        "interaction.settled",
        {
          interactionId: "q-1",
          outcome: "accepted",
          response: { optionId: "one" },
        },
      ]
    );
    expect(view(rows).items).toContainEqual(
      expect.objectContaining({
        interactionId: "q-1",
        kind: "interaction",
        outcome: "one",
        state: "accepted",
      })
    );
    expect(
      view(rows).items.filter(
        (item) => item.kind === "interaction" && item.state === "open"
      )
    ).toHaveLength(0);
  });

  it("keeps an interaction pending between response submission and its terminal eve fact", () => {
    const rows = seq(
      [
        "interaction.opened",
        {
          interactionId: "q-1",
          request: {
            kind: "question",
            options: [{ id: "one", label: "One" }],
            prompt: "Which?",
          },
          subject: { turnId: "turn-1" },
        },
      ],
      [
        "response.submitted",
        {
          deliveryId: "delivery-1",
          interactionId: "q-1",
          responseId: "response-1",
          value: { optionId: "one" },
        },
      ],
      ["response.admitted", { responseId: "response-1" }],
      ["response.settled", { outcome: "applied", responseId: "response-1" }]
    );
    expect(view(rows).items).toContainEqual(
      expect.objectContaining({
        interactionId: "q-1",
        kind: "interaction",
        pending: true,
        state: "open",
      })
    );
    const settledRows = [
      ...rows,
      row(4, "interaction.settled", {
        interactionId: "q-1",
        outcome: "accepted",
      }),
    ];
    expect(view(settledRows).items).toContainEqual(
      expect.objectContaining({
        interactionId: "q-1",
        pending: false,
        state: "accepted",
      })
    );
  });

  it("keeps only safe HTTP interaction links", () => {
    const rows = seq(
      [
        "interaction.opened",
        {
          interactionId: "safe",
          request: {
            kind: "question",
            link: { label: "Open", url: "https://example.com/path" },
            prompt: "Open",
          },
          subject: { turnId: "turn-1" },
        },
      ],
      [
        "interaction.opened",
        {
          interactionId: "unsafe",
          request: {
            kind: "question",
            link: { url: "javascript:alert(1)" },
            prompt: "No",
          },
          subject: { turnId: "turn-1" },
        },
      ]
    );
    expect(view(rows).items).toContainEqual(
      expect.objectContaining({
        interactionId: "safe",
        link: { label: "Open", url: "https://example.com/path" },
      })
    );
    const unsafe = view(rows).items.find(
      (item) => item.kind === "interaction" && item.interactionId === "unsafe"
    );
    expect(unsafe?.kind === "interaction" && unsafe.link).toBeUndefined();
  });

  it("keeps the existing login projection while general interactions are separate", () => {
    const rows = seq(
      requested("login-call", "request_login"),
      [
        "interaction.opened",
        {
          interactionId: "login-1",
          request: { kind: "question", prompt: "Please sign in" },
          subject: { callId: "login-call" },
        },
      ],
      [
        "interaction.settled",
        { interactionId: "login-1", outcome: "accepted" },
      ],
      callSettled("login-call", "completed"),
      settled("turn-1")
    );
    expect(view(rows).items).toContainEqual({
      id: "login-call",
      interactionId: "login-1",
      kind: "login",
      state: "done",
      text: "Please sign in",
    });
  });

  it("projects request_form as a login card with its fields, dropping malformed ones", () => {
    const fields = [
      { id: "user", kind: "email", label: "Email", target: "@e3" },
      { id: "pass", kind: "password", label: "Password", target: "#pw" },
    ];
    const rows = seq(
      requested("form-call", "request_form", {
        fields: [
          ...fields,
          { id: "x", kind: "ssn", label: "X", target: "@e9" },
        ],
        site: "the bank",
        task: "pay",
      }),
      [
        "interaction.opened",
        {
          interactionId: "form-1",
          request: { kind: "question", prompt: "Fill this in" },
          subject: { callId: "form-call" },
        },
      ]
    );
    const card = view(rows).items.find((i) => i.kind === "login");
    expect(card).toEqual({
      form: { fields },
      id: "form-call",
      interactionId: "form-1",
      kind: "login",
      state: "open",
      text: "Fill this in",
    });
  });
});
