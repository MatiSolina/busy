// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  held,
  installFakes,
  json,
  reply,
  seq,
  settle,
  settled,
  started,
} from "./components.test-helpers";
import { ThreadSheet } from "./thread-sheet";

const thread = (id: string, text: string) => ({
  from: { avatar: null, name: `${id} from`, slug: `${id}-from` },
  id,
  question: null,
  rows: seq(
    started(`${id}-turn`),
    reply(`${id}-part`, text),
    settled(`${id}-turn`)
  ),
  to: { avatar: null, name: `${id} to`, slug: `${id}-to` },
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ThreadSheet consultation loading", () => {
  it("retries a failed load without sending the consultation again", async () => {
    const { server } = installFakes();
    server.once(
      "GET",
      "/api/consultations/a",
      json({ error: "unavailable" }, 503)
    );
    server.on("GET", "/api/consultations/a", json(thread("a", "A reply")));
    render(<ThreadSheet consultationId="a" onClose={vi.fn()} />);
    await settle(20);
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle(20);
    expect(screen.getByText("A reply")).toBeTruthy();
    expect(server.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("discards the previous reader when switching ids before a response", async () => {
    const { server, streams } = installFakes();
    const bResponse = held();
    server.on("GET", "/api/consultations/a", json(thread("a", "A reply")));
    server.on("GET", "/api/consultations/b", bResponse.answer);

    const view = render(<ThreadSheet consultationId="a" onClose={vi.fn()} />);
    await settle(20);
    expect(screen.getByText("A reply")).toBeTruthy();
    expect(streams.live("a")).toHaveLength(1);

    view.rerender(<ThreadSheet consultationId="b" onClose={vi.fn()} />);
    expect(screen.getByText("Loading the consultation…")).toBeTruthy();
    expect(screen.queryByText("A reply")).toBeNull();
    expect(streams.live("a")).toHaveLength(0);

    view.rerender(<ThreadSheet consultationId="a" onClose={vi.fn()} />);
    await settle(20);
    expect(screen.getByText("A reply")).toBeTruthy();

    bResponse.resolve(json(thread("b", "B reply")));
    await settle(20);
    expect(screen.getByText("A reply")).toBeTruthy();
    expect(screen.queryByText("B reply")).toBeNull();
    expect(streams.live("b")).toHaveLength(0);
  });

  it("does not restore a closed reader when the same id is reopened", async () => {
    const { server } = installFakes();
    server.on("GET", "/api/consultations/a", json(thread("a", "A reply")));

    const onClose = vi.fn();
    const view = render(<ThreadSheet consultationId="a" onClose={onClose} />);
    await settle(20);
    expect(screen.getByText("A reply")).toBeTruthy();

    view.rerender(<ThreadSheet consultationId={null} onClose={onClose} />);
    view.rerender(<ThreadSheet consultationId="a" onClose={onClose} />);
    expect(screen.getByText("Loading the consultation…")).toBeTruthy();

    await settle(20);
    expect(screen.getByText("A reply")).toBeTruthy();
  });
});
