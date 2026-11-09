// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "@/components/account-provider";
import {
  AiConnectionProvider,
  isTerminalCompletion,
  useAiConnection,
} from "@/components/ai-connection-provider";
import { AiConnectionSettings } from "@/components/ai-connection-settings";
import { AiOnboarding } from "@/components/ai-onboarding";
import { SidebarAccount } from "@/components/sidebar-account";
import type { AiProviderOption, AiSettingsSnapshot } from "@/lib/ai/types";

const providers: AiProviderOption[] = [
  {
    description: "Use an existing ChatGPT subscription.",
    detail: "ChatGPT access requires approval for Busy's hosted app.",
    id: "chatgpt",
    label: "ChatGPT",
    learnMoreUrl: "https://developers.openai.com/",
    models: [{ id: "openai/gpt-5", label: "GPT-5" }],
    status: "not-connected",
  },
  {
    description: "Use an existing Grok subscription.",
    detail: "Grok has no official connection route for Busy hosted apps.",
    id: "grok",
    label: "Grok",
    learnMoreUrl: null,
    models: [{ id: "xai/grok-4", label: "Grok 4" }],
    status: "not-connected",
  },
  {
    description: "Use the team's Vercel Token Pass credit.",
    detail: "Token Pass covers the models included in your Vercel plan.",
    id: "token-pass",
    label: "Token Pass",
    learnMoreUrl: null,
    status: "available",
  },
  {
    description: "Use AI Gateway credits for model calls.",
    detail: "AI Gateway bills the selected model at its provider price.",
    id: "gateway",
    label: "AI Gateway",
    learnMoreUrl: null,
    status: "available",
  },
];

const originPrefix = /^https?:\/\/[^/]+/u;
const chatgptName = /ChatGPT/u;
const grokName = /Grok/u;
const tokenPassName = /Token Pass/u;
const gatewayName = /AI Gateway/u;
const staleChatgptModelName = /no longer available for your ChatGPT/u;
const busySessionExpiredName = /Your Busy session expired/u;
const busySignInGuidanceName = /Sign in to Busy again/u;

const snapshot = (
  over: Partial<AiSettingsSnapshot> = {}
): AiSettingsSnapshot => ({
  onboardingCompleted: false,
  provider: null,
  providers,
  ...over,
});

function connected(provider: "chatgpt" | "grok", accountLabel: string) {
  return providers.map((option) =>
    option.id === provider
      ? { ...option, accountLabel, status: "available" as const }
      : option
  );
}

let request: ReturnType<typeof vi.fn>;
let current: AiSettingsSnapshot;
let openWindow: ReturnType<typeof vi.spyOn>;
let exposedConnection: ReturnType<typeof useAiConnection> | null = null;

function ConnectionProbe() {
  const connection = useAiConnection();
  useEffect(() => {
    exposedConnection = connection;
    return () => {
      if (exposedConnection === connection) {
        exposedConnection = null;
      }
    };
  }, [connection]);
  return null;
}

function renderWithProvider(child: React.ReactNode) {
  return render(<AiConnectionProvider>{child}</AiConnectionProvider>);
}

function selectSettingsTab(name: "Model" | "Skills" | "Usage") {
  fireEvent.click(screen.getByRole("tab", { name }));
}

beforeEach(() => {
  current = snapshot();
  window.busyDesktop = undefined;
  openWindow = vi.spyOn(window, "open").mockImplementation(() => null);
  request = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(originPrefix, "");
    const method = (init?.method ?? "GET").toUpperCase();
    if (path === "/api/ai/settings" && method === "GET") {
      return Promise.resolve(Response.json(current));
    }
    if (path === "/api/account" && method === "GET") {
      return Promise.resolve(
        Response.json({
          account: { avatarUrl: null, name: "Matias Solina" },
          tokenPass: {
            dashboardUrl: "https://vercel.com",
            percentUsed: 12.5,
            status: "active",
          },
        })
      );
    }
    if (path === "/api/ai/settings" && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as {
        model?: string;
        provider: NonNullable<AiSettingsSnapshot["provider"]>;
      };
      current = snapshot({
        ...current,
        model: body.model ?? null,
        onboardingCompleted: true,
        provider: body.provider,
      });
      return Promise.resolve(Response.json(current));
    }
    return Promise.resolve(
      Response.json({ error: "not found" }, { status: 404 })
    );
  });
  vi.stubGlobal("fetch", request);
});

afterEach(() => {
  cleanup();
  window.busyDesktop = undefined;
  exposedConnection = null;
  openWindow.mockRestore();
  vi.unstubAllGlobals();
});

describe("AI connection", () => {
  it.each(["connection_failed", "connection_expired"])(
    "treats %s as terminal without another poll",
    (code) => {
      expect(isTerminalCompletion(409, code)).toBe(true);
      expect(isTerminalCompletion(503, "provider_unavailable")).toBe(false);
    }
  );

  it("shows the first-use onboarding, keeps subscriptions disabled, and saves a choice", async () => {
    renderWithProvider(<AiOnboarding />);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(
      (screen.getByRole("radio", { name: chatgptName }) as HTMLInputElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByRole("radio", { name: grokName }) as HTMLInputElement)
        .disabled
    ).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: tokenPassName }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(request).toHaveBeenCalledWith(
      "/api/ai/settings",
      expect.objectContaining({
        body: JSON.stringify({ provider: "token-pass" }),
        method: "PUT",
      })
    );
  });

  it("does not show onboarding after a saved connection and lets Settings switch it", async () => {
    current = snapshot({ onboardingCompleted: true, provider: "gateway" });
    renderWithProvider(<AiConnectionSettings />);

    await screen.findByRole("radio", { name: gatewayName });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: tokenPassName }));
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    await waitFor(() =>
      expect(screen.getByText("Using Token Pass")).toBeTruthy()
    );

    expect(request).toHaveBeenCalledWith(
      "/api/ai/settings",
      expect.objectContaining({
        body: JSON.stringify({ provider: "token-pass" }),
        method: "PUT",
      })
    );
  });

  it("shows the AI connection section inside the account Settings dialog", async () => {
    current = snapshot({ onboardingCompleted: true, provider: "gateway" });
    renderWithProvider(
      <AccountProvider>
        <SidebarAccount onOpenMarketplace={vi.fn()} />
      </AccountProvider>
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Account menu: Matias Solina",
      })
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));

    expect(
      await screen.findByRole("heading", { name: "AI connection" })
    ).toBeTruthy();
  });

  it.each([
    { label: "ChatGPT", model: "openai/gpt-5", provider: "chatgpt" as const },
    { label: "Grok", model: "xai/grok-4", provider: "grok" as const },
  ])(
    "updates the account widget only after saving $label",
    async ({ label, model, provider }) => {
      current = snapshot({
        onboardingCompleted: true,
        provider: "token-pass",
        providers: connected(provider, "Connected account"),
      });
      renderWithProvider(
        <AccountProvider>
          <SidebarAccount onOpenMarketplace={vi.fn()} />
        </AccountProvider>
      );
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Account menu: Matias Solina",
        })
      );
      fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
      await screen.findByRole("tab", { name: "Model" });
      selectSettingsTab("Usage");
      expect(
        screen.getByRole("tab", { name: "Usage" }).getAttribute("aria-selected")
      ).toBe("true");
      expect(
        screen.getByRole("progressbar", {
          name: "Token Pass subscription usage",
        })
      ).toBeTruthy();
      expect(screen.getByText("12.5% used")).toBeTruthy();

      selectSettingsTab("Model");
      await screen.findByRole("radio", { name: label });

      fireEvent.click(screen.getByRole("radio", { name: label }));
      fireEvent.change(
        screen.getByRole("combobox", { name: `${label} model` }),
        {
          target: { value: model },
        }
      );
      selectSettingsTab("Usage");
      expect(
        screen.getByRole("tab", { name: "Usage" }).getAttribute("aria-selected")
      ).toBe("true");
      expect(
        screen.getByRole("progressbar", {
          name: "Token Pass subscription usage",
        })
      ).toBeTruthy();
      expect(screen.getByText("12.5% used")).toBeTruthy();
      selectSettingsTab("Model");
      fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
      await waitFor(() =>
        expect(
          request.mock.calls.some(
            ([url, init]) =>
              String(url) === "/api/ai/settings" && init?.method === "PUT"
          )
        ).toBe(true)
      );
      selectSettingsTab("Usage");
      await screen.findByRole("heading", { name: `${label} subscription` });
      expect(screen.queryByRole("progressbar")).toBeNull();
      expect(screen.queryByText("12.5% used")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Account menu: Matias Solina" })
      );
      const menu = screen.getByRole("menu");
      expect(menu.textContent).toContain(`Using ${label}`);
      expect(menu.textContent).not.toContain("Token Pass usage");
      expect(menu.textContent).not.toContain("12.5%");
    }
  );

  it("polls a ChatGPT desktop connection automatically before saving a model preference", async () => {
    let completeBody: unknown;
    const prepareChatGpt = vi.fn().mockResolvedValue({
      redirectUri: "http://127.0.0.1:54321/auth/callback",
    });
    const openChatGpt = vi.fn().mockResolvedValue(undefined);
    const cancelChatGpt = vi.fn().mockResolvedValue(undefined);
    window.busyDesktop = {
      subscriptions: { cancelChatGpt, openChatGpt, prepareChatGpt },
    };
    request.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace(originPrefix, "");
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/api/ai/settings" && method === "GET") {
          return Promise.resolve(Response.json(current));
        }
        if (path === "/api/ai/connections/chatgpt" && method === "POST") {
          return Promise.resolve(
            Response.json({
              attemptId: "attempt-chatgpt",
              expiresAt: Date.now() + 60_000,
              intervalMs: 250,
              kind: "browser",
              provider: "chatgpt",
              url: "https://auth.openai.example/authorize",
            })
          );
        }
        if (
          path === "/api/ai/connections/chatgpt/complete" &&
          method === "POST"
        ) {
          completeBody = JSON.parse(String(init?.body));
          current = snapshot({
            onboardingCompleted: false,
            provider: null,
            providers: connected("chatgpt", "The user's ChatGPT"),
          });
          return Promise.resolve(Response.json({ status: "connected" }));
        }
        if (path === "/api/ai/settings" && method === "PUT") {
          const body = JSON.parse(String(init?.body)) as {
            model?: string;
            provider: "chatgpt" | "gateway" | "grok" | "token-pass";
          };
          current = snapshot({
            model: body.model,
            onboardingCompleted: true,
            provider: body.provider,
            providers: connected("chatgpt", "The user's ChatGPT"),
          });
          return Promise.resolve(Response.json(current));
        }
        return Promise.resolve(
          Response.json({ error: "not found" }, { status: 404 })
        );
      }
    );

    renderWithProvider(<AiOnboarding />);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Connect ChatGPT" }));
    expect(
      await screen.findByRole("heading", { name: "Connecting to ChatGPT" })
    ).toBeTruthy();
    expect(screen.queryByLabelText("Return URL")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Finish connection" })
    ).toBeNull();
    expect(prepareChatGpt).toHaveBeenCalledOnce();
    expect(openChatGpt).toHaveBeenCalledOnce();
    expect(openWindow).not.toHaveBeenCalled();
    expect(
      request.mock.calls.some(
        ([url, init]) =>
          String(url) === "/api/ai/connections/chatgpt" &&
          init?.method === "POST" &&
          init.body ===
            JSON.stringify({
              redirectUri: "http://127.0.0.1:54321/auth/callback",
            })
      )
    ).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: chatgptName })).toBeTruthy()
    );
    await waitFor(() =>
      expect(completeBody).toEqual({
        attemptId: "attempt-chatgpt",
      })
    );
    fireEvent.change(screen.getByRole("combobox", { name: "ChatGPT model" }), {
      target: { value: "openai/gpt-5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      request.mock.calls.some(
        ([url, init]) =>
          String(url) === "/api/ai/settings" &&
          init?.method === "PUT" &&
          JSON.parse(String(init.body)).provider === "chatgpt" &&
          JSON.parse(String(init.body)).model === "openai/gpt-5"
      )
    ).toBe(true);
  });

  it("polls Grok device authorization and allows cancelling a local attempt", async () => {
    let completionCount = 0;
    const popup = {
      close: vi.fn(),
      location: { replace: vi.fn() },
      opener: null as Window | null,
    };
    openWindow.mockImplementation(() => popup as unknown as Window);
    request.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace(originPrefix, "");
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/api/ai/settings" && method === "GET") {
          return Promise.resolve(Response.json(current));
        }
        if (path === "/api/ai/connections/grok" && method === "POST") {
          return Promise.resolve(
            Response.json({
              attemptId: "attempt-grok",
              expiresAt: Date.now() + 60_000,
              intervalMs: 250,
              kind: "device",
              provider: "grok",
              url: "https://x.ai/verify",
              userCode: "ABCD-EFGH",
            })
          );
        }
        if (path === "/api/ai/connections/grok/complete" && method === "POST") {
          completionCount += 1;
          if (completionCount === 1) {
            return Promise.resolve(
              Response.json(
                { error: "pending", retryAfterMs: 250 },
                { status: 429 }
              )
            );
          }
          current = snapshot({
            onboardingCompleted: true,
            provider: "grok",
            providers: connected("grok", "The user's Grok"),
          });
          return Promise.resolve(Response.json({ status: "connected" }));
        }
        if (path === "/api/ai/connections/grok" && method === "DELETE") {
          current = snapshot({ onboardingCompleted: true, provider: null });
          return Promise.resolve(Response.json({ ok: true }));
        }
        return Promise.resolve(
          Response.json({ error: "not found" }, { status: 404 })
        );
      }
    );

    current = snapshot({ onboardingCompleted: true, provider: "gateway" });
    renderWithProvider(<AiConnectionSettings />);
    await screen.findByRole("radio", { name: grokName });
    fireEvent.click(screen.getByRole("button", { name: "Connect Grok" }));
    expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
    await waitFor(() => expect(completionCount).toBeGreaterThanOrEqual(2), {
      timeout: 1500,
    });
    expect(
      (screen.getByRole("radio", { name: grokName }) as HTMLInputElement)
        .checked
    ).toBe(true);
    expect(openWindow).toHaveBeenCalledWith("about:blank", "_blank");
    expect(popup.opener).toBeNull();
    expect(popup.location.replace).toHaveBeenCalledWith("https://x.ai/verify");

    completionCount = 0;
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/api/ai/connections/grok", {
        method: "DELETE",
      })
    );
  });

  it("opens ChatGPT automatically in local web mode and polls the callback", async () => {
    const popup = {
      close: vi.fn(),
      location: { replace: vi.fn() },
      opener: null as Window | null,
    };
    openWindow.mockImplementation(() => popup as unknown as Window);
    let completeBody: unknown;
    let localStartBody: BodyInit | null | undefined;
    request.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace(originPrefix, "");
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/api/ai/settings" && method === "GET") {
          return Promise.resolve(Response.json(current));
        }
        if (path === "/api/ai/connections/chatgpt" && method === "POST") {
          localStartBody = init?.body;
          return Promise.resolve(
            Response.json({
              attemptId: "attempt-local-chatgpt",
              expiresAt: Date.now() + 60_000,
              intervalMs: 250,
              kind: "browser",
              provider: "chatgpt",
              url: "https://auth.openai.example/authorize",
            })
          );
        }
        if (
          path === "/api/ai/connections/chatgpt/complete" &&
          method === "POST"
        ) {
          completeBody = JSON.parse(String(init?.body));
          current = snapshot({
            onboardingCompleted: true,
            provider: "chatgpt",
            providers: connected("chatgpt", "The user's ChatGPT"),
          });
          return Promise.resolve(Response.json({ status: "connected" }));
        }
        return Promise.resolve(
          Response.json({ error: "not found" }, { status: 404 })
        );
      }
    );
    current = snapshot({ onboardingCompleted: true, provider: "gateway" });
    renderWithProvider(<AiConnectionSettings />);
    await screen.findByRole("radio", { name: chatgptName });
    fireEvent.click(screen.getByRole("button", { name: "Connect ChatGPT" }));
    await screen.findByRole("heading", { name: "Connecting to ChatGPT" });
    expect(openWindow).toHaveBeenCalledWith("about:blank", "_blank");
    expect(popup.opener).toBeNull();
    expect(popup.location.replace).toHaveBeenCalledWith(
      "https://auth.openai.example/authorize"
    );
    expect(localStartBody).toBeUndefined();
    expect(screen.queryByLabelText("Return URL")).toBeNull();
    await waitFor(() =>
      expect(completeBody).toEqual({ attemptId: "attempt-local-chatgpt" })
    );
  });

  it("uses the desktop browser handler for Grok instead of a blank popup", async () => {
    const openChatGpt = vi.fn().mockResolvedValue(undefined);
    window.busyDesktop = {
      subscriptions: {
        cancelChatGpt: vi.fn().mockResolvedValue(undefined),
        openChatGpt,
        prepareChatGpt: vi.fn().mockResolvedValue({
          redirectUri: "http://127.0.0.1:54321/auth/callback",
        }),
      },
    };
    request.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace(originPrefix, "");
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/api/ai/settings" && method === "GET") {
          return Promise.resolve(Response.json(current));
        }
        if (path === "/api/ai/connections/grok" && method === "POST") {
          return Promise.resolve(
            Response.json({
              attemptId: "attempt-grok-desktop",
              expiresAt: Date.now() + 60_000,
              intervalMs: 250,
              kind: "device",
              provider: "grok",
              url: "https://x.ai/verify",
              userCode: "DESKTOP",
            })
          );
        }
        if (path === "/api/ai/connections/grok/complete") {
          return Promise.resolve(
            Response.json(
              { error: "pending", retryAfterMs: 250 },
              { status: 429 }
            )
          );
        }
        return Promise.resolve(
          Response.json({ error: "not found" }, { status: 404 })
        );
      }
    );
    current = snapshot({ onboardingCompleted: true, provider: "gateway" });
    renderWithProvider(<AiConnectionSettings />);
    await screen.findByRole("radio", { name: grokName });
    fireEvent.click(screen.getByRole("button", { name: "Connect Grok" }));
    await screen.findByText("DESKTOP");
    expect(openWindow).toHaveBeenCalledWith(
      "https://x.ai/verify",
      "_blank",
      "noopener,noreferrer"
    );
    expect(openWindow).not.toHaveBeenCalledWith("about:blank", "_blank");
    expect(openChatGpt).not.toHaveBeenCalled();
  });

  it("does not surface an obsolete ChatGPT start error after cancellation", async () => {
    let rejectPrepare!: (cause: Error) => void;
    const prepareChatGpt = vi.fn(
      () =>
        new Promise<{ redirectUri: string }>((_resolve, reject) => {
          rejectPrepare = reject;
        })
    );
    window.busyDesktop = {
      subscriptions: {
        cancelChatGpt: vi.fn().mockResolvedValue(undefined),
        openChatGpt: vi.fn().mockResolvedValue(undefined),
        prepareChatGpt,
      },
    };
    current = snapshot({ onboardingCompleted: true, provider: "gateway" });
    renderWithProvider(
      <>
        <ConnectionProbe />
        <AiConnectionSettings />
      </>
    );
    await screen.findByRole("radio", { name: chatgptName });
    fireEvent.click(screen.getByRole("button", { name: "Connect ChatGPT" }));
    await waitFor(() => expect(prepareChatGpt).toHaveBeenCalledOnce());
    exposedConnection?.cancelSubscription();
    rejectPrepare(new Error("obsolete start failed"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByText("obsolete start failed")).toBeNull();
  });

  it("cancels browser polling locally and maps connection errors to clear copy", async () => {
    let startCalls = 0;
    let completeCalls = 0;
    let deleteCalls = 0;
    window.busyDesktop = {
      subscriptions: {
        cancelChatGpt: vi.fn().mockResolvedValue(undefined),
        openChatGpt: vi.fn().mockResolvedValue(undefined),
        prepareChatGpt: vi.fn().mockResolvedValue({
          redirectUri: "http://127.0.0.1:54321/auth/callback",
        }),
      },
    };
    current = snapshot({ onboardingCompleted: true, provider: "gateway" });
    request.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace(originPrefix, "");
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/api/ai/settings" && method === "GET") {
          return Promise.resolve(Response.json(current));
        }
        if (path === "/api/ai/connections/chatgpt" && method === "POST") {
          startCalls += 1;
          if (startCalls === 2) {
            return Promise.resolve(
              Response.json({ error: "provider_unavailable" }, { status: 503 })
            );
          }
          return Promise.resolve(
            Response.json({
              attemptId: "attempt-cancel",
              expiresAt: Date.now() + 60_000,
              intervalMs: 250,
              kind: "browser",
              provider: "chatgpt",
              url: "https://auth.openai.example/authorize",
            })
          );
        }
        if (
          path === "/api/ai/connections/chatgpt/complete" &&
          method === "POST"
        ) {
          completeCalls += 1;
          return Promise.resolve(Response.json({ status: "pending" }));
        }
        if (
          path === "/api/ai/connections/chatgpt/complete" &&
          method === "DELETE"
        ) {
          deleteCalls += 1;
          return Promise.resolve(Response.json({ ok: true }));
        }
        return Promise.resolve(
          Response.json({ error: "not found" }, { status: 404 })
        );
      }
    );

    renderWithProvider(<AiConnectionSettings />);
    await screen.findByRole("radio", { name: chatgptName });
    fireEvent.click(screen.getByRole("button", { name: "Connect ChatGPT" }));
    await screen.findByRole("heading", { name: "Connecting to ChatGPT" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Connecting to ChatGPT" })
      ).toBeNull()
    );
    expect(completeCalls).toBe(0);
    expect(deleteCalls).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Connect ChatGPT" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "unavailable right now"
    );
  });

  it("stops polling when a device attempt expires", async () => {
    let completionCalls = 0;
    current = snapshot({ onboardingCompleted: true, provider: "gateway" });
    request.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace(originPrefix, "");
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/api/ai/settings" && method === "GET") {
          return Promise.resolve(Response.json(current));
        }
        if (path === "/api/ai/connections/grok" && method === "POST") {
          return Promise.resolve(
            Response.json({
              attemptId: "attempt-expired",
              expiresAt: Date.now() + 50,
              intervalMs: 250,
              kind: "device",
              provider: "grok",
              url: "https://x.ai/verify",
              userCode: "EXPIRED",
            })
          );
        }
        if (path === "/api/ai/connections/grok/complete") {
          completionCalls += 1;
        }
        return Promise.resolve(
          Response.json({ error: "not found" }, { status: 404 })
        );
      }
    );

    renderWithProvider(<AiConnectionSettings />);
    await screen.findByRole("radio", { name: grokName });
    fireEvent.click(screen.getByRole("button", { name: "Connect Grok" }));
    await screen.findByText("EXPIRED");
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("expired")
    );
    expect(completionCalls).toBe(0);
    expect(screen.queryByText("Waiting for approval…")).toBeNull();
  });

  it("ignores an in-flight completion after the user cancels", async () => {
    let completionCalls = 0;
    let resolveCompletion!: (response: Response) => void;
    const heldCompletion = new Promise<Response>((resolve) => {
      resolveCompletion = resolve;
    });
    current = snapshot({ onboardingCompleted: true, provider: "gateway" });
    request.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace(originPrefix, "");
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/api/ai/settings" && method === "GET") {
          return Promise.resolve(Response.json(current));
        }
        if (path === "/api/ai/connections/grok" && method === "POST") {
          return Promise.resolve(
            Response.json({
              attemptId: "attempt-inflight",
              expiresAt: Date.now() + 60_000,
              intervalMs: 250,
              kind: "device",
              provider: "grok",
              url: "https://x.ai/verify",
              userCode: "INFLIGHT",
            })
          );
        }
        if (path === "/api/ai/connections/grok/complete") {
          completionCalls += 1;
          return heldCompletion;
        }
        return Promise.resolve(
          Response.json({ error: "not found" }, { status: 404 })
        );
      }
    );

    renderWithProvider(<AiConnectionSettings />);
    await screen.findByRole("radio", { name: grokName });
    fireEvent.click(screen.getByRole("button", { name: "Connect Grok" }));
    await screen.findByText("INFLIGHT");
    await waitFor(() => expect(completionCalls).toBe(1), { timeout: 1000 });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    resolveCompletion(Response.json({ status: "connected" }));
    await waitFor(() => expect(screen.queryByText("INFLIGHT")).toBeNull());
    expect(
      (screen.getByRole("radio", { name: grokName }) as HTMLInputElement)
        .checked
    ).toBe(false);
  });

  it("keeps the selector available when saving fails so the user can retry", async () => {
    request.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace(originPrefix, "");
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET") {
          return Promise.resolve(Response.json(current));
        }
        if (path === "/api/ai/settings" && method === "PUT") {
          return Promise.resolve(
            Response.json({ error: "provider_unavailable" }, { status: 503 })
          );
        }
        return Promise.resolve(
          Response.json({ error: "not found" }, { status: 404 })
        );
      }
    );

    renderWithProvider(<AiOnboarding />);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("radio", { name: gatewayName }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "unavailable right now"
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      (screen.getByRole("radio", { name: gatewayName }) as HTMLInputElement)
        .checked
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });

  it("explains provider quota failures without losing the pending model choice", async () => {
    current = snapshot({
      model: null,
      onboardingCompleted: true,
      provider: "token-pass",
      providers: connected("chatgpt", "The user's ChatGPT"),
    });
    request.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace(originPrefix, "");
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/api/ai/settings" && method === "GET") {
          return Promise.resolve(Response.json(current));
        }
        if (path === "/api/ai/settings" && method === "PUT") {
          return Promise.resolve(
            Response.json({ error: "provider_quota_exceeded" }, { status: 409 })
          );
        }
        return Promise.resolve(
          Response.json({ error: "not found" }, { status: 404 })
        );
      }
    );

    renderWithProvider(<AiConnectionSettings />);
    await screen.findByRole("radio", { name: chatgptName });
    fireEvent.click(screen.getByRole("radio", { name: chatgptName }));
    fireEvent.change(screen.getByRole("combobox", { name: "ChatGPT model" }), {
      target: { value: "openai/gpt-5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "ChatGPT has no remaining allowance"
    );
    expect(
      (screen.getByRole("radio", { name: chatgptName }) as HTMLInputElement)
        .checked
    ).toBe(true);
    expect(
      (
        screen.getByRole("combobox", {
          name: "ChatGPT model",
        }) as HTMLSelectElement
      ).value
    ).toBe("openai/gpt-5");
  });

  it("flags a stale saved subscription model before the user tries to save", async () => {
    current = snapshot({
      model: "openai/retired-model",
      onboardingCompleted: true,
      provider: "chatgpt",
      providers: connected("chatgpt", "The user's ChatGPT"),
    });
    renderWithProvider(<AiConnectionSettings />);
    await screen.findByRole("radio", { name: chatgptName });

    expect(await screen.findByText(staleChatgptModelName)).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Save connection",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
  });

  it("maps a provider reauthentication failure to the provider that needs action", async () => {
    current = snapshot({ onboardingCompleted: true, provider: "gateway" });
    request.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace(originPrefix, "");
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/api/ai/settings" && method === "GET") {
          return Promise.resolve(Response.json(current));
        }
        if (path === "/api/ai/connections/grok" && method === "POST") {
          return Promise.resolve(
            Response.json({ error: "provider_auth_required" }, { status: 409 })
          );
        }
        return Promise.resolve(
          Response.json({ error: "not found" }, { status: 404 })
        );
      }
    );

    renderWithProvider(<AiConnectionSettings />);
    await screen.findByRole("radio", { name: grokName });
    fireEvent.click(screen.getByRole("button", { name: "Connect Grok" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Your Grok connection is no longer available"
    );
  });

  it("does not trap the user in onboarding when the settings request fails", async () => {
    request.mockResolvedValue(
      Response.json({ error: "offline" }, { status: 503 })
    );
    renderWithProvider(<AiOnboarding />);

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "/api/ai/settings",
        expect.anything()
      )
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("explains a non-JSON Busy session expiry with a sign-in action", async () => {
    request.mockResolvedValue(new Response(null, { status: 401 }));
    renderWithProvider(<AiConnectionSettings />);

    expect(await screen.findByText(busySessionExpiredName)).toBeTruthy();
    expect(screen.getByText(busySignInGuidanceName)).toBeTruthy();
  });
});
