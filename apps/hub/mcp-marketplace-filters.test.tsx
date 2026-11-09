// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type McpCatalogEntry,
  McpMarketplace,
  type PublicMcpConnection,
} from "@/components/mcp-marketplace";

const catalog: McpCatalogEntry[] = [
  {
    auth: "oauth",
    description: "Issues and projects.",
    icon: "/mcp-icons/linear.svg",
    id: "linear",
    name: "Linear",
    transport: "http",
  },
  {
    auth: "oauth",
    description: "Workspace pages and docs.",
    icon: "/mcp-icons/notion.svg",
    id: "notion",
    name: "Notion",
    transport: "http",
  },
  {
    auth: "none",
    description: "Library documentation.",
    icon: "/mcp-icons/context7.png",
    id: "context7",
    name: "Context7",
    transport: "http",
  },
  {
    auth: "oauth",
    description: "Repositories, issues, and pull requests.",
    icon: "/mcp-icons/github.svg",
    id: "github",
    name: "GitHub",
    transport: "http",
  },
  {
    auth: "oauth",
    description: "Search email.",
    icon: "/mcp-icons/gmail.svg",
    id: "gmail",
    name: "Gmail",
    oauthProvider: "google",
    transport: "http",
  },
];

const connection = (
  catalogId: string,
  status: PublicMcpConnection["status"]
): PublicMcpConnection => ({
  catalogId,
  error: status === "error" ? "Needs attention" : null,
  id: `connection_${catalogId}`,
  status,
});

const flush = async () => {
  await act(async () => {
    await Promise.all(Array.from({ length: 8 }, () => Promise.resolve()));
  });
};

let request: ReturnType<typeof vi.fn>;
const hostPrefix = /^https?:\/\/[^/]+/u;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  request = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(hostPrefix, "");
    const method = (init?.method ?? "GET").toUpperCase();
    if (path === "/api/mcp" && method === "GET") {
      return new Response(
        JSON.stringify({
          catalog,
          connections: [
            connection("linear", "connected"),
            connection("notion", "pending"),
            connection("github", "error"),
          ],
        }),
        { status: 200 }
      );
    }
    throw new Error(`unexpected request ${method} ${path}`);
  });
  vi.stubGlobal("fetch", request);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderMarketplace() {
  return render(
    <McpMarketplace navigate={vi.fn()} onOpenChange={vi.fn()} open />
  );
}

describe("MCP marketplace app filters", () => {
  it("shows only connected apps and excludes pending or failed connections", async () => {
    renderMarketplace();
    await flush();

    const allApps = screen.getByRole("button", { name: "All apps" });
    const connectedApps = screen.getByRole("button", {
      name: "Connected apps",
    });
    expect(allApps.getAttribute("aria-pressed")).toBe("true");
    expect(connectedApps.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Linear")).toBeTruthy();
    expect(screen.getByText("Notion")).toBeTruthy();
    expect(screen.getByText("Context7")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.queryByText("Gmail")).toBeNull();

    fireEvent.click(connectedApps);
    await flush();

    expect(allApps.getAttribute("aria-pressed")).toBe("false");
    expect(connectedApps.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Linear")).toBeTruthy();
    expect(screen.queryByText("Notion")).toBeNull();
    expect(screen.queryByText("GitHub")).toBeNull();
    expect(screen.queryByText("Context7")).toBeNull();
  });

  it("combines the connected filter with search and returns to all apps", async () => {
    renderMarketplace();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Connected apps" }));
    await flush();
    fireEvent.change(screen.getByPlaceholderText("Search tools"), {
      target: { value: "notion" },
    });
    expect(screen.queryByText("Linear")).toBeNull();
    expect(screen.queryByText("Notion")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Search tools"), {
      target: { value: "linear" },
    });
    expect(screen.getByText("Linear")).toBeTruthy();
    expect(screen.queryByText("Notion")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All apps" }));
    await flush();
    fireEvent.change(screen.getByPlaceholderText("Search tools"), {
      target: { value: "context" },
    });
    expect(screen.getByText("Context7")).toBeTruthy();
    expect(screen.queryByText("Linear")).toBeNull();
  });

  it("handles an empty connected view without losing the all apps view", async () => {
    request.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace(hostPrefix, "");
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/api/mcp" && method === "GET") {
          return new Response(JSON.stringify({ catalog, connections: [] }), {
            status: 200,
          });
        }
        throw new Error(`unexpected request ${method} ${path}`);
      }
    );

    renderMarketplace();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Connected apps" }));
    await flush();

    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.queryByText("Linear")).toBeNull();
    expect(screen.queryByText("Context7")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Connected apps" })
        .getAttribute("aria-pressed")
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "All apps" }));
    await flush();
    expect(screen.getByText("Linear")).toBeTruthy();
    expect(screen.getByText("Context7")).toBeTruthy();
  });
});
