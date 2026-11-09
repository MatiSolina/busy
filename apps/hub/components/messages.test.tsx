// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { type ComponentProps, type ReactNode, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aiIssue } from "@/lib/ai/errors";
import type { Pending } from "@/lib/chat/client-store";
import { ChatScrollContext, MessageList } from "./messages";
import { disableHappyDomWebAnimations } from "./motion-test-helpers";

disableHappyDomWebAnimations();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ROUTINE_EXECUTION = /routine_execution/u;

// The chat pane always mounts the list inside its scroller.
const messageTree = (props: ComponentProps<typeof MessageList>) => (
  <div data-chat-scroll="">
    <MessageList {...props} />
  </div>
);

function renderMessageList(props: ComponentProps<typeof MessageList>) {
  return render(messageTree(props));
}

/** The chat pane's own scroller: inside it the list is virtualized. */
function ChatScroller({ children }: { children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  return (
    <div data-chat-scroll="" ref={scroller}>
      <ChatScrollContext value={scroller}>{children}</ChatScrollContext>
    </div>
  );
}

const conversation = (length: number, from = 0) =>
  Array.from({ length }, (_, index) => ({
    files: [],
    id: `message-${from + index}`,
    kind: "user" as const,
    text: `Conversation message ${from + index}`,
  }));

describe("long conversation rendering", () => {
  it("asks for the earlier page ahead of the top, once per page", () => {
    const onLoadEarlier = vi.fn();
    const props = {
      hasEarlier: true,
      items: conversation(3),
      onLoadEarlier,
      pending: [],
      slug: "assistant",
    };
    const view = render(
      <ChatScroller>
        <MessageList {...props} />
      </ChatScroller>
    );
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    view.rerender(
      <ChatScroller>
        <MessageList {...props} earlierLoading />
      </ChatScroller>
    );
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    // The page landed and the reader is still near the top: the next one goes out.
    view.rerender(
      <ChatScroller>
        <MessageList
          {...props}
          items={[...conversation(2, 100), ...props.items]}
        />
      </ChatScroller>
    );
    expect(onLoadEarlier).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps the newest message mounted while earlier pages land above it", () => {
    const view = render(
      <ChatScroller>
        <MessageList
          items={conversation(5, 50)}
          pending={[]}
          slug="assistant"
        />
      </ChatScroller>
    );
    const latest = screen.getByText("Conversation message 54");
    view.rerender(
      <ChatScroller>
        <MessageList
          items={[...conversation(50), ...conversation(5, 50)]}
          pending={[]}
          slug="assistant"
        />
      </ChatScroller>
    );
    expect(screen.getByText("Conversation message 54")).toBe(latest);
  });

  it("renders a list outside the chat scroller whole", () => {
    renderMessageList({
      items: conversation(100),
      pending: [],
      slug: "assistant",
    });
    expect(screen.getByText("Conversation message 0")).toBeTruthy();
    expect(screen.getByText("Conversation message 99")).toBeTruthy();
  });
});

describe("routine message presentation", () => {
  it("shows a short routine label and only the clean prompt", () => {
    renderMessageList({
      items: [
        {
          files: [],
          id: "delivery-1",
          kind: "user",
          routineName: "Morning report",
          text: "Review the inbox.",
        },
      ],
      pending: [],
      slug: "assistant",
    });

    expect(screen.getByText("Routine · Morning report")).toBeTruthy();
    expect(screen.getByText("Review the inbox.")).toBeTruthy();
    expect(screen.queryByText(ROUTINE_EXECUTION)).toBeNull();
  });
});

describe("failed message presentation", () => {
  it("preserves the draft and files and retries the original delivery", () => {
    const retry = vi.fn();
    renderMessageList({
      items: [],
      onRetryPending: retry,
      pending: [
        {
          failed: true,
          files: ["contract.pdf"],
          id: "original-message",
          issue: aiIssue("message_delivery_failed"),
          text: "Review this.",
        },
      ],
      slug: "assistant",
    });
    expect(screen.getByText("Review this.")).toBeTruthy();
    expect(screen.getByText("contract.pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry message" }));
    expect(retry).toHaveBeenCalledWith("original-message");
  });

  it("shows the provider recovery action for a failed model turn", () => {
    const issue = aiIssue("provider_quota_exceeded", "grok");
    renderMessageList({
      items: [
        { id: "turn-failure", issue, kind: "error", text: issue.message },
      ],
      pending: [],
      slug: "assistant",
    });
    expect(screen.getByRole("alert").textContent).toContain("Grok");
    expect(
      screen.getByRole("link", { name: "Check usage" }).getAttribute("href")
    ).toBe("https://grok.com/dashboard");
  });
});

describe("wait stages before the reply", () => {
  const acked: Pending[] = [
    { deliveryId: "d-1", files: [], id: "local-1", text: "Hi" },
  ];

  it("says what the bot is about to do instead of a stage", () => {
    renderMessageList({
      botName: "Alpha",
      items: [],
      pending: [...acked],
      slug: "alpha",
      status: "Finding leads for Acme",
      wait: { id: "local-1", stage: "received" },
    });
    expect(screen.getByRole("status").textContent).toBe(
      "Finding leads for Acme…"
    );
  });

  it("doesn't call the hub's own fast reply a wake-up", () => {
    vi.useFakeTimers();
    try {
      renderMessageList({
        botName: "Alpha",
        items: [],
        pending: [{ files: [], id: "local-1", text: "Hi" }],
        slug: "alpha",
        wait: { id: "local-1", stage: "sending" },
      });
      act(() => vi.advanceTimersByTime(5000));
      expect(screen.getByRole("status").textContent).toBe("Thinking…");
    } finally {
      vi.useRealTimers();
    }
  });

  it("wakes the bot after a second without admission, never once admitted", () => {
    vi.useFakeTimers();
    try {
      const view = renderMessageList({
        botName: "Alpha",
        items: [],
        pending: [...acked],
        slug: "alpha",
        wait: { id: "local-1", stage: "received" },
      });
      expect(screen.getByRole("status").textContent).toBe("Thinking…");
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.getByRole("status").textContent).toBe("Waking up Alpha…");

      view.rerender(
        messageTree({
          botName: "Alpha",
          items: [],
          pending: [...acked],
          slug: "alpha",
          wait: { id: "local-1", stage: "admitted" },
        })
      );
      expect(screen.getByRole("status").textContent).toBe("Thinking…");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says Thinking in a turn and leaves when the reply streams", () => {
    const view = renderMessageList({
      items: [],
      pending: [],
      slug: "alpha",
      wait: { id: "turn", stage: "thinking" },
      working: true,
    });
    expect(screen.getByRole("status").textContent).toBe("Thinking…");
    view.rerender(
      messageTree({
        items: [
          { id: "reply", kind: "bot", streaming: true, text: "Hel" },
        ] as ComponentProps<typeof MessageList>["items"],
        pending: [],
        slug: "alpha",
        wait: { id: "turn", stage: "thinking" },
        working: true,
      })
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps saying Thinking under a fast-path ack while the bot works", () => {
    renderMessageList({
      items: [
        { files: [], id: "d-1", kind: "user", text: "buscá vuelos" },
        { id: "ack", kind: "bot", streaming: false, text: "Busco vuelos." },
      ] as ComponentProps<typeof MessageList>["items"],
      pending: [],
      slug: "alpha",
      wait: { id: "turn", stage: "thinking" },
      working: true,
    });
    expect(screen.getByText("Busco vuelos.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Thinking…");
  });
});

describe("message entrance motion", () => {
  it("shows Working for an acknowledged message before its turn starts", () => {
    renderMessageList({
      items: [],
      pending: [
        {
          deliveryId: "delivery-1",
          files: [],
          id: "local-1",
          text: "Start this turn.",
        },
      ],
      slug: "assistant",
    });

    expect(screen.getByRole("status").textContent).toBe("Working…");
  });

  it("keeps already-rendered history at rest on the first render", () => {
    renderMessageList({
      items: [
        {
          id: "reply-1",
          kind: "bot",
          streaming: false,
          text: "Previous reply.",
        },
      ],
      pending: [],
      slug: "assistant",
    });

    const history = screen.getByText("Previous reply.").closest("li");
    expect(history).not.toBeNull();
    expect(history?.style.opacity).not.toBe("0");
    expect(history?.style.transform).not.toContain("translateY(6px)");
  });

  it("does not remount a streaming reply when its text grows", () => {
    const view = renderMessageList({
      items: [{ id: "stream-1", kind: "bot", streaming: true, text: "Hel" }],
      pending: [],
      slug: "assistant",
      working: true,
    });
    const before = screen.getByText("Hel").closest("li");

    view.rerender(
      messageTree({
        items: [
          { id: "stream-1", kind: "bot", streaming: true, text: "Hello there" },
        ],
        pending: [],
        slug: "assistant",
        working: true,
      })
    );

    expect(screen.getByText("Hello there").closest("li")).toBe(before);
  });

  it("keeps one DOM node when a pending delivery becomes persisted", () => {
    const view = renderMessageList({
      items: [],
      pending: [{ files: [], id: "local-1", text: "Send this." }],
      slug: "assistant",
    });
    const pending = screen.getByText("Send this.").closest("li");

    view.rerender(
      messageTree({
        items: [],
        pending: [
          {
            deliveryId: "delivery-1",
            files: [],
            id: "local-1",
            text: "Send this.",
          },
        ],
        slug: "assistant",
      })
    );

    view.rerender(
      messageTree({
        items: [
          { files: [], id: "delivery-1", kind: "user", text: "Send this." },
        ],
        pending: [],
        slug: "assistant",
      })
    );

    expect(screen.getByText("Send this.").closest("li")).toBe(pending);
  });
});
