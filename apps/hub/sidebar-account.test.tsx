// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ChangeEvent, useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarAccount } from "@/components/sidebar-account";

// biome-ignore lint/style/useConsistentTypeDefinitions: test fixture type aliases mirror the external data contracts under test.
type AccountState = {
  data: {
    account: { name: string; avatarUrl: string | null };
    tokenPass: {
      status: string;
      percentUsed: number | null;
      dashboardUrl: string;
      resetsAt?: string | null;
    };
  } | null;
  loading: boolean;
  error: boolean;
};

const account = vi.hoisted(() => ({
  state: {
    data: {
      account: { avatarUrl: null, name: "Matias Solina" },
      tokenPass: {
        dashboardUrl: "https://vercel.com",
        percentUsed: 12.5,
        status: "active",
      },
    },
    error: false,
    loading: false,
  } as AccountState,
}));

vi.mock("@/components/account-provider", () => ({
  useAccount: () => account.state,
}));

vi.mock("@/components/ai-connection-settings", () => ({
  AiConnectionSettings: () => (
    <section aria-labelledby="ai-connection-heading">
      <h3 id="ai-connection-heading">AI connection</h3>
    </section>
  ),
}));

function EmbeddedMcpMarketplaceContentMock({
  active = true,
}: {
  active?: boolean;
}) {
  const [query, setQuery] = useState("");
  const handleQueryChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setQuery(event.currentTarget.value),
    []
  );
  return (
    <section aria-label="Embedded MCP manager">
      <h3>MCPs manager</h3>
      {active ? (
        <label>
          Search MCPs
          <input
            aria-label="Search MCPs"
            onChange={handleQueryChange}
            value={query}
          />
        </label>
      ) : null}
    </section>
  );
}

vi.mock("@/components/mcp-marketplace", () => ({
  McpMarketplaceContent: EmbeddedMcpMarketplaceContentMock,
}));

vi.mock("@/components/capabilities-panel", () => ({
  CapabilitiesPanel: ({ kind }: { kind: "plugin" | "skill" }) => (
    <section aria-label={`${kind} capabilities`}>
      <h3>{kind === "skill" ? "Skills manager" : "Plugins manager"}</h3>
      <p>{`${kind} manager for app`}</p>
    </section>
  ),
}));

const settle = async () => {
  await act(async () => {
    // biome-ignore lint/style/noIncrementDecrement: fixture counter is intentionally local to the test scenario.
    for (let i = 0; i < 8; i++) {
      // biome-ignore lint/performance/noAwaitInLoops: fixture operations are intentionally sequential to preserve deterministic ordering.
      await Promise.resolve();
    }
  });
};

function renderAccount(
  over: Partial<React.ComponentProps<typeof SidebarAccount>> = {}
) {
  return render(<SidebarAccount onOpenMarketplace={vi.fn()} {...over} />);
}

async function openSettings() {
  fireEvent.click(
    screen.getByRole("button", { name: "Account menu: Matias Solina" })
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
  await screen.findByRole("tablist", { name: "Settings sections" });
}

function selectSettingsTab(
  name: "MCPs" | "Model" | "Plugins" | "Skills" | "Usage"
) {
  fireEvent.click(screen.getByRole("tab", { name }));
}

let logout: ReturnType<typeof vi.fn>;

beforeEach(() => {
  account.state = {
    data: {
      account: { avatarUrl: null, name: "Matias Solina" },
      tokenPass: {
        dashboardUrl: "https://vercel.com",
        percentUsed: 12.5,
        status: "active",
      },
    },
    error: false,
    loading: false,
  };
  logout = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", logout);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sidebar account", () => {
  it("retains the selected Settings section after closing and reopening", async () => {
    renderAccount();
    await openSettings();
    selectSettingsTab("Usage");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await openSettings();
    expect(
      screen.getByRole("tab", { name: "Usage" }).getAttribute("aria-selected")
    ).toBe("true");
  });

  it("opens Settings from the profile menu", async () => {
    renderAccount();

    expect(screen.queryByRole("progressbar")).toBeNull();
    await openSettings();
    await settle();

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Model" }).getAttribute("aria-selected")
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: "Skills" }).getAttribute("aria-selected")
    ).toBe("false");
    expect(
      screen.getByRole("tab", { name: "Plugins" }).getAttribute("aria-selected")
    ).toBe("false");
    expect(
      screen.getByRole("tab", { name: "MCPs" }).getAttribute("aria-selected")
    ).toBe("false");
    expect(
      screen.getByRole("tab", { name: "Usage" }).getAttribute("aria-selected")
    ).toBe("false");
  });

  it("keeps each Settings section focused without opening another modal", async () => {
    renderAccount();
    await openSettings();
    await settle();

    expect(
      screen.getByRole("tab", { name: "Model" }).getAttribute("aria-selected")
    ).toBe("true");
    expect(screen.getByRole("heading", { name: "AI connection" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Token Pass" })).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Grok subscription" })
    ).toBeNull();

    selectSettingsTab("Skills");
    expect(
      screen.getByRole("tab", { name: "Skills" }).getAttribute("aria-selected")
    ).toBe("true");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(
      await screen.findByRole("heading", { name: "Skills manager" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Plugins manager" })
    ).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Search MCPs" })).toBeNull();

    selectSettingsTab("Plugins");
    expect(
      await screen.findByRole("heading", { name: "Plugins manager" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Skills manager" })
    ).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Search MCPs" })).toBeNull();

    selectSettingsTab("MCPs");
    expect(
      await screen.findByRole("heading", { name: "MCPs manager" })
    ).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Search MCPs" })).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Skills manager" })
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Plugins manager" })
    ).toBeNull();
    expect(
      screen.queryByRole("tablist", { name: "App capabilities" })
    ).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Search MCPs" }), {
      target: { value: "github" },
    });
    selectSettingsTab("Usage");
    expect(screen.queryByRole("textbox", { name: "Search MCPs" })).toBeNull();
    selectSettingsTab("MCPs");
    expect(
      (
        screen.getByRole("textbox", {
          name: "Search MCPs",
        }) as HTMLInputElement
      ).value
    ).toBe("github");
  });

  it("renders zero usage as zero and leaves unavailable usage blank", async () => {
    account.state.data = {
      account: { avatarUrl: null, name: "Matias Solina" },
      tokenPass: {
        dashboardUrl: "https://vercel.com",
        percentUsed: 0,
        status: "active",
      },
    };
    const { unmount } = renderAccount();
    expect(screen.queryByRole("progressbar")).toBeNull();
    await openSettings();
    selectSettingsTab("Usage");
    const zeroBar = screen.getByRole("progressbar");
    expect(screen.getByText("0% used")).toBeTruthy();
    expect(zeroBar.getAttribute("aria-valuenow")).toBe("0");
    expect(zeroBar.getAttribute("aria-valuetext")).toBe("0% used");

    unmount();
    account.state.data = {
      account: { avatarUrl: null, name: "Matias Solina" },
      tokenPass: {
        dashboardUrl: "https://vercel.com",
        percentUsed: null,
        status: "active",
      },
    };
    renderAccount();
    expect(screen.queryByRole("progressbar")).toBeNull();
    await openSettings();
    selectSettingsTab("Usage");
    const unavailableBar = screen.getByRole("progressbar");
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(unavailableBar.getAttribute("aria-valuenow")).toBeNull();
    expect(unavailableBar.getAttribute("aria-valuetext")).toBe(
      "Usage unavailable"
    );
  });

  it("opens skills, plugins and MCPs from the integrations button", () => {
    const onOpenMarketplace = vi.fn();
    render(<SidebarAccount onOpenMarketplace={onOpenMarketplace} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Skills, plugins and MCPs" })
    );

    expect(onOpenMarketplace).toHaveBeenCalledTimes(1);
  });

  it("reports a failed sign out and retries it", async () => {
    const assign = vi
      .spyOn(window.location, "assign")
      // biome-ignore lint/suspicious/noEmptyBlockStatements: no-op test double method intentionally has no behavior.
      .mockImplementation(() => {});
    logout
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    renderAccount();

    fireEvent.click(
      screen.getByRole("button", { name: "Account menu: Matias Solina" })
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn't sign out"
    );
    expect(logout).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    await settle();
    expect(logout).toHaveBeenCalledTimes(2);
    expect(assign).toHaveBeenCalledWith("/login");
    assign.mockRestore();
  });
});
