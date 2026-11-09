// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutinesPanel } from "@/components/routines-panel";
import type { PublicRoutine } from "@/lib/routines/types";

const routineId = "11111111-1111-4111-8111-111111111111";
const ADD_OR_CREATE = /Add|Create/iu;
const ADD_ROUTINE = /Add routine/iu;
const DAILY_PROMPT = /Every day at 9 AM, review my inbox and send a summary/u;
const DELETE_ERROR = /delete/iu;
const RUN_AGAIN = /run again/iu;
const PRIVATE_TOKEN = /private access token/iu;
const INTERNAL_CANCELLATION = /internal cancellation reason/iu;

const makeRoutine = (
  overrides: Partial<PublicRoutine> = {}
): PublicRoutine => ({
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  enabled: true,
  id: routineId,
  lastRun: null,
  name: "Morning brief",
  prompt: "Review my inbox and summarize what needs attention.",
  time: "09:00",
  timeZone: "America/Argentina/Cordoba",
  ...overrides,
});

const responseFor = (body: unknown, ok = true) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: ok ? 200 : 500,
  });

let routines: PublicRoutine[];
let patchFailure = false;
let deleteFailure = false;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function patchCalls() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
}

function deleteCalls() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE");
}

function lastPatchBody() {
  const call = patchCalls().at(-1);
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

function openRoutineMenu(name = "Morning brief") {
  fireEvent.click(screen.getByRole("button", { name: `Options for ${name}` }));
}

function openEditor() {
  openRoutineMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  return screen.findByRole("button", { name: "Save changes" });
}

function renderPanel() {
  return render(
    <RoutinesPanel
      name="Assistant"
      onOpenChange={vi.fn()}
      open
      slug="assistant"
    />
  );
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  routines = [makeRoutine()];
  patchFailure = false;
  deleteFailure = false;
  fetchMock = vi.fn<typeof fetch>(
    // biome-ignore lint/suspicious/useAwait: Fetch always returns a Promise, including when the mock parses a malformed request.
    async (input, init) => {
      const url = String(input);
      if (init?.method === "PATCH") {
        if (patchFailure) {
          return responseFor({ error: "update failed" }, false);
        }
        const id = url.split("/").at(-1);
        const payload = JSON.parse(String(init.body)) as Partial<PublicRoutine>;
        const current = routines.find((item) => item.id === id);
        if (!current) {
          return responseFor({ error: "not found" }, false);
        }
        const updated = { ...current, ...payload } as PublicRoutine;
        routines = routines.map((item) => (item.id === id ? updated : item));
        return responseFor({ routine: updated });
      }
      if (init?.method === "DELETE") {
        if (deleteFailure) {
          return responseFor({ error: "delete failed" }, false);
        }
        const id = url.split("/").at(-1);
        routines = routines.filter((item) => item.id !== id);
        return responseFor({ ok: true });
      }
      if (url.endsWith("/routines")) {
        return responseFor({ routines });
      }
      return responseFor({ routines: [] });
    }
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RoutinesPanel", () => {
  it("shows the compact row and keeps creation chat-first", async () => {
    renderPanel();

    expect(await screen.findByText("Morning brief")).toBeTruthy();
    expect(screen.getByText("Every day at 09:00")).toBeTruthy();
    expect(
      screen
        .getByRole("switch", { name: "Morning brief" })
        .getAttribute("aria-checked")
    ).toBe("true");
    expect(screen.queryByRole("button", { name: ADD_ROUTINE })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("dialog").textContent).toContain(
      "Ask in chat to create a routine."
    );
  });

  it("shows safe provider guidance for a failed run without offering an automatic rerun", async () => {
    routines = [
      makeRoutine({
        lastRun: {
          deliveryId: "delivery-1",
          error:
            "Your ChatGPT connection is no longer available. Reconnect it in Settings.",
          finishedAt: "2026-11-02T12:01:00.000Z",
          id: "22222222-2222-4222-8222-222222222222",
          scheduledFor: "2026-11-02T12:00:00.000Z",
          startedAt: "2026-11-02T12:00:01.000Z",
          status: "failed",
        },
      }),
    ];
    renderPanel();

    const providerFailure = await screen.findByText("Last run failed");
    expect(providerFailure.parentElement?.textContent).toContain(
      "Your ChatGPT connection is no longer available. Reconnect it in Settings."
    );
    expect(screen.queryByRole("button", { name: RUN_AGAIN })).toBeNull();
  });

  it("hides legacy raw routine errors behind a safe chat instruction", async () => {
    routines = [
      makeRoutine({
        lastRun: {
          deliveryId: "delivery-2",
          error: "provider response included a private access token",
          finishedAt: "2026-11-02T12:01:00.000Z",
          id: "33333333-3333-4333-8333-333333333333",
          scheduledFor: "2026-11-02T12:00:00.000Z",
          startedAt: "2026-11-02T12:00:01.000Z",
          status: "failed",
        },
      }),
    ];
    renderPanel();

    const legacyFailure = await screen.findByText("Last run failed");
    expect(legacyFailure.parentElement?.textContent).toContain(
      "The last run failed. Check this bot's chat for details."
    );
    expect(screen.queryByText(PRIVATE_TOKEN)).toBeNull();
  });

  it("shows a run paused on a question as waiting, and a schedule skipped meanwhile", async () => {
    routines = [
      makeRoutine({
        lastRun: {
          awaitingInputSince: "2026-11-02T12:05:00.000Z",
          deliveryId: "delivery-4",
          error: null,
          finishedAt: null,
          id: "55555555-5555-4555-8555-555555555555",
          scheduledFor: "2026-11-02T12:00:00.000Z",
          startedAt: "2026-11-02T12:00:01.000Z",
          status: "dispatched",
        },
        skipped: {
          count: 1,
          lastAt: "2026-11-03T12:00:10.000Z",
          lastReason: "awaiting_input",
        },
      }),
    ];
    renderPanel();

    const waiting = await screen.findByText("Waiting for you");
    expect(waiting.parentElement?.textContent).toContain(
      "Answer the bot in its chat so the routine can continue."
    );
    expect(waiting.parentElement?.textContent).toContain(
      "A later scheduled run was skipped while this one is open."
    );
  });

  it("does not render an unknown legacy cancellation reason", async () => {
    routines = [
      makeRoutine({
        lastRun: {
          deliveryId: "delivery-3",
          error: "provider callback contained an internal cancellation reason",
          finishedAt: "2026-11-02T12:01:00.000Z",
          id: "44444444-4444-4444-8444-444444444444",
          scheduledFor: "2026-11-02T12:00:00.000Z",
          startedAt: "2026-11-02T12:00:01.000Z",
          status: "cancelled",
        },
      }),
    ];
    renderPanel();

    expect(await screen.findByText("Last run cancelled")).toBeTruthy();
    expect(screen.queryByText(INTERNAL_CANCELLATION)).toBeNull();
  });

  it("shows a clear chat-first empty state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => Promise.resolve(responseFor({ routines: [] })))
    );
    renderPanel();

    expect(
      await screen.findByRole("heading", { name: "No routines yet" })
    ).toBeTruthy();
    expect(screen.getByText(DAILY_PROMPT)).toBeTruthy();
    expect(screen.queryByRole("button", { name: ADD_OR_CREATE })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("keeps a failed load separate from the empty state and can retry", async () => {
    const get = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(responseFor({}, false))
      .mockResolvedValueOnce(responseFor({ routines: [makeRoutine()] }));
    vi.stubGlobal("fetch", get);
    renderPanel();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn’t load routines. Try again."
    );
    expect(
      screen.queryByRole("heading", { name: "No routines yet" })
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Morning brief")).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("toggles from the switch without opening the options menu", async () => {
    renderPanel();
    await screen.findByText("Morning brief");

    fireEvent.click(screen.getByRole("switch", { name: "Morning brief" }));

    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect(lastPatchBody()).toMatchObject({ enabled: false });
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(await screen.findByText("Paused")).toBeTruthy();
  });

  it("offers pause and resume from the row menu", async () => {
    renderPanel();
    await screen.findByText("Morning brief");

    openRoutineMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pause" }));
    await waitFor(() =>
      expect(lastPatchBody()).toMatchObject({ enabled: false })
    );
    expect(await screen.findByText("Paused")).toBeTruthy();

    openRoutineMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Resume" }));
    await waitFor(() =>
      expect(lastPatchBody()).toMatchObject({ enabled: true })
    );
    expect(await screen.findByText("Every day at 09:00")).toBeTruthy();
  });

  it("saves all edited fields without changing enabled state", async () => {
    renderPanel();
    await screen.findByText("Morning brief");
    await openEditor();

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Updated brief" },
    });
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "Check the inbox and send a concise report." },
    });
    fireEvent.change(screen.getByLabelText("Time"), {
      target: { value: "17:16" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect(lastPatchBody()).toMatchObject({
      name: "Updated brief",
      prompt: "Check the inbox and send a concise report.",
      time: "17:16",
    });
    expect("enabled" in lastPatchBody()).toBe(false);
    expect("timeZone" in lastPatchBody()).toBe(false);
    expect("daysOfWeek" in lastPatchBody()).toBe(false);
    expect(await screen.findByText("Updated brief")).toBeTruthy();
    expect(
      screen
        .getByRole("switch", { name: "Updated brief" })
        .getAttribute("aria-checked")
    ).toBe("true");
  });

  it("closes the editor without PATCH when nothing changed", async () => {
    renderPanel();
    await screen.findByText("Morning brief");
    await openEditor();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Edit routine" })).toBeNull()
    );
    expect(patchCalls()).toHaveLength(0);
    expect(screen.getByText("Morning brief")).toBeTruthy();
  });

  it("rejects an edit with no repeat days before sending", async () => {
    renderPanel();
    await screen.findByText("Morning brief");
    await openEditor();

    for (const checkbox of screen.getAllByRole("checkbox")) {
      fireEvent.click(checkbox);
    }
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Choose at least one day."
    );
    expect(patchCalls()).toHaveLength(0);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("rejects an edit with an invalid time zone before sending", async () => {
    renderPanel();
    await screen.findByText("Morning brief");
    await openEditor();

    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "Mars/Olympus" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Use a valid IANA time zone."
    );
    expect(patchCalls()).toHaveLength(0);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("keeps the edit modal open when PATCH fails", async () => {
    patchFailure = true;
    renderPanel();
    await screen.findByText("Morning brief");
    await openEditor();

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Still fails" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn’t update this routine. Try again."
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Edit routine" })).toBeTruthy();
    expect(screen.getByText("Morning brief")).toBeTruthy();
  });

  it("keeps the delete confirmation open and the routine visible when DELETE fails", async () => {
    deleteFailure = true;
    renderPanel();
    await screen.findByText("Morning brief");

    openRoutineMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(
      await screen.findByRole("heading", { name: "Delete routine?" })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete routine" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      DELETE_ERROR
    );
    expect(
      screen.getByRole("heading", { name: "Delete routine?" })
    ).toBeTruthy();
    expect(screen.getByText("Morning brief")).toBeTruthy();
  });

  it("confirms deletion and removes the routine after DELETE succeeds", async () => {
    renderPanel();
    await screen.findByText("Morning brief");

    openRoutineMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(
      await screen.findByRole("heading", { name: "Delete routine?" })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete routine" }));

    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("Morning brief")).toBeNull());
  });
});
