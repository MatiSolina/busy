// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SectionsProvider, useSections } from "@/components/sections-provider";
import type { Section } from "@/lib/sections/types";

const first: Section = {
  botSlugs: ["documents", "dnc"],
  id: "one",
  name: "Documents",
};
const second: Section = {
  botSlugs: ["sales"],
  id: "two",
  name: "Equipo Comercial LFT",
};

const ignoreError = () => undefined;

function Harness() {
  const { createSection, deleteSection, moveBot, renameSection, sections } =
    useSections();
  const onCreate = useCallback(() => {
    createSection("New section").catch(ignoreError);
  }, [createSection]);
  const onRename = useCallback(() => {
    renameSection("one", "Renamed").catch(ignoreError);
  }, [renameSection]);
  const onMove = useCallback(() => {
    moveBot("documents", "two").catch(ignoreError);
  }, [moveBot]);
  const onDelete = useCallback(() => {
    deleteSection("one").catch(ignoreError);
  }, [deleteSection]);
  return (
    <>
      <output data-testid="sections">{JSON.stringify(sections)}</output>
      <button onClick={onCreate} type="button">
        Create
      </button>
      <button onClick={onRename} type="button">
        Rename
      </button>
      <button onClick={onMove} type="button">
        Move
      </button>
      <button onClick={onDelete} type="button">
        Delete
      </button>
    </>
  );
}

function state() {
  return JSON.parse(
    screen.getByTestId("sections").textContent ?? "[]"
  ) as Section[];
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/sections" && method === "POST") {
        return Response.json(
          { section: { botSlugs: [], id: "three", name: "New section" } },
          { status: 201 }
        );
      }
      if (url === "/api/sections/one" && method === "PATCH") {
        return Response.json({ section: { ...first, name: "Renamed" } });
      }
      if (url === "/api/sections/one" && method === "DELETE") {
        return Response.json({ ok: true });
      }
      if (url === "/api/bots/documents/section" && method === "PUT") {
        return Response.json({ ok: true });
      }
      return Response.json({ error: "unexpected request" }, { status: 500 });
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SectionsProvider", () => {
  it("shares sections and applies create, rename, move, and delete", async () => {
    render(
      <SectionsProvider initial={[first, second]}>
        <Harness />
      </SectionsProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(state()).toContainEqual({
        botSlugs: [],
        id: "three",
        name: "New section",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(state().find((section) => section.id === "one")?.name).toBe(
        "Renamed"
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => {
      expect(state().find((section) => section.id === "one")?.botSlugs).toEqual(
        ["dnc"]
      );
      expect(state().find((section) => section.id === "two")?.botSlugs).toEqual(
        ["sales", "documents"]
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(state().map((section) => section.id)).toEqual(["two", "three"])
    );
  });

  it("keeps the previous membership when a move fails", async () => {
    const request = vi.fn(async () =>
      Response.json({ error: "section unavailable" }, { status: 503 })
    );
    vi.stubGlobal("fetch", request);
    render(
      <SectionsProvider initial={[first, second]}>
        <MoveErrorHarness />
      </SectionsProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "section unavailable"
      )
    );
    expect(state()).toEqual([first, second]);
  });

  it("does not restore a forgotten bot when its optimistic move fails", async () => {
    let resolveRequest!: (response: Response) => void;
    const request = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => request)
    );
    render(
      <SectionsProvider initial={[first, second]}>
        <PendingMoveHarness forgottenSlug="documents" />
      </SectionsProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(state()).toEqual([
      { ...first, botSlugs: ["dnc"] },
      { ...second, botSlugs: ["sales", "documents"] },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Forget documents" }));
    expect(state()).toEqual([
      { ...first, botSlugs: ["dnc"] },
      { ...second, botSlugs: ["sales"] },
    ]);

    resolveRequest(
      Response.json({ error: "section unavailable" }, { status: 503 })
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "section unavailable"
      )
    );
    expect(state()).toEqual([
      { ...first, botSlugs: ["dnc"] },
      { ...second, botSlugs: ["sales"] },
    ]);
  });

  it("keeps another forgotten bot out of a failed move rollback", async () => {
    let resolveRequest!: (response: Response) => void;
    const request = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => request)
    );
    render(
      <SectionsProvider initial={[first, second]}>
        <PendingMoveHarness forgottenSlug="dnc" />
      </SectionsProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(state()).toEqual([
      { ...first, botSlugs: ["dnc"] },
      { ...second, botSlugs: ["sales", "documents"] },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Forget dnc" }));
    expect(state()).toEqual([
      { ...first, botSlugs: [] },
      { ...second, botSlugs: ["sales", "documents"] },
    ]);

    resolveRequest(
      Response.json({ error: "section unavailable" }, { status: 503 })
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "section unavailable"
      )
    );
    expect(state()).toEqual([
      { ...first, botSlugs: ["documents"] },
      { ...second, botSlugs: ["sales"] },
    ]);
  });

  it("rejects a concurrent write and unlocks after the first write fails", async () => {
    let rejectFirst: ((reason: Error) => void) | undefined;
    const firstRequest = new Promise<Response>((_resolve, reject) => {
      rejectFirst = reject;
    });
    let requests = 0;
    const request = vi.fn(() => {
      requests += 1;
      return requests === 1
        ? firstRequest
        : Promise.resolve(
            Response.json({
              section: { botSlugs: [], id: "three", name: "New section" },
            })
          );
    });
    vi.stubGlobal("fetch", request);
    render(
      <SectionsProvider initial={[]}>
        <ConcurrentHarness />
      </SectionsProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    fireEvent.click(screen.getByRole("button", { name: "Create again" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Another section update is in progress."
      )
    );
    rejectFirst?.(new Error("network down"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Couldn't create section."
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "Create again" }));
    await waitFor(() =>
      expect(state()).toContainEqual({
        botSlugs: [],
        id: "three",
        name: "New section",
      })
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("forgets a deleted bot locally without making another request", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    render(
      <SectionsProvider initial={[first, second]}>
        <ForgetBotHarness />
      </SectionsProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Forget bot" }));
    await waitFor(() =>
      expect(state().find((section) => section.id === "one")?.botSlugs).toEqual(
        ["dnc"]
      )
    );
    expect(request).not.toHaveBeenCalled();
  });
});

function MoveErrorHarness() {
  const { moveBot, sections } = useSections();
  const [error, setError] = useState<string | null>(null);
  const onMove = useCallback(() => {
    moveBot("documents", "two").catch((reason: Error) =>
      setError(reason.message)
    );
  }, [moveBot]);
  return (
    <>
      <output data-testid="sections">{JSON.stringify(sections)}</output>
      <button onClick={onMove} type="button">
        Move
      </button>
      {error ? <div role="alert">{error}</div> : null}
    </>
  );
}

function PendingMoveHarness({ forgottenSlug }: { forgottenSlug: string }) {
  const { forgetBot, moveBot, sections } = useSections();
  const [error, setError] = useState<string | null>(null);
  const onMove = useCallback(() => {
    moveBot("documents", "two").catch((reason: Error) =>
      setError(reason.message)
    );
  }, [moveBot]);
  const onForget = useCallback(
    () => forgetBot(forgottenSlug),
    [forgetBot, forgottenSlug]
  );
  return (
    <>
      <output data-testid="sections">{JSON.stringify(sections)}</output>
      <button onClick={onMove} type="button">
        Move
      </button>
      <button onClick={onForget} type="button">
        Forget {forgottenSlug}
      </button>
      {error ? <div role="alert">{error}</div> : null}
    </>
  );
}

function ConcurrentHarness() {
  const { createSection, sections } = useSections();
  const [error, setError] = useState<string | null>(null);
  const onCreate = useCallback(() => {
    createSection("New section").catch((reason: Error) =>
      setError(reason.message)
    );
  }, [createSection]);
  return (
    <>
      <output data-testid="sections">{JSON.stringify(sections)}</output>
      {error ? <div role="alert">{error}</div> : null}
      <button onClick={onCreate} type="button">
        Create
      </button>
      <button onClick={onCreate} type="button">
        Create again
      </button>
    </>
  );
}

function ForgetBotHarness() {
  const { forgetBot, sections } = useSections();
  const onForget = useCallback(() => {
    forgetBot("documents");
  }, [forgetBot]);
  return (
    <>
      <output data-testid="sections">{JSON.stringify(sections)}</output>
      <button onClick={onForget} type="button">
        Forget bot
      </button>
    </>
  );
}
