// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  held,
  installFakes,
  json,
  type Server,
} from "@/components/components.test-helpers";
import { MemorySheet } from "@/components/memory-sheet";

const PATH = "/api/bots/assistant/memory";
const ENTRY = { id: "memory-1", text: "Use the weekly report template" };
const onOpenChange = () => undefined;
let server: Server;

beforeEach(() => {
  ({ server } = installFakes());
  server.on("GET", PATH, json([ENTRY]));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("memory sheet", () => {
  it("searches, adds, edits, and displays provenance", async () => {
    const updated = {
      author: "mati",
      createdAt: "2026-11-02T12:00:00.000Z",
      id: "memory-1",
      origin: "owner",
      sourceStatus: "trusted_user",
      text: "Use the new weekly report template",
    };
    server.on("POST", PATH, json({ entries: [updated], version: 1 }));
    server.on("PATCH", PATH, json({ entries: [updated], version: 2 }));
    render(
      <MemorySheet
        name="Assistant"
        onOpenChange={onOpenChange}
        open
        slug="assistant"
      />
    );

    expect(await screen.findByText(ENTRY.text)).toBeTruthy();
    expect(screen.getByText("Source unknown (earlier memory)")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search memories" }), {
      target: { value: "weekly" },
    });
    expect(screen.getByText(ENTRY.text)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New memory" }), {
      target: { value: "New fact" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await waitFor(() => expect(server.to("POST", PATH)).toHaveLength(1));

    fireEvent.click(
      screen.getByRole("button", { name: `Edit: ${updated.text}` })
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Edit memory" }), {
      target: { value: updated.text },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(server.to("PATCH", PATH)).toHaveLength(1));
    expect(screen.getByText("Added by you · Nov 2, 2026")).toBeTruthy();
  });

  it("re-enables Save memory when the success response is not valid JSON", async () => {
    server.on("POST", PATH, new Response("not-json", { status: 200 }));
    render(
      <MemorySheet
        name="Assistant"
        onOpenChange={onOpenChange}
        open
        slug="assistant"
      />
    );

    await screen.findByText(ENTRY.text);
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New memory" }), {
      target: { value: "New fact" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));

    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Save memory",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
  });

  it("optimistically removes an entry and restores it if the DELETE fails", async () => {
    const deletion = held();
    server.on("DELETE", PATH, deletion.answer);
    render(
      <MemorySheet
        name="Assistant"
        onOpenChange={onOpenChange}
        open
        slug="assistant"
      />
    );

    fireEvent.click(
      await screen.findByRole("button", { name: `Forget: ${ENTRY.text}` })
    );
    await waitFor(() => expect(screen.queryByText(ENTRY.text)).toBeNull());
    expect(server.to("DELETE", PATH).at(-1)?.body).toEqual({
      entryId: ENTRY.id,
      expectedVersion: null,
    });

    await act(async () => deletion.resolve(json({}, 500)));
    expect(await screen.findByText(ENTRY.text)).toBeTruthy();
  });

  it("handles a delete immediately after reopening while its reload is pending", async () => {
    server.on("DELETE", PATH, json([]));
    const { rerender } = render(
      <MemorySheet
        name="Assistant"
        onOpenChange={onOpenChange}
        open
        slug="assistant"
      />
    );
    await screen.findByText(ENTRY.text);

    rerender(
      <MemorySheet
        name="Assistant"
        onOpenChange={onOpenChange}
        open={false}
        slug="assistant"
      />
    );
    const reload = held();
    server.on("GET", PATH, reload.answer);
    rerender(
      <MemorySheet
        name="Assistant"
        onOpenChange={onOpenChange}
        open
        slug="assistant"
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: `Forget: ${ENTRY.text}` })
    );
    await waitFor(() => expect(server.to("DELETE", PATH)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(ENTRY.text)).toBeNull());
  });
});
