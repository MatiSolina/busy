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
  CodeRepositorySetupCard,
  openMcpConnectUrl,
} from "@/components/code-repository-setup-card";
import type { ChatItem } from "@/lib/chat/items";

type SetupItem = Extract<ChatItem, { kind: "interaction" }>;
const CONTINUE = /Continue with/u;

vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

const repository = {
  connectionId: "github-1",
  defaultBranch: "main",
  enabled: true,
  fullName: "acme/app",
  id: "repo-1",
};

const item: SetupItem = {
  allowFreeform: false,
  id: "interaction-1",
  interactionId: "interaction-1",
  kind: "interaction",
  options: [],
  origin: {
    callName: "prepare_code_repository",
    interactionId: "interaction-1",
    sessionId: "session-1",
  },
  prompt: "Choose a repository",
  setup: "code-repository",
  state: "open",
  type: "question",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function installMetadataFetch({
  connections = [{ id: "github-1", label: "GitHub" }],
  discovered = [],
  discoveryStatus = 200,
  marketplaceConnection,
  marketplaceConnectUrl = "/api/mcp/github-1/connect?ticket=ticket-1",
  putStatus = 200,
  reconnectUrl = "/api/mcp/github-1/connect?ticket=ticket-1",
  repositories = [repository],
}: {
  connections?: { id: string; label: string }[];
  discovered?: {
    defaultBranch: string;
    fullName: string;
    githubId: string;
    private: boolean;
  }[];
  discoveryStatus?: number;
  marketplaceConnection?: { catalogId: string; id: string };
  marketplaceConnectUrl?: string | null;
  putStatus?: number;
  reconnectUrl?: string;
  repositories?: (typeof repository)[];
} = {}) {
  const request = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/mcp" && init?.method === "POST") {
      return Promise.resolve(
        json({
          connection: marketplaceConnection,
          connectUrl: marketplaceConnectUrl,
        })
      );
    }
    if (url.startsWith("/api/mcp/") && init?.method === "POST") {
      return Promise.resolve(json({ connectUrl: reconnectUrl }));
    }
    if (
      url.startsWith("/api/bots/builder/code-repository") &&
      init?.method === "PUT"
    ) {
      return Promise.resolve(json({ repository }, putStatus));
    }
    if (url.startsWith("/api/bots/builder/code-repository")) {
      return Promise.resolve(
        json({
          activeRepositoryId: repositories[0]?.id ?? null,
          connections,
          repositories,
        })
      );
    }
    if (url === "/api/code-repositories" && init?.method === "POST") {
      const requestBody = JSON.parse(String(init.body)) as {
        connectionId: string;
        fullName: string;
      };
      return Promise.resolve(
        json(
          {
            repository: {
              ...repository,
              connectionId: requestBody.connectionId,
              fullName: requestBody.fullName,
              id: "repo-2",
            },
          },
          201
        )
      );
    }
    if (url.startsWith("/api/code-repositories/github?")) {
      return Promise.resolve(
        json(
          discoveryStatus === 200
            ? { nextPage: null, repositories: discovered }
            : { error: "Reconnect GitHub before browsing repositories." },
          discoveryStatus
        )
      );
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  });
  vi.stubGlobal("fetch", request);
  return request;
}

const answer =
  vi.fn<(value: { optionId?: string; text?: string }) => Promise<boolean>>();

beforeEach(() => {
  window.history.replaceState(null, "", "/b/builder");
  answer.mockReset();
  answer.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CodeRepositorySetupCard", () => {
  it("shows the OAuth callback failure and keeps it visible after metadata refresh", async () => {
    window.history.replaceState(null, "", "/b/builder?codeSetup=error");
    const request = installMetadataFetch({ connections: [], repositories: [] });
    render(
      <CodeRepositorySetupCard
        answer={answer}
        botSlug="builder"
        item={item}
        pending={false}
        state="open"
      />
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "GitHub sign-in did not finish"
    );
    expect(
      await screen.findByRole("button", { name: "Connect GitHub" })
    ).toBeTruthy();
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert").textContent).toContain(
      "GitHub sign-in did not finish"
    );
    expect(answer).not.toHaveBeenCalled();
  });

  it("clears the previous callback error when retrying and preserves other URL state", async () => {
    window.history.replaceState(
      { pane: "chat" },
      "",
      "/b/builder?codeSetup=error&keep=1#repository"
    );
    installMetadataFetch({ connections: [], repositories: [] });
    const assign = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => undefined);
    render(
      <CodeRepositorySetupCard
        answer={answer}
        botSlug="builder"
        item={item}
        pending={false}
        state="open"
      />
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "GitHub sign-in did not finish"
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect GitHub" })
    );
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(window.location.pathname).toBe("/b/builder");
    expect(window.location.search).toBe("?keep=1");
    expect(window.location.hash).toBe("#repository");
    expect(window.history.state).toEqual({ pane: "chat" });
    expect(answer).not.toHaveBeenCalled();
  });

  it.each([
    { path: "/b/other?codeSetup=error", state: "open" },
    { path: "/b/builder?codeSetup=error", state: "answered" },
    { path: "/b/builder", state: "open" },
  ])(
    "does not show callback errors for $path when $state",
    async ({ path, state }) => {
      window.history.replaceState(null, "", path);
      installMetadataFetch({ connections: [], repositories: [] });
      render(
        <CodeRepositorySetupCard
          answer={answer}
          botSlug="builder"
          item={item}
          pending={false}
          state={state}
        />
      );

      if (state === "open") {
        await screen.findByRole("button", { name: "Connect GitHub" });
      }
      expect(screen.queryByRole("alert")).toBeNull();
    }
  );

  it("loads the server repository identity and submits that id", async () => {
    const request = installMetadataFetch();
    render(
      <CodeRepositorySetupCard
        answer={answer}
        botSlug="builder"
        item={item}
        pending={false}
        state="open"
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: CONTINUE }));
    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith({ text: "repo-1" })
    );
    expect(
      request.mock.calls.some(
        ([url, init]) =>
          String(url) === "/api/bots/builder/code-repository" &&
          init?.method === "PUT"
      )
    ).toBe(true);
  });

  it("keeps the catalog repository id when discovery has the same full name", async () => {
    const request = installMetadataFetch({
      discovered: [
        {
          defaultBranch: "main",
          fullName: repository.fullName,
          githubId: "github-42",
          private: true,
        },
      ],
    });
    render(
      <CodeRepositorySetupCard
        answer={answer}
        botSlug="builder"
        item={item}
        pending={false}
        state="open"
      />
    );

    fireEvent.click(await screen.findByRole("option", { name: "acme/app" }));
    fireEvent.click(await screen.findByRole("button", { name: CONTINUE }));
    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith({ text: "repo-1" })
    );
    expect(
      request.mock.calls.some(
        ([url]) => String(url) === "/api/code-repositories"
      )
    ).toBe(false);
  });

  it("does not answer when selecting the repository fails", async () => {
    installMetadataFetch({ putStatus: 409 });
    render(
      <CodeRepositorySetupCard
        answer={answer}
        botSlug="builder"
        item={item}
        pending={false}
        state="open"
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: CONTINUE }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(answer).not.toHaveBeenCalled();
  });

  it("discovers from the selected GitHub connection", async () => {
    const request = installMetadataFetch({
      connections: [
        { id: "github-1", label: "GitHub" },
        { id: "github-2", label: "GitHub 2" },
      ],
    });
    render(
      <CodeRepositorySetupCard
        answer={answer}
        botSlug="builder"
        item={item}
        pending={false}
        state="open"
      />
    );

    const selector = await screen.findByRole("combobox", {
      name: "GitHub connection",
    });
    fireEvent.change(selector, { target: { value: "github-2" } });
    await waitFor(() =>
      expect(
        request.mock.calls.some(([url]) =>
          String(url).includes("connectionId=github-2")
        )
      ).toBe(true)
    );
  });

  it("does not reuse a same-name repository from another connection", async () => {
    const request = installMetadataFetch({
      connections: [
        { id: "github-1", label: "GitHub" },
        { id: "github-2", label: "GitHub 2" },
      ],
      discovered: [
        {
          defaultBranch: "main",
          fullName: repository.fullName,
          githubId: "github-42",
          private: true,
        },
      ],
    });
    render(
      <CodeRepositorySetupCard
        answer={answer}
        botSlug="builder"
        item={item}
        pending={false}
        state="open"
      />
    );

    fireEvent.change(
      await screen.findByRole("combobox", { name: "GitHub connection" }),
      { target: { value: "github-2" } }
    );
    fireEvent.click(await screen.findByRole("option", { name: "acme/app" }));
    fireEvent.click(await screen.findByRole("button", { name: CONTINUE }));

    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith({ text: "repo-2" })
    );
    expect(
      request.mock.calls.some(
        ([url, init]) =>
          String(url) === "/api/code-repositories" &&
          init?.method === "POST" &&
          JSON.parse(String(init.body)).connectionId === "github-2"
      )
    ).toBe(true);
  });

  it("keeps reconnect available after discovery reports a revoked connection", async () => {
    installMetadataFetch({ discoveryStatus: 409 });
    render(
      <CodeRepositorySetupCard
        answer={answer}
        botSlug="builder"
        item={item}
        pending={false}
        state="open"
      />
    );

    expect(
      await screen.findByRole("button", { name: "Reconnect GitHub" })
    ).toBeTruthy();
  });

  it("reconnects a known GitHub connection through its explicit OAuth endpoint", async () => {
    const request = installMetadataFetch({ discoveryStatus: 409 });
    const assign = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => undefined);
    render(
      <CodeRepositorySetupCard
        answer={answer}
        botSlug="builder"
        item={item}
        pending={false}
        state="open"
      />
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Reconnect GitHub" })
    );
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        "http://localhost:3000/api/mcp/github-1/connect?ticket=ticket-1&returnTo=%2Fb%2Fbuilder"
      )
    );
    expect(
      request.mock.calls.some(
        ([url, init]) =>
          String(url) === "/api/mcp/github-1/connect" && init?.method === "POST"
      )
    ).toBe(true);
  });

  it("reconnects an existing marketplace row when it returns no connect URL", async () => {
    const request = installMetadataFetch({
      connections: [],
      marketplaceConnection: { catalogId: "github", id: "github-legacy" },
      marketplaceConnectUrl: null,
      reconnectUrl: "/api/mcp/github-legacy/connect?ticket=ticket-2",
      repositories: [],
    });
    const assign = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => undefined);
    render(
      <CodeRepositorySetupCard
        answer={answer}
        botSlug="builder"
        item={item}
        pending={false}
        state="open"
      />
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Connect GitHub" })
    );
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        "http://localhost:3000/api/mcp/github-legacy/connect?ticket=ticket-2&returnTo=%2Fb%2Fbuilder"
      )
    );
    expect(
      request.mock.calls.some(
        ([url, init]) =>
          String(url) === "/api/mcp/github-legacy/connect" &&
          init?.method === "POST"
      )
    ).toBe(true);
  });

  it("offers Not now before GitHub is connected", async () => {
    installMetadataFetch({ connections: [], repositories: [] });
    render(
      <CodeRepositorySetupCard
        answer={answer}
        botSlug="builder"
        item={item}
        pending={false}
        state="open"
      />
    );

    expect(
      await screen.findByRole("button", { name: "Connect GitHub" })
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Not now" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith({ optionId: "cancel" })
    );
  });

  it("offers Not now while GitHub access is loading", async () => {
    const request = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", request);
    render(
      <CodeRepositorySetupCard
        answer={answer}
        botSlug="builder"
        item={item}
        pending={false}
        state="open"
      />
    );

    expect(screen.getByRole("status").textContent).toContain("Checking");
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect GitHub" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith({ optionId: "cancel" })
    );
  });

  it("does not repeat repository discovery during metadata polling", async () => {
    const request = installMetadataFetch();
    render(
      <CodeRepositorySetupCard
        answer={answer}
        botSlug="builder"
        item={item}
        pending={false}
        state="open"
      />
    );

    await screen.findByRole("button", { name: CONTINUE });
    const discoveryCount = () =>
      request.mock.calls.filter(([url]) =>
        String(url).startsWith("/api/code-repositories/github?")
      ).length;
    await waitFor(() => expect(discoveryCount()).toBe(1));
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(
        request.mock.calls.filter(([url]) =>
          String(url).startsWith("/api/bots/builder/code-repository")
        ).length
      ).toBeGreaterThan(1)
    );
    expect(discoveryCount()).toBe(1);
  });

  it("cancels through the interaction instead of changing the active repository", async () => {
    const request = installMetadataFetch();
    render(
      <CodeRepositorySetupCard
        answer={answer}
        botSlug="builder"
        item={item}
        pending={false}
        state="open"
      />
    );

    const cancelButton = await screen.findByRole("button", { name: "Cancel" });
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
    fireEvent.click(cancelButton);
    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith({ optionId: "cancel" })
    );
    expect(request.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
      false
    );
  });

  it("does not load or expose controls while the interaction is pending", () => {
    const request = installMetadataFetch();
    render(
      <CodeRepositorySetupCard
        answer={answer}
        botSlug="builder"
        item={item}
        pending
        state="open"
      />
    );

    expect(screen.getByRole("status").textContent).toContain("Waiting");
    expect(screen.queryByRole("button", { name: CONTINUE })).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("openMcpConnectUrl", () => {
  it("adds the bot return path while preserving the OAuth ticket", () => {
    const assign = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => {
        // happy-dom does not navigate during a unit test.
      });

    expect(
      openMcpConnectUrl(
        "/api/mcp/connection-1/connect?ticket=ticket-1",
        "/b/builder"
      )
    ).toBe(true);
    expect(assign).toHaveBeenCalledWith(
      "http://localhost:3000/api/mcp/connection-1/connect?ticket=ticket-1&returnTo=%2Fb%2Fbuilder"
    );
  });

  it("reports a successful Electron handoff even when window.open returns null", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Electron/40");
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    expect(
      openMcpConnectUrl(
        "/api/mcp/connection-1/connect?ticket=ticket-1",
        "/b/builder"
      )
    ).toBe(true);
    expect(open).toHaveBeenCalledWith(
      "http://localhost:3000/api/mcp/connection-1/connect?ticket=ticket-1&returnTo=%2Fb%2Fbuilder",
      "_blank",
      "noopener,noreferrer"
    );
  });

  it("rejects provider or non-MCP URLs", () => {
    expect(openMcpConnectUrl("https://github.com/login/oauth")).toBe(false);
    expect(openMcpConnectUrl("/settings/connections", "/b/builder")).toBe(
      false
    );
  });
});
