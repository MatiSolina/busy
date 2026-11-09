// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it as test, vi } from "vitest";
import { ChatApp } from "@/components/chat-app";
import { initialBot } from "@/components/components.test-helpers";
import { McpMarketplace } from "@/components/mcp-marketplace";

vi.mock("@/components/chat-pane", () => ({ ChatPane: () => null }));
vi.mock("@/components/capabilities-panel", () => ({
  CapabilitiesPanel: ({ kind }: { kind: string }) => (
    <p>{`${kind} manager for app`}</p>
  ),
}));

const account = {
  account: { avatarUrl: null, name: "Matias Solina" },
  tokenPass: {
    dashboardUrl: "https://vercel.com",
    percentUsed: 12.5,
    status: "active",
  },
};

const hostPrefix = /^https?:\/\/[^/]+/u;

function FakeEventSource() {
  return {
    addEventListener() {
      // The navigation tests only need an EventSource-shaped object.
    },
    close() {
      // The navigation tests only need an EventSource-shaped object.
    },
    onerror: null,
  };
}

let request: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  request = vi.fn((input: RequestInfo | URL) => {
    const [path] = String(input).replace(hostPrefix, "").split("?");
    if (path === "/api/account") {
      return Response.json(account);
    }
    if (path === "/api/mcp") {
      return Response.json({ catalog: [], connections: [] });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  });
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("opens each capability manager for the app and keeps MCPs accessible", async () => {
  render(<McpMarketplace onOpenChange={vi.fn()} open />);
  expect(
    screen.getByRole("tab", { name: "MCPs" }).getAttribute("aria-selected")
  ).toBe("true");
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/mcp"));

  fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
  await screen.findByText("skill manager for app");
  expect(
    screen.getByRole("tab", { name: "Skills" }).getAttribute("aria-selected")
  ).toBe("true");
  expect(screen.queryByRole("textbox", { name: "Search MCPs" })).toBeNull();

  fireEvent.click(screen.getByRole("tab", { name: "Plugins" }));
  await screen.findByText("plugin manager for app");

  fireEvent.click(screen.getByRole("tab", { name: "MCPs" }));
  expect(screen.getByRole("textbox", { name: "Search MCPs" })).toBeTruthy();
});

test("opens the global marketplace when there are no bots", async () => {
  render(<ChatApp initial={[]} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Skills, plugins and MCPs" })
  );

  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Your toolbox")).toBeTruthy();
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/mcp"));
});

test("keeps the same app marketplace endpoint when switching bots", async () => {
  render(
    <ChatApp
      initial={[
        initialBot("lawyer", { name: "Lawyer" }),
        initialBot("research", { name: "Research" }),
      ]}
      selected="lawyer"
    />
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Skills, plugins and MCPs" })
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/mcp"));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));

  fireEvent.click(screen.getByRole("button", { name: "Research" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Skills, plugins and MCPs" })
  );
  await waitFor(() =>
    expect(
      request.mock.calls.filter(
        (call: unknown[]) => String(call[0]) === "/api/mcp"
      )
    ).toHaveLength(2)
  );
  expect(
    request.mock.calls.some((call: unknown[]) =>
      String(call[0]).includes("/api/bots/")
    )
  ).toBe(false);
});

test("keeps Skills, Plugins and MCPs as separate Settings sections", async () => {
  render(<ChatApp initial={[]} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Account menu: Matias Solina" })
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));

  const settingsTabs = await screen.findByRole("tablist", {
    name: "Settings sections",
  });
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(settingsTabs).getByRole("tab", { name: "Skills" }));
  const skillsPanel = within(dialog).getByRole("tabpanel", { name: "Skills" });
  await within(skillsPanel).findByText("skill manager for app");
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(within(skillsPanel).queryByText("plugin manager for app")).toBeNull();
  expect(
    within(skillsPanel).queryByRole("textbox", { name: "Search MCPs" })
  ).toBeNull();
  expect(
    screen.queryByRole("tablist", { name: "App capabilities" })
  ).toBeNull();

  fireEvent.click(within(settingsTabs).getByRole("tab", { name: "Plugins" }));
  const pluginsPanel = within(dialog).getByRole("tabpanel", {
    name: "Plugins",
  });
  await within(pluginsPanel).findByText("plugin manager for app");
  expect(within(pluginsPanel).queryByText("skill manager for app")).toBeNull();
  expect(
    within(pluginsPanel).queryByRole("textbox", { name: "Search MCPs" })
  ).toBeNull();

  fireEvent.click(within(settingsTabs).getByRole("tab", { name: "MCPs" }));
  const mcpsPanel = within(dialog).getByRole("tabpanel", { name: "MCPs" });
  await within(mcpsPanel).findByRole("textbox", { name: "Search MCPs" });
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/mcp"));
  expect(within(mcpsPanel).queryByText("skill manager for app")).toBeNull();
  expect(within(mcpsPanel).queryByText("plugin manager for app")).toBeNull();
  expect(
    screen.queryByRole("tablist", { name: "App capabilities" })
  ).toBeNull();

  fireEvent.change(
    within(mcpsPanel).getByRole("textbox", { name: "Search MCPs" }),
    {
      target: { value: "github" },
    }
  );

  fireEvent.click(within(settingsTabs).getByRole("tab", { name: "Usage" }));
  const usagePanel = within(dialog).getByRole("tabpanel", { name: "Usage" });
  expect(
    within(usagePanel).queryByRole("textbox", { name: "Search MCPs" })
  ).toBeNull();
  fireEvent.click(within(settingsTabs).getByRole("tab", { name: "MCPs" }));
  expect(
    (
      within(mcpsPanel).getByRole("textbox", {
        name: "Search MCPs",
      }) as HTMLInputElement
    ).value
  ).toBe("github");
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});
