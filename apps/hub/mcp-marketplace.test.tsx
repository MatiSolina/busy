// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatApp } from "@/components/chat-app";
import { initialBot } from "@/components/components.test-helpers";
import {
  type McpCatalogEntry,
  McpMarketplace,
  type PublicMcpConnection,
} from "@/components/mcp-marketplace";
import { McpProviderSetup } from "@/components/mcp-provider-setup";

vi.mock("@/components/live-view", () => ({ LiveView: () => null }));

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

const hostPrefix = /^https?:\/\/[^/]+/u;
const GET_ISSUE_RE = /get_issue/u;
const LIST_ISSUES_RE = /list_issues/u;

let callbackFactHandler: ((event: { data: string }) => void) | undefined;

function CallbackEventSource() {
  return {
    addEventListener(type: string, handler: (event: { data: string }) => void) {
      if (type === "fact") {
        callbackFactHandler = handler;
      }
    },
    close() {
      // The callback test only needs an EventSource-shaped object.
    },
  };
}

function requestPath(input: RequestInfo | URL) {
  const [path] = String(input).replace(hostPrefix, "").split("?");
  return path;
}

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
  request = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      return new Response(JSON.stringify({ catalog, connections: [] }), {
        status: 200,
      });
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
    throw new Error(`unexpected request ${method} ${path}`);
  });
  vi.stubGlobal("fetch", request);
  navigate = vi.fn<(url: string) => void>();
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

function renderMarketplace(
  over: Partial<React.ComponentProps<typeof McpMarketplace>> = {}
) {
  return render(
    <McpMarketplace navigate={navigate} onOpenChange={vi.fn()} open {...over} />
  );
}

function openDetails(name: string) {
  const card = catalogItem(name);
  fireEvent.click(
    within(card).getByRole("button", { name: `View ${name} details` })
  );
  return screen.getByRole("button", { name: "Back to integrations" });
}

function catalogItem(name: string) {
  const card = screen.getByText(name).closest("li");
  if (!card) {
    throw new Error(`Missing catalog item: ${name}`);
  }
  return card;
}

describe("MCP marketplace", () => {
  it("edits the reviewed tool allowlist from connection details", async () => {
    const tools = [
      {
        description: "List issues",
        name: "list_issues",
        readOnlyHint: true,
      },
      {
        description: "Read one issue",
        name: "get_issue",
        readOnlyHint: true,
      },
    ];
    request.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestPath(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET") {
          return new Response(
            JSON.stringify({
              catalog,
              connections: [
                connection({ allowedTools: ["list_issues"], tools }),
              ],
            }),
            { status: 200 }
          );
        }
        if (path === "/api/mcp/conn_linear" && method === "PATCH") {
          return new Response(
            JSON.stringify({
              connection: connection({ allowedTools: ["get_issue"], tools }),
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      }
    );

    renderMarketplace();
    await flush();
    openDetails("Linear");
    const listIssues = screen.getByRole("checkbox", { name: LIST_ISSUES_RE });
    fireEvent.click(listIssues);
    fireEvent.click(screen.getByRole("checkbox", { name: GET_ISSUE_RE }));
    fireEvent.click(screen.getByRole("button", { name: "Save tools" }));
    await flush();

    expect(request).toHaveBeenCalledWith(
      "/api/mcp/conn_linear",
      expect.objectContaining({
        body: JSON.stringify({ allowedTools: ["get_issue"] }),
        method: "PATCH",
      })
    );
  });

  it("loads, filters the catalog, and starts OAuth in the current tab", async () => {
    renderMarketplace();
    await flush();

    expect(request).toHaveBeenCalledWith("/api/mcp");
    expect(screen.getByText("Linear")).toBeTruthy();
    expect(screen.getByText("Context7")).toBeTruthy();
    expect(
      document.querySelector('img[src="/mcp-icons/linear.svg"]')
    ).toBeTruthy();
    expect(
      document.querySelector('img[src="/mcp-icons/context7.png"]')
    ).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Search tools"), {
      target: { value: "linear" },
    });
    expect(screen.getByText("Linear")).toBeTruthy();
    expect(screen.queryByText("Context7")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Connect with OAuth" }));
    await flush();
    expect(request).toHaveBeenCalledWith(
      "/api/mcp",
      expect.objectContaining({
        body: JSON.stringify({ catalogId: "linear" }),
        method: "POST",
      })
    );
    expect(navigate).toHaveBeenCalledWith("/api/mcp/conn_linear/connect");
  });

  it("requires provider setup before connecting and never renders the saved secret", async () => {
    let configured = false;
    let savedProviderBody: unknown;
    request.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestPath(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/api/mcp" && method === "GET") {
          const nextCatalog = catalog.map((entry) =>
            entry.id === "github" ? { ...entry, configured } : entry
          );
          return new Response(
            JSON.stringify({ catalog: nextCatalog, connections: [] }),
            { status: 200 }
          );
        }
        if (path === "/api/mcp/providers/github" && method === "GET") {
          return new Response(
            JSON.stringify({
              clientId: configured ? "gh-client" : null,
              configured,
              docsUrl: "https://docs.github.com/en/apps/oauth-apps",
              provider: "github",
              redirectUri: "https://busy.example/api/mcp/callback",
              setupUrl: "https://github.com/settings/developers",
              version: configured ? "v1" : null,
            }),
            { status: 200 }
          );
        }
        if (path === "/api/mcp/providers/github" && method === "PUT") {
          savedProviderBody = JSON.parse(String(init?.body)) as {
            clientId: string;
            clientSecret: string;
          };
          configured = true;
          return new Response(
            JSON.stringify({
              clientId: "gh-client",
              configured: true,
              docsUrl: "https://docs.github.com/en/apps/oauth-apps",
              provider: "github",
              redirectUri: "https://busy.example/api/mcp/callback",
              setupUrl: "https://github.com/settings/developers",
              version: "v1",
            }),
            { status: 200 }
          );
        }
        if (path === "/api/mcp" && method === "POST") {
          return new Response(
            JSON.stringify({
              connection: connection({
                catalogId: "github",
                id: "conn_github",
                status: "pending",
              }),
              connectUrl: "/api/mcp/conn_github/connect",
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      }
    );

    renderMarketplace();
    await flush();
    const githubCard = catalogItem("GitHub");
    expect(
      within(githubCard).getByRole("button", { name: "Set up GitHub" })
    ).toBeTruthy();

    openDetails("GitHub");
    expect(
      (
        screen.getByRole("button", {
          name: "Connect with OAuth",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Set up GitHub" }));
    await flush();
    const setup = screen.getByRole("dialog", { name: "Set up GitHub" });
    fireEvent.change(within(setup).getByLabelText("OAuth client ID"), {
      target: { value: "gh-client" },
    });
    fireEvent.change(within(setup).getByLabelText("Client secret"), {
      target: { value: "super-secret" },
    });
    fireEvent.click(within(setup).getByRole("button", { name: "Save setup" }));
    await flush();

    expect(document.body.textContent).not.toContain("super-secret");
    expect(screen.queryByDisplayValue("super-secret")).toBeNull();
    expect(savedProviderBody).toEqual({
      clientId: "gh-client",
      clientSecret: "super-secret",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Back to integrations" })
    );
    const configuredCard = catalogItem("GitHub");
    expect(
      within(configuredCard).getByRole("button", { name: "Connect with OAuth" })
    ).toBeTruthy();
    fireEvent.click(
      within(configuredCard).getByRole("button", { name: "Connect with OAuth" })
    );
    await flush();
    expect(request).toHaveBeenCalledWith(
      "/api/mcp",
      expect.objectContaining({
        body: JSON.stringify({ catalogId: "github" }),
        method: "POST",
      })
    );
  });

  it("ignores a late provider response after switching setup", async () => {
    let resolveGithub!: (response: Response) => void;
    const githubResponse = new Promise<Response>((resolve) => {
      resolveGithub = resolve;
    });
    request.mockImplementation((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === "/api/mcp/providers/github") {
        return githubResponse;
      }
      if (path === "/api/mcp/providers/google") {
        return new Response(
          JSON.stringify({
            clientId: "google-client",
            configured: true,
            docsUrl: "https://developers.google.com/identity/protocols/oauth2",
            provider: "google",
            redirectUri: "https://busy.example/google/callback",
            setupUrl: "https://console.cloud.google.com",
            version: "v1",
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ catalog, connections: [] }), {
        status: 200,
      });
    });
    const view = render(
      <McpProviderSetup
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
        open
        provider="github"
      />
    );
    await flush();
    view.rerender(
      <McpProviderSetup
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
        open
        provider="google"
      />
    );
    await flush();
    expect(screen.getByRole("dialog", { name: "Set up Google" })).toBeTruthy();
    expect(
      (screen.getByLabelText("OAuth client ID") as HTMLInputElement).value
    ).toBe("google-client");

    resolveGithub(
      new Response(
        JSON.stringify({
          clientId: "github-client",
          configured: true,
          docsUrl: "https://docs.github.com/en/apps/oauth-apps",
          provider: "github",
          redirectUri: "https://busy.example/github/callback",
          setupUrl: "https://github.com/settings/developers",
          version: "v1",
        }),
        { status: 200 }
      )
    );
    await flush();
    expect(screen.getByRole("dialog", { name: "Set up Google" })).toBeTruthy();
    expect(
      (screen.getByLabelText("OAuth client ID") as HTMLInputElement).value
    ).toBe("google-client");
  });

  it("refreshes after returning from OAuth and keeps disconnect enabled", async () => {
    const isConnected = vi.fn<() => boolean>().mockReturnValue(false);
    request.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET") {
          return new Response(
            JSON.stringify({
              catalog,
              connections: isConnected() ? [connection()] : [],
            }),
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
        return new Response(null, { status: 204 });
      }
    );
    renderMarketplace();
    await flush();
    const linearCard = catalogItem("Linear");
    fireEvent.click(
      within(linearCard).getByRole("button", { name: "Connect with OAuth" })
    );
    await flush();
    expect(
      screen.getByRole("button", { name: "Continue sign-in" })
    ).toBeTruthy();

    isConnected.mockReturnValue(true);
    await act(async () => window.dispatchEvent(new Event("focus")));
    await flush();
    openDetails("Linear");
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await flush();
    expect(request).toHaveBeenCalledWith("/api/mcp/conn_linear", {
      method: "DELETE",
    });
  });

  it("recovers the connect action after a failed OAuth start", async () => {
    let attempts = 0;
    request.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET") {
          return new Response(JSON.stringify({ catalog, connections: [] }), {
            status: 200,
          });
        }
        attempts += 1;
        if (method === "POST" && attempts === 1) {
          return new Response("temporarily unavailable", { status: 503 });
        }
        if (method === "POST") {
          return new Response(
            JSON.stringify({ connection: connection(), connectUrl: null }),
            { status: 200 }
          );
        }
        return new Response(null, { status: 204 });
      }
    );
    renderMarketplace();
    await flush();
    const linearCard = catalogItem("Linear");
    fireEvent.click(
      within(linearCard).getByRole("button", { name: "Connect with OAuth" })
    );
    await flush();
    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn't connect Linear"
    );
    openDetails("Linear");
    fireEvent.click(screen.getByRole("button", { name: "Connect with OAuth" }));
    await flush();
    expect(attempts).toBe(2);
    expect(screen.getAllByText("Connected").length).toBeGreaterThan(0);
  });

  it("lets the user cancel a pending consent or remove a failed connection", async () => {
    let status: PublicMcpConnection["status"] = "pending";
    request.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET") {
          return new Response(
            JSON.stringify({
              catalog,
              connections: [
                connection({
                  error: status === "error" ? "expired" : null,
                  status,
                }),
              ],
            }),
            { status: 200 }
          );
        }
        if (method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 204 });
      }
    );
    renderMarketplace();
    await flush();
    openDetails("Linear");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();
    expect(request).toHaveBeenCalledWith("/api/mcp/conn_linear", {
      method: "DELETE",
    });
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    // A failed row exposes the same destructive cleanup affordance as a
    // pending row, while retaining Reconnect for a fresh OAuth attempt.
    status = "error";
    request.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET") {
          return new Response(
            JSON.stringify({
              catalog,
              connections: [connection({ error: "expired", status: "error" })],
            }),
            { status: 200 }
          );
        }
        return new Response(null, { status: 204 });
      }
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await flush();
    // Reopen through a fresh component so the GET reflects the failed row.
    cleanup();
    renderMarketplace();
    await flush();
    openDetails("Linear");
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await flush();
    expect(request).toHaveBeenCalledWith("/api/mcp/conn_linear", {
      method: "DELETE",
    });
  });

  it("shows and removes duplicate app connections for the same service", async () => {
    request.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET") {
          return new Response(
            JSON.stringify({
              catalog,
              connections: [
                connection({ id: "conn_a" }),
                connection({ id: "conn_b" }),
              ],
            }),
            { status: 200 }
          );
        }
        if (method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 204 });
      }
    );
    renderMarketplace();
    await flush();
    openDetails("Linear");
    expect(screen.getByText("Additional app connections")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Disconnect Linear connection 2" })
    );
    await flush();
    expect(request).toHaveBeenCalledWith("/api/mcp/conn_b", {
      method: "DELETE",
    });
  });

  it("reconnects a duplicate grant by ID without replacing the primary grant", async () => {
    let reconnectBody: unknown;
    request.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET") {
          return new Response(
            JSON.stringify({
              catalog,
              connections: [
                connection({ id: "conn_a" }),
                connection({ error: "expired", id: "conn_b", status: "error" }),
              ],
            }),
            { status: 200 }
          );
        }
        if (method === "POST") {
          reconnectBody = JSON.parse(String(init?.body));
          return new Response(
            JSON.stringify({
              connection: connection({ id: "conn_b", status: "pending" }),
              connectUrl: "/api/mcp/conn_b/connect",
            }),
            { status: 200 }
          );
        }
        return new Response(null, { status: 204 });
      }
    );
    renderMarketplace();
    await flush();
    openDetails("Linear");

    fireEvent.click(
      screen.getByRole("button", { name: "Reconnect Linear connection 2" })
    );
    await flush();

    expect(reconnectBody).toEqual({
      catalogId: "linear",
      connectionId: "conn_b",
    });
    expect(navigate).toHaveBeenCalledWith("/api/mcp/conn_b/connect");
    expect(
      screen.getByRole("button", {
        name: "Continue sign-in Linear connection 2",
      })
    ).toBeTruthy();
  });

  it("keeps a callback-open marketplace visible through a chat state update", async () => {
    window.history.replaceState(null, "", "/?mcp=connected");
    callbackFactHandler = undefined;
    vi.stubGlobal("EventSource", CallbackEventSource);
    render(
      <ChatApp
        initial={[initialBot("lawyer", { status: "ready" })]}
        selected="lawyer"
      />
    );
    await flush();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("MCP connected");

    act(() => {
      callbackFactHandler?.({
        data: JSON.stringify({
          data: { data: {}, type: "turn.started" },
          index: 0,
          line: 1,
          type: "turn.started",
        }),
      });
    });
    await flush();
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await flush();
    expect(window.location.pathname).toBe("/");
    expect(new URLSearchParams(window.location.search).has("mcp")).toBe(false);
  });

  it("disconnects an existing connection and reports a failed removal", async () => {
    request.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET") {
          return new Response(
            JSON.stringify({ catalog, connections: [connection()] }),
            { status: 200 }
          );
        }
        if (method === "DELETE") {
          return new Response("no", { status: 500 });
        }
        return new Response(null, { status: 204 });
      }
    );
    renderMarketplace();
    await flush();
    openDetails("Linear");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await flush();
    expect(request).toHaveBeenCalledWith("/api/mcp/conn_linear", {
      method: "DELETE",
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn't disconnect Linear"
    );
    expect(screen.getAllByText("Connected").length).toBeGreaterThan(0);
  });
});
