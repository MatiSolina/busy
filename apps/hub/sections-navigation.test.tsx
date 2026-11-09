// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatApp } from "@/components/chat-app";
import {
  held,
  initialBot,
  installFakes,
  json,
  type Server,
  settle,
} from "@/components/components.test-helpers";
import { MobileMenu } from "@/components/sidebar";
import type { Section } from "@/lib/sections/types";

const dndMock = vi.hoisted(() => {
  const listeners = new Set<(event: unknown) => void>();
  const operationListeners = new Set<() => void>();
  let operation: { source: unknown; target: unknown } = {
    source: null,
    target: null,
  };
  return {
    emit(event: unknown) {
      [...listeners].at(-1)?.(event);
    },
    getOperation() {
      return operation;
    },
    listeners,
    operationListeners,
    resetOperation() {
      operation = { source: null, target: null };
    },
    setOperation(next: { source: unknown; target: unknown }) {
      operation = next;
      for (const listener of operationListeners) {
        listener();
      }
    },
  };
});

vi.mock("@dnd-kit/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/react")>();
  return {
    ...actual,
    DragDropProvider: ({
      children,
      onDragEnd,
    }: {
      children: ReactNode;
      onDragEnd?: (event: unknown) => void;
    }) => {
      useEffect(() => {
        if (!onDragEnd) {
          return;
        }
        dndMock.listeners.add(onDragEnd);
        return () => {
          dndMock.listeners.delete(onDragEnd);
        };
      }, [onDragEnd]);
      return children;
    },
    DragOverlay: () => null,
    useDraggable: ({ data, id }: { data?: unknown; id: string }) => ({
      draggable: { data, id, type: "busy-bot" },
      handleRef: () => null,
      isDragging: false,
      isDragSource: false,
      isDropping: false,
      ref: () => null,
    }),
    useDragOperation: () =>
      useSyncExternalStore(
        (listener) => {
          dndMock.operationListeners.add(listener);
          return () => {
            dndMock.operationListeners.delete(listener);
          };
        },
        dndMock.getOperation,
        dndMock.getOperation
      ),
    useDroppable: ({ data, id }: { data?: unknown; id: string }) => ({
      droppable: { data, id, type: "busy-section" },
      isDropTarget: false,
      ref: () => null,
    }),
  };
});

vi.mock("@/components/chat-pane", () => ({
  ChatPane: ({ slug }: { slug: string }) => {
    const [draft, setDraft] = useState("");
    const onChange = useCallback(
      (event: ChangeEvent<HTMLTextAreaElement>) =>
        setDraft(event.currentTarget.value),
      []
    );
    return (
      <section aria-label={`Chat with ${slug}`}>
        <MobileMenu />
        <label>
          Draft {slug}
          <textarea
            aria-label={`Draft ${slug}`}
            onChange={onChange}
            value={draft}
          />
        </label>
      </section>
    );
  },
}));

// Keep the mock self-contained while still exercising the real ChatApp, Sidebar and sections provider.
const alpha = initialBot("alpha", { name: "Alpha" });
const beta = initialBot("beta", { name: "Beta" });
const gamma = initialBot("gamma", { name: "Gamma" });

const section = (
  id: string,
  name: string,
  botSlugs: string[] = []
): Section => ({ botSlugs, id, name });

const DELETE_DESCRIPTION = /Its bots will move to No section/u;
const DIGIT = /\d/u;

let server: Server;

beforeEach(() => {
  ({ server } = installFakes());
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
  dndMock.listeners.clear();
  dndMock.operationListeners.clear();
  dndMock.resetOperation();
  vi.unstubAllGlobals();
});

async function renderBusy(
  initialSections: Section[] = [],
  bots = [alpha, beta, gamma]
) {
  await act(async () => {
    render(
      <ChatApp
        initial={bots}
        initialSections={initialSections}
        selected="alpha"
      />
    );
    await Promise.all([
      import("@/components/bot-sections-drag"),
      import("@/components/draggable-bot-row"),
      import("@/components/unassigned-bot-group"),
    ]);
  });
}

function sectionButton(name: string) {
  return screen.getByRole("button", { name });
}

function sectionRegion(name: string) {
  return screen.getByRole("region", { name });
}

function sectionHasBot(sectionName: string, botName: string) {
  return within(sectionRegion(sectionName)).getByRole("button", {
    name: botName,
  });
}

function dropBot(
  slug: string,
  sectionId: string | null,
  options: { canceled?: boolean; unknownTarget?: boolean } = {}
) {
  act(() => {
    const source = {
      data: { slug },
      id: `bot:${slug}`,
      type: "busy-bot",
    };
    const target = options.unknownTarget
      ? {
          data: { sectionId: "missing" },
          id: "section:missing",
          type: "busy-section",
        }
      : {
          data: { sectionId },
          id: `section:${sectionId ?? "none"}`,
          type: "busy-section",
        };
    dndMock.setOperation({ source, target });
    dndMock.emit({
      canceled: options.canceled ?? false,
      operation: {
        source,
        target,
      },
    });
    dndMock.resetOperation();
  });
}

function startBotDrag(slug: string) {
  act(() => {
    dndMock.setOperation({
      source: {
        data: { slug },
        id: `bot:${slug}`,
        type: "busy-bot",
      },
      target: null,
    });
  });
}

describe("sidebar sections", () => {
  it("groups bots with No section for unassigned bots", async () => {
    await renderBusy([section("sales", "Sales", ["alpha", "beta"])]);

    expect(sectionButton("Sales")).toBeTruthy();
    expect(sectionHasBot("Sales", "Alpha")).toBeTruthy();
    expect(sectionHasBot("Sales", "Beta")).toBeTruthy();
    expect(sectionHasBot("No section", "Gamma")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Section options: Sales" })
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Create section" })).toBeNull();
    expect(sectionButton("Sales").textContent).not.toMatch(DIGIT);
  });

  it("collapses a section without losing its bot rows", async () => {
    await renderBusy([section("sales", "Sales", ["alpha", "beta"])]);
    const group = sectionButton("Sales");
    expect(group.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(group);
    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
    fireEvent.click(group);
    expect(screen.getByRole("button", { name: "Alpha" })).toBeTruthy();
  });

  it("creates, renames and deletes a section while preserving its bot rows", async () => {
    const created = section("support", "Support", []);
    const renamed = section("support", "Customer support", []);
    server.once("POST", "/api/sections", json({ section: created }, 201));
    server.once("PATCH", "/api/sections/support", json({ section: renamed }));
    server.once("DELETE", "/api/sections/support", json({ ok: true }));
    await renderBusy();

    const botsNavigation = screen.getByRole("navigation", { name: "Bots" });
    expect(screen.queryByRole("button", { name: "Create section" })).toBeNull();
    fireEvent.contextMenu(botsNavigation);
    expect(server.to("POST", "/api/sections")).toHaveLength(0);
    expect(
      screen.getAllByRole("menuitem", { name: "Create section" })
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Create section" }));
    fireEvent.change(screen.getByLabelText("Section name"), {
      target: { value: "Support" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create section" }));
    await settle();
    expect(sectionButton("Support")).toBeTruthy();

    fireEvent.contextMenu(sectionButton("Support"));
    expect(
      screen.getAllByRole("menuitem", { name: "Create section" })
    ).toHaveLength(1);
    expect(
      screen.getByRole("menuitem", { name: "Rename section" })
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Delete section" })
    ).toBeTruthy();
    expect(server.to("POST", "/api/sections")).toHaveLength(1);
    expect(server.to("PATCH", "/api/sections/support")).toHaveLength(0);
    expect(server.to("DELETE", "/api/sections/support")).toHaveLength(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename section" }));
    fireEvent.change(screen.getByLabelText("Section name"), {
      target: { value: "Customer support" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename section" }));
    await settle();
    expect(sectionButton("Customer support")).toBeTruthy();

    fireEvent.contextMenu(sectionButton("Customer support"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete section" }));
    expect(screen.getByText(DELETE_DESCRIPTION)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete section" }));
    await settle();
    expect(screen.queryByText("Customer support")).toBeNull();
    expect(screen.getByRole("button", { name: "Alpha" })).toBeTruthy();
    expect(server.to("POST", "/api/sections")).toHaveLength(1);
    expect(server.to("PATCH", "/api/sections/support")).toHaveLength(1);
    expect(server.to("DELETE", "/api/sections/support")).toHaveLength(1);
  });

  it("moves a bot immediately while saving, including back to No section", async () => {
    const sales = section("sales", "Sales", ["alpha"]);
    const support = section("support", "Support", []);
    const move = held();
    const unassign = held();
    server.once(
      "PUT",
      "/api/bots/alpha/section",
      () => move.answer(),
      () => unassign.answer()
    );
    await renderBusy([sales, support]);

    expect(
      screen.queryByRole("button", { name: "Move Alpha to section" })
    ).toBeNull();
    expect(screen.getByRole("region", { name: "Support" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Draft alpha" }), {
      target: { value: "keep this draft" },
    });
    dropBot("alpha", "support");
    expect(
      within(sectionRegion("Sales")).queryByRole("button", {
        name: "Alpha",
      })
    ).toBeNull();
    expect(sectionHasBot("Support", "Alpha")).toBeTruthy();
    expect(
      (
        screen.getByRole("textbox", {
          name: "Draft alpha",
        }) as HTMLTextAreaElement
      ).value
    ).toBe("keep this draft");

    move.resolve(json({ ok: true }));
    await settle();
    expect(sectionHasBot("Support", "Alpha")).toBeTruthy();

    dropBot("alpha", null);
    expect(
      within(sectionRegion("Support")).queryByRole("button", {
        name: "Alpha",
      })
    ).toBeNull();
    expect(sectionHasBot("No section", "Alpha")).toBeTruthy();
    expect(server.to("PUT", "/api/bots/alpha/section")).toHaveLength(2);
    expect(server.to("PUT", "/api/bots/alpha/section").at(-1)?.body).toEqual({
      sectionId: null,
    });
    unassign.resolve(json({ ok: true }));
    await settle();
    expect(sectionHasBot("No section", "Alpha")).toBeTruthy();
  });

  it.each(["support", null])(
    "rolls back a failed drop to %s and allows retry",
    async (destination) => {
      const sales = section("sales", "Sales", ["alpha"]);
      const support = section("support", "Support", []);
      const response = held();
      server.once(
        "PUT",
        "/api/bots/alpha/section",
        () => response.answer(),
        json({ ok: true })
      );
      await renderBusy([sales, support]);

      dropBot("alpha", destination);
      expect(
        sectionHasBot(destination ? "Support" : "No section", "Alpha")
      ).toBeTruthy();
      response.resolve(json({ error: "Section is unavailable." }, 409));
      await settle();
      expect(sectionHasBot("Sales", "Alpha")).toBeTruthy();
      expect(
        within(sectionRegion("Support")).queryByRole("button", {
          name: "Alpha",
        })
      ).toBeNull();
      expect(screen.getByRole("alert").textContent).toContain(
        "Section is unavailable."
      );

      dropBot("alpha", destination);
      expect(
        sectionHasBot(destination ? "Support" : "No section", "Alpha")
      ).toBeTruthy();
      await settle();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(server.to("PUT", "/api/bots/alpha/section")).toHaveLength(2);
    }
  );

  it("accepts a drop on an empty collapsed destination", async () => {
    const sales = section("sales", "Sales", ["alpha"]);
    const support = section("support", "Support", []);
    server.on("PUT", "/api/bots/alpha/section", json({ ok: true }));
    await renderBusy([sales, support]);

    fireEvent.click(sectionButton("Support"));
    expect(sectionButton("Support").getAttribute("aria-expanded")).toBe(
      "false"
    );
    expect(screen.getByRole("region", { name: "Support" })).toBeTruthy();
    dropBot("alpha", "support");
    await settle();
    fireEvent.click(sectionButton("Support"));
    expect(sectionHasBot("Support", "Alpha")).toBeTruthy();
  });

  it("always keeps No section as a drop target when every bot is assigned", async () => {
    const sales = section("sales", "Sales", ["alpha"]);
    const support = section("support", "Support", ["beta"]);
    server.on("PUT", "/api/bots/alpha/section", json({ ok: true }));
    await renderBusy([sales, support], [alpha, beta]);

    expect(screen.queryByRole("region", { name: "No section" })).toBeNull();
    startBotDrag("alpha");
    expect(screen.getByRole("region", { name: "No section" })).toBeTruthy();
    dropBot("alpha", null);
    await settle();
    expect(
      within(sectionRegion("Sales")).queryByRole("button", {
        name: "Alpha",
      })
    ).toBeNull();
    expect(sectionHasBot("No section", "Alpha")).toBeTruthy();
    expect(server.to("PUT", "/api/bots/alpha/section").at(-1)?.body).toEqual({
      sectionId: null,
    });
  });

  it("does not write for a canceled, same-section or unknown drop", async () => {
    const sales = section("sales", "Sales", ["alpha"]);
    const support = section("support", "Support", []);
    server.on("PUT", "/api/bots/alpha/section", json({ ok: true }));
    await renderBusy([sales, support]);

    dropBot("alpha", "sales");
    dropBot("alpha", "support", { canceled: true });
    dropBot("alpha", "support", { unknownTarget: true });
    await settle();
    expect(server.to("PUT", "/api/bots/alpha/section")).toHaveLength(0);
    expect(sectionHasBot("Sales", "Alpha")).toBeTruthy();
    expect(
      within(sectionRegion("Support")).queryByRole("button", {
        name: "Alpha",
      })
    ).toBeNull();
  });

  it("ignores a second drop while the first move is busy", async () => {
    const sales = section("sales", "Sales", ["alpha"]);
    const support = section("support", "Support", []);
    const response = held();
    server.on("PUT", "/api/bots/alpha/section", () => response.answer());
    await renderBusy([sales, support], [alpha, beta]);

    dropBot("alpha", "support");
    dropBot("beta", "support");
    expect(server.to("PUT", "/api/bots/alpha/section")).toHaveLength(1);
    expect(server.to("PUT", "/api/bots/beta/section")).toHaveLength(0);
    response.resolve(json({ ok: true }));
    await settle(20);
    expect(sectionHasBot("Support", "Alpha")).toBeTruthy();
  });

  it("keeps each mounted chat draft while switching bots", async () => {
    await renderBusy([], [alpha, beta]);
    fireEvent.change(screen.getByRole("textbox", { name: "Draft alpha" }), {
      target: { value: "keep this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(
      (
        screen.getByRole("textbox", {
          name: "Draft alpha",
        }) as HTMLTextAreaElement
      ).value
    ).toBe("keep this");
  });

  it("keeps all bots reachable when the sidebar is collapsed", async () => {
    await renderBusy([section("sales", "Sales", ["alpha", "beta"])]);
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    const sidebar = screen.getByRole("complementary");
    expect(sidebar.getAttribute("data-collapsed")).toBe("true");
    expect(sidebar.querySelector(".busy-titlebar")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Beta" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gamma" })).toBeTruthy();
    expect(screen.queryByText("Sales")).toBeNull();
  });

  it("marks the title-bar shell only for Electron user agents", async () => {
    const userAgent = vi.spyOn(navigator, "userAgent", "get");
    userAgent.mockReturnValue("Mozilla/5.0");
    await renderBusy();
    expect(
      screen.getByRole("complementary").getAttribute("data-desktop-shell")
    ).toBeNull();

    cleanup();
    userAgent.mockReturnValue("Electron/40.0");
    await renderBusy();
    expect(
      screen.getByRole("complementary").getAttribute("data-desktop-shell")
    ).toBe("electron");
    userAgent.mockRestore();
  });

  it("shares section state with the mobile menu", async () => {
    const sales = section("sales", "Sales", ["alpha"]);
    const support = section("support", "Support", []);
    server.on("PUT", "/api/bots/beta/section", json({ ok: true }));
    await renderBusy([sales, support], [alpha, beta]);

    fireEvent.click(screen.getByRole("button", { name: "Bots" }));
    const mobile = screen.getByRole("dialog");
    expect(mobile).toBeTruthy();
    expect(within(mobile).getByRole("button", { name: "Sales" })).toBeTruthy();
    expect(
      within(mobile).getByRole("button", { name: "Support" })
    ).toBeTruthy();

    expect(
      within(mobile).getByRole("region", { name: "Support" })
    ).toBeTruthy();
    fireEvent.contextMenu(
      within(mobile).getByRole("navigation", { name: "Bots" })
    );
    expect(
      screen.getAllByRole("menuitem", { name: "Create section" })
    ).toHaveLength(1);
    expect(server.to("POST", "/api/sections")).toHaveLength(0);
    fireEvent.keyDown(document.body, { key: "Escape" });
    dropBot("beta", "support");
    await settle();
    expect(
      within(within(mobile).getByRole("region", { name: "Support" })).getByRole(
        "button",
        { name: "Beta" }
      )
    ).toBeTruthy();

    fireEvent.click(within(mobile).getByRole("button", { name: "Close" }));
    await settle(20);
    const [desktopNavigation] = screen.getAllByRole("navigation", {
      name: "Bots",
    });
    expect(desktopNavigation).toBeTruthy();
    expect(
      within(
        within(desktopNavigation as HTMLElement).getByRole("region", {
          name: "Support",
        })
      ).getByRole("button", { name: "Beta" })
    ).toBeTruthy();
  });
});
