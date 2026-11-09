// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useCallback, useState } from "react";
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
    docsUrl: "https://linear.app/docs/mcp",
    icon: "/mcp-icons/linear.svg",
    id: "linear",
    name: "Linear",
    transport: "http",
  },
  {
    auth: "none",
    description: "Library documentation.",
    docsUrl: "https://context7.com/docs/installation",
    icon: "/mcp-icons/context7.png",
    id: "context7",
    name: "Context7",
    transport: "http",
  },
  {
    auth: "oauth",
    configured: false,
    description: "Repositories, issues, and pull requests.",
    docsUrl: "https://docs.github.com/en/apps/oauth-apps",
    icon: "/mcp-icons/github.svg",
    id: "github",
    name: "GitHub",
    oauthProvider: "github",
    transport: "http",
  },
];
const ADD_SKILL_RE = /Add skill/u;

const connection = (
  over: Partial<PublicMcpConnection> = {}
): PublicMcpConnection => ({
  catalogId: "linear",
  error: null,
  id: "conn_linear",
  status: "connected",
  ...over,
});

const flush = async () => {
  await act(async () => {
    await Promise.all(Array.from({ length: 8 }, () => Promise.resolve()));
  });
};

let request: ReturnType<typeof vi.fn>;
let navigate: (url: string) => void;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  request = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      return new Response(
        JSON.stringify({ catalog, connections: [connection()] }),
        { status: 200 }
      );
    }
    if (method === "POST") {
      return new Response(
        JSON.stringify({
          connection: connection({ status: "pending" }),
          connectUrl: "/api/mcp/conn_linear/connect",
        }),
        { status: 200 }
      );
    }
    if (method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request ${method}`);
  });
  vi.stubGlobal("fetch", request);
  navigate = vi.fn<(url: string) => void>();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderMarketplace() {
  return render(
    <McpMarketplace navigate={navigate} onOpenChange={vi.fn()} open />
  );
}

function detailsButton(name: string) {
  const item = catalogItem(name);
  return within(item).getByRole("button", { name: `View ${name} details` });
}

function catalogItem(name: string) {
  const item = screen.getByText(name).closest("li");
  if (!item) {
    throw new Error(`Missing catalog item: ${name}`);
  }
  return item;
}

function ControlledMarketplaceHarness() {
  const [open, setOpen] = useState(true);
  const reopen = useCallback(() => setOpen(true), []);
  return (
    <>
      <button onClick={reopen} type="button">
        Reopen integrations
      </button>
      <McpMarketplace navigate={navigate} onOpenChange={setOpen} open={open} />
    </>
  );
}

describe("MCP integration details", () => {
  it("opens from a tile and returns to the catalog with search and focus preserved", async () => {
    renderMarketplace();
    await flush();

    fireEvent.change(screen.getByPlaceholderText("Search tools"), {
      target: { value: "linear" },
    });
    const opener = detailsButton("Linear");
    opener.focus();
    fireEvent.click(opener);

    expect(screen.getByText("Issues and projects.")).toBeTruthy();
    expect(screen.getByText("Information")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Back to integrations" })
    ).toBeTruthy();
    expect(screen.queryByText("Context7")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Back to integrations" })
    );
    expect(
      (screen.getByPlaceholderText("Search tools") as HTMLInputElement).value
    ).toBe("linear");
    expect(detailsButton("Linear")).toBeTruthy();
    expect(document.activeElement).toBe(detailsButton("Linear"));
  });

  it("keeps the catalog Connect action separate from opening details", async () => {
    renderMarketplace();
    await flush();

    const item = catalogItem("Context7");
    fireEvent.click(within(item).getByRole("button", { name: "Add" }));
    await flush();

    expect(request).toHaveBeenCalledWith(
      "/api/mcp",
      expect.objectContaining({ method: "POST" })
    );
    expect(
      screen.queryByRole("button", { name: "Back to integrations" })
    ).toBeNull();
  });

  it("keeps an in-progress skill draft while opening MCP details", async () => {
    renderMarketplace();
    await flush();

    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    // Base UI opens Menu.Root on the native pointer-down event. A bare
    // synthetic click is timing-sensitive when this dynamically imported panel
    // is mounted alongside the rest of the component suite.
    const addSkill = await screen.findByRole("button", { name: ADD_SKILL_RE });
    await waitFor(() => expect(addSkill.hasAttribute("disabled")).toBe(false));
    fireEvent.mouseDown(addSkill);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Create skill" })
    );
    await flush();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "review" },
    });

    fireEvent.click(screen.getByRole("tab", { name: "MCPs" }));
    fireEvent.click(detailsButton("Linear"));
    fireEvent.click(
      screen.getByRole("button", { name: "Back to integrations" })
    );
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "review"
    );
  });

  it("preserves the connected filter and query when returning from details", async () => {
    renderMarketplace();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Connected apps" }));
    fireEvent.change(screen.getByPlaceholderText("Search tools"), {
      target: { value: "linear" },
    });
    fireEvent.click(detailsButton("Linear"));
    fireEvent.click(
      screen.getByRole("button", { name: "Back to integrations" })
    );

    expect(
      screen
        .getByRole("button", { name: "Connected apps" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      (screen.getByPlaceholderText("Search tools") as HTMLInputElement).value
    ).toBe("linear");
    expect(screen.queryByText("Context7")).toBeNull();
  });

  it("keeps focus on a detail control when the marketplace refreshes on window focus", async () => {
    renderMarketplace();
    await flush();
    fireEvent.click(detailsButton("Linear"));

    const documentation = screen.getByRole("link", {
      name: "Linear documentation",
    });
    documentation.focus();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();

    expect(document.activeElement).toBe(documentation);
  });

  it("resets to the catalog after closing and reopening the controlled marketplace", async () => {
    render(<ControlledMarketplaceHarness />);
    await flush();
    fireEvent.click(detailsButton("Linear"));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(
      screen.queryByRole("button", { name: "Back to integrations" })
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Reopen integrations" })
    );
    await flush();
    expect(
      screen.queryByRole("button", { name: "Back to integrations" })
    ).toBeNull();
    expect(detailsButton("Linear")).toBeTruthy();
  });

  it("moves connected actions into the detail view and never renders OAuth secrets", async () => {
    renderMarketplace();
    await flush();

    const item = catalogItem("Linear");
    expect(
      within(item).queryByRole("button", { name: "Disconnect" })
    ).toBeNull();
    fireEvent.click(detailsButton("Linear"));

    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(screen.getAllByText("Connected").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("oauthData");
    expect(document.body.textContent).not.toContain("access_token");

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await flush();
    expect(request).toHaveBeenCalledWith("/api/mcp/conn_linear", {
      method: "DELETE",
    });
  });

  it("opens setup from a provider tile before showing the provider form", async () => {
    renderMarketplace();
    await flush();

    const github = catalogItem("GitHub");
    fireEvent.click(
      within(github).getByRole("button", { name: "Set up GitHub" })
    );
    expect(
      screen.getByRole("button", { name: "Back to integrations" })
    ).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Set up GitHub" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Set up GitHub" }));
    await flush();
    expect(screen.getByRole("dialog", { name: "Set up GitHub" })).toBeTruthy();
  });
});
