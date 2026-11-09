// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installFakes,
  json,
  type Server,
} from "@/components/components.test-helpers";
import { HistorySheet } from "@/components/history-sheet";

const PATH = "/api/bots/assistant/history";
const RESULT_NAME = /A remembered decision/u;
const result = {
  createdAt: "2026-11-02T12:00:00.000Z",
  id: "assistant:memory:1",
  role: "assistant" as const,
  text: "A remembered decision",
};

let server: Server;
const onOpenChange = () => undefined;

beforeEach(() => {
  ({ server } = installFakes());
  server.on("GET", PATH, (call) => {
    const query = new URL(`https://busy.test${call.url}`).searchParams.get("q");
    return json({ query, results: [result] });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("history search sheet", () => {
  it("uses the last successful search when reading context after editing the input", async () => {
    render(
      <HistorySheet
        name="Assistant"
        onOpenChange={onOpenChange}
        open
        slug="assistant"
      />
    );
    const input = screen.getByRole("textbox", { name: "Search history" });
    fireEvent.change(input, { target: { value: "old query" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await screen.findByText(result.text);

    fireEvent.change(input, { target: { value: "edited query" } });
    fireEvent.click(screen.getByRole("button", { name: RESULT_NAME }));

    await waitFor(() => expect(server.to("GET", PATH)).toHaveLength(2));
    const [, contextCall] = server.to("GET", PATH);
    const query = new URL(`https://busy.test${contextCall.url}`).searchParams;
    expect(query.get("q")).toBe("old query");
    expect(query.get("around")).toBe(result.id);
  });
});
