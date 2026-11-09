// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Activity, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatApp } from "@/components/chat-app";
import {
  emitFacts,
  held,
  initialBot,
  installFakes,
  json,
  pane,
  renderApp,
  reply,
  type Server,
  type Streams,
  said,
  seq,
  seqFrom,
  settle,
  settled,
  started,
} from "@/components/components.test-helpers";
import { closeMarkdownWorker } from "@/lib/chat/markdown-client";

vi.mock("@/components/live-view", () => ({ LiveView: () => null }));
vi.mock("virtua", () => import("@/components/virtua-test-double"));

let server: Server;
let streams: Streams;

beforeEach(() => {
  ({ server, streams } = installFakes());
  server.on(
    "GET",
    "/api/account",
    json({
      account: { avatarUrl: null, name: "Matias Solina" },
      tokenPass: {
        dashboardUrl: "https://vercel.com",
        percentUsed: 12.5,
        status: "active",
      },
    })
  );
});

afterEach(() => {
  cleanup();
  closeMarkdownWorker();
  vi.unstubAllGlobals();
});

const bots = () => [
  initialBot("alpha", { name: "Alpha" }),
  initialBot("beta", { name: "Beta" }),
];

function select(name: "Alpha" | "Beta") {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("chat pane motion continuity", () => {
  it("reuses the document's Markdown worker when the chat route is hidden and restored", async () => {
    const created = vi.fn();
    const terminated = vi.fn();
    vi.stubGlobal(
      "Worker",
      class extends EventTarget {
        constructor() {
          super();
          created();
        }
        readonly postMessage = vi.fn();
        readonly terminate = terminated;
      }
    );
    const initial = [initialBot("alpha", { name: "Alpha" })];
    const content = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <ChatApp initial={initial} />
      </Activity>
    );
    const view = render(content("visible"));
    await settle(20);
    expect(created).toHaveBeenCalledOnce();
    view.rerender(content("hidden"));
    await settle(20);
    expect(streams.live()).toHaveLength(0);
    view.rerender(content("visible"));
    await settle(20);
    expect(streams.live("alpha")).toHaveLength(1);
    expect(created).toHaveBeenCalledOnce();
    expect(terminated).not.toHaveBeenCalled();
  });

  it("closes every conversation stream on unmount after Strict Mode reconnects", async () => {
    const view = render(
      <StrictMode>
        <ChatApp
          initial={[
            initialBot("alpha", {
              name: "Alpha",
              rows: seq(started("working")),
            }),
            initialBot("beta", { name: "Beta" }),
          ]}
        />
      </StrictMode>
    );
    await settle(20);
    expect(streams.live("alpha")).toHaveLength(1);
    select("Beta");
    await settle(20);
    expect(streams.live()).toHaveLength(2);
    view.unmount();
    expect(streams.live()).toHaveLength(0);
  });

  it("resumes selected and working conversations after the chat route is hidden", async () => {
    const initial = [
      initialBot("alpha", {
        name: "Alpha",
        rows: seq(started("working")),
      }),
      initialBot("beta", { name: "Beta" }),
    ];
    const content = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <ChatApp initial={initial} />
      </Activity>
    );
    const view = render(content("visible"));
    await settle(20);
    select("Beta");
    await settle(20);
    fireEvent.change(pane("Beta").getByLabelText("Message"), {
      target: { value: "Keep across route navigation" },
    });
    expect(streams.live()).toHaveLength(2);
    view.rerender(content("hidden"));
    await settle(20);
    expect(streams.live()).toHaveLength(0);
    view.rerender(content("visible"));
    await settle(20);
    expect(streams.live("alpha")).toHaveLength(1);
    expect(streams.live("beta")).toHaveLength(1);
    expect(
      (pane("Beta").getByLabelText("Message") as HTMLTextAreaElement).value
    ).toBe("Keep across route navigation");
    emitFacts(
      streams,
      "alpha",
      seqFrom(
        1,
        reply("resumed", "Resumed background reply"),
        settled("working")
      )
    );
    await settle(20);
    select("Alpha");
    await settle(20);
    expect(
      await pane("Alpha").findByText("Resumed background reply")
    ).toBeTruthy();
    view.unmount();
    expect(streams.live()).toHaveLength(0);
  });

  it.each([
    { history: "new chat", rows: seq() },
    {
      history: "existing conversation",
      rows: seq(
        started("old-turn"),
        said("old-delivery", "Previous message"),
        reply("old-reply", "Previous reply"),
        settled("old-turn")
      ),
    },
  ])(
    "walks the wait stages on one status line from send to turn start in a $history",
    async ({ rows }) => {
      const heldPost = held();
      server.on("POST", "/api/bots/alpha/messages", heldPost.answer);
      renderApp([initialBot("alpha", { name: "Alpha", rows })]);
      await settle(20);

      fireEvent.change(pane("Alpha").getByLabelText("Message"), {
        target: { value: "Start this turn" },
      });
      fireEvent.click(pane("Alpha").getByRole("button", { name: "Send" }));
      await settle();
      const status = pane("Alpha").getByText("Thinking…");
      const node = status.closest("li");

      heldPost.resolve(json({ deliveryId: "delivery-alpha" }));
      await settle();
      expect(pane("Alpha").getByText("Thinking…").closest("li")).toBe(node);
      // Nothing from the bot after a second: it is still starting.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1100));
      });
      expect(pane("Alpha").getByText("Waking up Alpha…").closest("li")).toBe(
        node
      );
      expect(status.closest("li")?.style.opacity).not.toBe("0");

      emitFacts(streams, "alpha", seqFrom(rows.length, started("turn-alpha")));
      await settle();
      expect(pane("Alpha").getByText("Thinking…").closest("li")).toBe(node);

      emitFacts(
        streams,
        "alpha",
        seqFrom(rows.length + 1, said("delivery-alpha", "Start this turn"))
      );
      await settle();
      expect(pane("Alpha").getByText("Thinking…").closest("li")).toBe(node);

      emitFacts(
        streams,
        "alpha",
        seqFrom(rows.length + 2, settled("turn-alpha"))
      );
      await settle();
    }
  );

  it("keeps an unanswered question visible when later messages exceed the render window", async () => {
    renderApp([
      initialBot("alpha", {
        name: "Alpha",
        rows: seq(
          started("turn-1"),
          [
            "interaction.opened",
            {
              interactionId: "question-1",
              request: {
                kind: "question",
                options: [{ id: "yes", label: "Approve" }],
                prompt: "Approve this pending change?",
              },
            },
          ],
          ...Array.from({ length: 40 }, (_, index) =>
            reply(`part-${index}`, `Later message ${index}`)
          )
        ),
      }),
    ]);
    await settle(30);
    expect(
      await pane("Alpha").findByText("Approve this pending change?")
    ).toBeTruthy();
  });
  it("keeps the draft and scroll position when switching away and back", async () => {
    renderApp(bots());
    await settle(20);

    const message = pane("Alpha").getByLabelText(
      "Message"
    ) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "keep this draft" } });

    const alphaRegion = screen.getByRole("region", { name: "Chat with Alpha" });
    const alphaScroll = alphaRegion.querySelector(
      ".overflow-y-auto"
    ) as HTMLElement;
    alphaScroll.scrollTop = 128;
    fireEvent.scroll(alphaScroll);

    select("Beta");
    await settle(10);
    select("Alpha");
    await settle(20);

    expect(
      (pane("Alpha").getByLabelText("Message") as HTMLTextAreaElement).value
    ).toBe("keep this draft");
    const restoredScroll = screen
      .getByRole("region", { name: "Chat with Alpha" })
      .querySelector(".overflow-y-auto") as HTMLElement;
    expect(restoredScroll.scrollTop).toBe(128);
  });

  it("keeps a background stream and pending send while another bot is visible", async () => {
    const heldPost = held();
    server.on("POST", "/api/bots/alpha/messages", heldPost.answer);
    renderApp([
      initialBot("alpha", { name: "Alpha", rows: seq(started("turn-alpha")) }),
      initialBot("beta", { name: "Beta" }),
    ]);
    await settle(20);

    const message = pane("Alpha").getByLabelText("Message");
    fireEvent.change(message, { target: { value: "pending alpha" } });
    fireEvent.click(pane("Alpha").getByRole("button", { name: "Send" }));
    await settle(8);

    select("Beta");
    await settle(12);
    expect(streams.last("alpha").closed).toBe(false);

    emitFacts(
      streams,
      "alpha",
      seqFrom(
        1,
        reply("part-alpha", "Background answer"),
        settled("turn-alpha")
      )
    );
    await settle(12);
    select("Alpha");
    await settle(20);

    expect(screen.getByText("Background answer")).toBeTruthy();
    expect(screen.getByText("pending alpha")).toBeTruthy();
    heldPost.resolve(json({ deliveryId: "delivery-alpha" }));
    await settle(8);
  });

  it("leaves only the last selected pane visible after rapid switching", async () => {
    renderApp(bots());
    await settle(20);

    select("Beta");
    select("Alpha");
    select("Beta");
    select("Alpha");
    await settle(20);

    expect(
      screen.getByRole("button", { name: "Alpha" }).getAttribute("aria-current")
    ).toBe("page");
    expect(() => pane("Alpha").getByLabelText("Message")).not.toThrow();
    expect(() => pane("Beta")).toThrow();
  });
});
