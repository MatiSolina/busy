// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageList } from "@/components/messages";
import { type ChatItem, toChatView } from "@/lib/chat/items";

const answer = vi.hoisted(() =>
  vi.fn<
    (
      slug: string,
      interactionId: string,
      value: { optionId?: string; text?: string }
    ) => Promise<boolean>
  >()
);
const send = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("@/components/chat-app", () => ({
  useChat: () => null,
  useStore: () => ({ answer, send }),
}));

const rows = (...facts: [string, Record<string, unknown>][]) =>
  facts.map(([type, data], line) => ({
    data: { data, type },
    index: 0,
    line,
    type,
  }));

beforeEach(() => {
  answer.mockReset();
  answer.mockResolvedValue(true);
  send.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("durable conversation UI", () => {
  it("shows that GitHub setup is waiting for input instead of working", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(Response.json({ connections: [], repositories: [] }))
      )
    );
    const view = toChatView(
      rows(
        ["turn.started", { turnId: "turn-1" }],
        [
          "call.requested",
          {
            callId: "setup-call",
            capability: { name: "prepare_code_repository" },
          },
        ],
        [
          "interaction.opened",
          {
            interactionId: "github-setup",
            request: {
              kind: "question",
              prompt: "Connect GitHub and choose a repository.",
            },
            subject: { callId: "setup-call" },
          },
        ]
      ),
      new Map(),
      new Map()
    );
    render(
      <MessageList
        items={view.items}
        pending={[]}
        slug="sales"
        working={view.working}
      />
    );

    await screen.findByRole("button", { name: "Connect GitHub" });
    expect(screen.queryByText("Working…")).toBeNull();
    expect(screen.getByText("Waiting for you…")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Set up GitHub" })
        .querySelector(".animate-spin")
    ).toBeNull();
    expect(view.working).toBe(true);
  });

  it("names the active background task when earlier work already finished", () => {
    const items: ChatItem[] = [
      {
        id: "first",
        kind: "activity",
        state: "done",
        taskId: "first",
        taskKind: "agent",
        tool: "First report",
      },
      {
        id: "second",
        kind: "activity",
        state: "running",
        taskId: "second",
        taskKind: "agent",
        tool: "Second report",
      },
    ];
    render(<MessageList items={items} pending={[]} slug="sales" working />);
    expect(
      screen.getByRole("button", { name: "Agent: Second report" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Agent: First report" })
    ).toBeNull();
  });

  it("keeps another background task running while a child waits for an answer", () => {
    const view = toChatView(
      rows(
        ["turn.started", { turnId: "turn-1" }],
        [
          "task.started",
          { kind: "agent", name: "Blocked work", taskId: "blocked" },
        ],
        [
          "task.started",
          { kind: "agent", name: "Independent work", taskId: "independent" },
        ],
        [
          "interaction.opened",
          {
            interactionId: "child-question",
            request: {
              kind: "question",
              options: [{ id: "work", label: "Work" }],
              prompt: "Which account?",
            },
            subject: { taskId: "blocked" },
          },
        ]
      ),
      new Map(),
      new Map()
    );
    render(
      <MessageList
        items={view.items}
        pending={[]}
        slug="sales"
        working={view.working}
      />
    );

    expect(screen.getByText("Waiting for you…")).toBeTruthy();
    expect(screen.queryByText("Working…")).toBeNull();
    const activeTask = screen.getByRole("button", {
      name: "Agent: Independent work",
    });
    expect(activeTask.querySelector(".animate-spin")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(answer).toHaveBeenCalledWith("sales", "child-question", {
      optionId: "work",
    });
  });

  it("resumes the working indicator once a response is submitted", () => {
    const events: [string, Record<string, unknown>][] = [
      ["turn.started", { turnId: "turn-1" }],
      [
        "interaction.opened",
        {
          interactionId: "question",
          request: {
            kind: "question",
            options: [{ id: "work", label: "Work" }],
            prompt: "Which account?",
          },
          subject: { turnId: "turn-1" },
        },
      ],
    ];
    const current = toChatView(rows(...events), new Map(), new Map());
    const rendered = render(
      <MessageList
        items={current.items}
        pending={[]}
        slug="sales"
        working={current.working}
      />
    );
    expect(screen.getByText("Waiting for you…")).toBeTruthy();

    const submitted = toChatView(
      rows(...events, [
        "response.submitted",
        { interactionId: "question", responseId: "response" },
      ]),
      new Map(),
      new Map()
    );
    rendered.rerender(
      <MessageList
        items={submitted.items}
        pending={[]}
        slug="sales"
        working={submitted.working}
      />
    );
    expect(screen.queryByText("Waiting for you…")).toBeNull();
    expect(screen.getByText("Working…")).toBeTruthy();

    const refused = toChatView(
      rows(
        ...events,
        [
          "response.submitted",
          { interactionId: "question", responseId: "response" },
        ],
        ["response.settled", { outcome: "refused", responseId: "response" }]
      ),
      new Map(),
      new Map()
    );
    rendered.rerender(
      <MessageList
        items={refused.items}
        pending={[]}
        slug="sales"
        working={refused.working}
      />
    );
    expect(screen.getByText("Waiting for you…")).toBeTruthy();
    expect(screen.queryByText("Working…")).toBeNull();
  });

  it("shows a child question and approval with actionable controls", () => {
    // biome-ignore lint/style/useDestructuring: toChatView returns the array consumed directly by MessageList.
    const items = toChatView(
      rows(
        ["turn.started", { turnId: "turn-1" }],
        [
          "task.started",
          { kind: "agent", name: "Prepare the quote", taskId: "task-1" },
        ],
        [
          "interaction.opened",
          {
            interactionId: "question-1",
            request: {
              kind: "question",
              options: [{ id: "xlsx", label: "Excel" }],
              prompt: "Which format should I use?",
            },
            subject: { taskId: "task-1" },
          },
        ],
        [
          "interaction.opened",
          {
            interactionId: "approval-1",
            request: {
              kind: "approval",
              options: [
                { id: "approve", label: "Send", style: "primary" },
                { id: "deny", label: "No", style: "danger" },
              ],
              prompt: "Send the quote?",
            },
            subject: { taskId: "task-1" },
          },
        ]
      ),
      new Map(),
      new Map()
    ).items;
    render(<MessageList items={items} pending={[]} slug="sales" working />);

    expect(screen.getByText("Which format should I use?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Excel" })).toBeTruthy();
    expect(screen.getByText("Send the quote?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(answer).toHaveBeenCalledWith("sales", "approval-1", {
      optionId: "approve",
    });
  });

  it("shows delegated work while the root reply is complete", () => {
    // biome-ignore lint/style/useDestructuring: toChatView returns the array consumed directly by MessageList.
    const items = toChatView(
      rows(
        ["turn.started", { turnId: "turn-1" }],
        [
          "task.started",
          { kind: "agent", name: "Prepare the quote", taskId: "task-1" },
        ],
        [
          "content.completed",
          {
            kind: "text",
            partId: "reply-1",
            phase: "reply",
            value: "I am checking the figures while you can keep talking.",
          },
        ],
        ["turn.settled", { outcome: "completed", turnId: "turn-1" }]
      ),
      new Map(),
      new Map()
    ).items;
    render(
      <MessageList items={items} pending={[]} slug="sales" working={false} />
    );

    expect(screen.getByText("Agent: Prepare the quote")).toBeTruthy();
    expect(
      screen.getByText("I am checking the figures while you can keep talking.")
    ).toBeTruthy();
  });

  it("keeps replaced-session work and prompts non-actionable", () => {
    const items: ChatItem[] = [
      {
        detail: "Session replaced",
        id: "task-old",
        kind: "activity",
        state: "stopped",
        taskId: "task-old",
        taskKind: "agent",
        tool: "Old work",
      },
      {
        allowFreeform: false,
        id: "question-old",
        interactionId: "question-old",
        kind: "interaction",
        options: [{ id: "yes", label: "Yes" }],
        outcome: "Session replaced",
        prompt: "Old question",
        state: "withdrawn",
        type: "question",
      },
    ];
    render(
      <MessageList items={items} pending={[]} slug="sales" working={false} />
    );

    expect(screen.getByText("Agent: Old work stopped")).toBeTruthy();
    expect(screen.getByText("Old question")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
  });
});
