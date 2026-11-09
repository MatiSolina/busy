// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FiresideDialog } from "./components/fireside-dialog";
import type { FiresideView } from "./lib/firesides/types";

vi.mock("@/components/messages", () => ({
  MessageList: ({ items }: { items: { id: string; text?: string }[] }) => (
    <div>
      {items.map((item) => (
        <p key={item.id}>{item.text}</p>
      ))}
    </div>
  ),
}));
vi.mock("@/components/live-view", () => ({ LiveView: () => null }));
vi.mock("@/components/bot-avatar", () => ({ BotAvatar: () => null }));
const fetcher = vi.fn<typeof fetch>();
const close = vi.fn();
let room: FiresideView;
beforeEach(() => {
  close.mockReset();
  fetcher.mockReset();
  room = {
    active: null,
    createdAt: new Date().toISOString(),
    error: null,
    id: "11111111-1111-4111-8111-111111111111",
    messages: [
      {
        at: new Date().toISOString(),
        id: "one",
        speaker: "guest",
        text: "Start with a small release.",
      },
    ],
    participants: {
      guest: {
        avatar: null,
        billing: "grok",
        id: "guest",
        model: "grok/grok-4.7",
        name: "Strategy",
        slug: "strategy",
      },
      primary: {
        avatar: null,
        billing: "chatgpt",
        id: "primary",
        model: "chatgpt/gpt-6",
        name: "Product",
        slug: "product",
      },
    },
    primarySlug: "primary",
    revision: 3,
    status: "waiting",
    summary: null,
  };
  fetcher.mockImplementation((_url, init) => {
    const command = init?.body ? JSON.parse(String(init.body)) : null;
    if (command?.kind === "continue" || command?.kind === "intervene") {
      room = { ...room, revision: room.revision + 1, status: "running" };
    }
    if (command?.kind === "close") {
      room = { ...room, revision: room.revision + 1, status: "closing" };
    }
    return Promise.resolve(Response.json(room));
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("fireside UI", () => {
  it("opens immediately, preserves Busy chat controls, and continues only on an explicit click", async () => {
    render(
      <FiresideDialog
        onClose={close}
        slug="primary"
        target={{ originId: "invocation" }}
      />
    );
    await screen.findByText("Start with a small release.");
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/bots/primary/firesides");
    expect(screen.queryByText("Open fireside")).toBeNull();
    expect(screen.queryByText("Limit")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy()
    );
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      kind: "continue",
      revision: 3,
    });
  });
  it("reopens read-only and sends the human intervention as a bounded command", async () => {
    room.status = "closed";
    render(
      <FiresideDialog onClose={close} slug="primary" target={{ id: room.id }} />
    );
    await screen.findByText("Start with a small release.");
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(
      fetcher.mock.calls.filter((call) => call[1]?.method === "POST")
    ).toHaveLength(0);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "What about cost?" },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some((call) =>
          String(call[1]?.body).includes('"kind":"intervene"')
        )
      ).toBe(true)
    );
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      kind: "intervene",
      text: "What about cost?",
    });
  });
  it("persists close before returning to the principal", async () => {
    render(
      <FiresideDialog onClose={close} slug="primary" target={{ id: room.id }} />
    );
    await screen.findByText("Start with a small release.");
    fireEvent.click(screen.getByRole("button", { name: "Close fireside" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      kind: "close",
    });
  });
  it("recovers a lost create response with the same invocation before closing", async () => {
    fetcher.mockRejectedValueOnce(new Error("Connection lost"));
    render(
      <FiresideDialog
        onClose={close}
        slug="primary"
        target={{ originId: "same-invocation" }}
      />
    );
    await screen.findByText("Connection lost");
    fireEvent.click(screen.getByRole("button", { name: "Close fireside" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      id: "same-invocation",
    });
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toMatchObject({
      kind: "close",
    });
  });
  it("retries a lost command response with the same command id and revision", async () => {
    render(
      <FiresideDialog onClose={close} slug="primary" target={{ id: room.id }} />
    );
    await screen.findByText("Start with a small release.");
    fetcher.mockRejectedValueOnce(new Error("Lost response"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Lost response");
    const first = fetcher.mock.calls.find((call) =>
      String(call[1]?.body).includes('"kind":"continue"')
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy()
    );
    const posts = fetcher.mock.calls.filter((call) =>
      String(call[1]?.body).includes('"kind":"continue"')
    );
    expect(posts).toHaveLength(2);
    expect(posts[1]?.[1]?.body).toBe(first?.[1]?.body);
  });
});
