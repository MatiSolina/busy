// @vitest-environment happy-dom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitFacts,
  initialBot,
  installFakes,
  json,
  pane,
  renderApp,
  row,
  type Server,
  type Streams,
  seq,
  settle,
  settled,
  started,
} from "@/components/components.test-helpers";
import { isWaitingForInput, toChatView } from "@/lib/chat/items";

vi.mock("@/components/live-view", () => ({
  LiveView: () => null,
}));

let server: Server;
let streams: Streams;

const opened = (
  interactionId: string,
  subject: Record<string, unknown> = { turnId: "turn-alpha" }
) =>
  [
    "interaction.opened",
    {
      interactionId,
      request: {
        kind: "question",
        options: [{ id: "continue", label: "Continue" }],
        prompt: "Should I continue?",
      },
      subject,
    },
  ] as const;

beforeEach(() => {
  ({ server, streams } = installFakes());
  server.on(
    "GET",
    "/api/account",
    json({
      account: { avatarUrl: null, name: "Matias Solina" },
      tokenPass: {
        dashboardUrl: "https://vercel.com",
        percentUsed: 0,
        status: "active",
      },
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("awaiting human input UI", () => {
  it("also shows waiting while the user completes a login", async () => {
    renderApp([
      initialBot("alpha", {
        name: "Alpha",
        rows: seq(
          started("turn-alpha"),
          [
            "call.requested",
            { callId: "login-call", capability: { name: "request_login" } },
          ],
          opened("login-alpha", { callId: "login-call" })
        ),
      }),
    ]);
    await settle(20);

    expect(screen.getByText("Waiting for you")).toBeTruthy();
    expect(screen.queryByText("Working")).toBeNull();
    expect(screen.queryByText("Working…")).toBeNull();
    expect(pane("Alpha").getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("keeps Stop and the SSE stream while replacing Working with Waiting for you", async () => {
    renderApp([
      initialBot("alpha", {
        name: "Alpha",
        rows: seq(started("turn-alpha"), opened("question-alpha")),
      }),
      initialBot("beta", { name: "Beta" }),
    ]);
    await settle(20);

    const waitingStatus = screen.getByText("Waiting for you");
    expect(waitingStatus).toBeTruthy();
    expect(waitingStatus.className).not.toContain("text-shimmer");
    expect(screen.queryByText("Working…")).toBeNull();
    expect(pane("Alpha").getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(streams.last("alpha").closed).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    await settle(12);
    expect(streams.last("alpha").closed).toBe(false);
  });

  it("returns to Thinking after an answer is submitted, then clears after the turn settles", async () => {
    renderApp([
      initialBot("alpha", {
        name: "Alpha",
        rows: seq(started("turn-alpha"), opened("question-alpha")),
      }),
    ]);
    await settle(20);
    const stream = streams.last("alpha");

    emitFacts(streams, "alpha", [
      row(2, "response.submitted", {
        interactionId: "question-alpha",
        responseId: "response-alpha",
      }),
    ]);
    await settle(12);
    expect(screen.queryByText("Waiting for you")).toBeNull();
    // The resumed turn shows the wait stage (lib/chat/status.ts), not the generic label.
    expect(screen.getByText("Thinking…")).toBeTruthy();

    emitFacts(streams, "alpha", [
      row(3, "interaction.settled", {
        interactionId: "question-alpha",
        outcome: "accepted",
      }),
      row(4, "turn.settled", {
        outcome: "completed",
        turnId: "turn-alpha",
      }),
    ]);
    await settle(12);
    expect(screen.queryByText("Waiting for you")).toBeNull();
    expect(stream.closed).toBe(false);
  });

  it.each(["cancelled", "failed"] as const)(
    "does not show waiting after a %s turn settles",
    async (outcome) => {
      renderApp([
        initialBot("alpha", {
          name: "Alpha",
          rows: seq(
            started("turn-alpha"),
            opened("question-alpha"),
            settled("turn-alpha", outcome)
          ),
        }),
      ]);
      await settle(20);

      expect(screen.queryByText("Waiting for you")).toBeNull();
      expect(screen.queryByText("Working…")).toBeNull();
    }
  );

  it("treats an open subagent question as waiting input without changing the raw turn status", () => {
    const rows = seq(
      started("turn-alpha"),
      [
        "task.started",
        { kind: "agent", name: "Research", taskId: "task-alpha" },
      ],
      opened("question-alpha", { taskId: "task-alpha" })
    );
    const view = toChatView(rows, new Map(), new Map());

    expect(view.working).toBe(true);
    expect(isWaitingForInput(view.items)).toBe(true);
  });
});
