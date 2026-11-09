// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountAiConnectionCard,
  AccountAiMenuContent,
} from "@/components/account-ai-connection";
import type { AiConnectionContextValue } from "@/components/ai-connection-provider";
import type { AiProviderOption, AiSettingsSnapshot } from "@/lib/ai/types";

vi.mock("next/image", () => ({
  default: () => <span data-testid="provider-image" />,
}));

const ai = vi.hoisted(() => ({
  connection: null as AiConnectionContextValue | null,
}));
const account = vi.hoisted(() => ({
  state: {
    data: {
      account: { avatarUrl: null, name: "Matias Solina", username: "mati" },
      tokenPass: {
        dashboardUrl: "https://vercel.com",
        limitUsd: 80,
        percentUsed: 12.5,
        resetsAt: "2026-11-10T08:00:00.000Z",
        status: "active",
        usedUsd: 10,
      },
    },
    error: false,
    loading: false,
  },
}));

vi.mock("@/components/ai-connection-provider", () => ({
  useAiConnectionOptional: () => ai.connection,
}));
vi.mock("@/components/account-provider", () => ({
  useAccount: () => account.state,
}));

const providers: AiProviderOption[] = [
  {
    description: "Use ChatGPT.",
    detail: "",
    id: "chatgpt",
    label: "ChatGPT",
    learnMoreUrl: null,
    models: [{ id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol" }],
    status: "available",
  },
  {
    description: "Use Grok.",
    detail: "",
    id: "grok",
    label: "Grok",
    learnMoreUrl: null,
    models: [{ id: "grok/grok-4.7", label: "Grok 4.7" }],
    status: "available",
  },
  {
    description: "Use Token Pass.",
    detail: "",
    id: "token-pass",
    label: "Token Pass",
    learnMoreUrl: null,
    status: "available",
  },
  {
    description: "Use AI Gateway.",
    detail: "",
    id: "gateway",
    label: "AI Gateway",
    learnMoreUrl: null,
    status: "available",
  },
];
const manageUsageName = /Manage usage/u;
const grokUsageName = /View usage in Grok/u;
const usedName = /% used/u;
const chatgptModelName = /GPT-6\.1 Sol/u;
const botsUsingConnectionName = /bots using this connection cannot run/u;
const settingsLoadErrorName = /Couldn't load AI settings/u;
const tokenPassNotConfiguredName = /Token Pass is not configured/u;
const tokenPassUsageName = /12\.5%/u;
const gatewayBillingDocsName = /AI Gateway billing docs/u;

function context(
  overrides: Partial<AiSettingsSnapshot> = {},
  extra: Partial<AiConnectionContextValue> = {}
) {
  const snapshot: AiSettingsSnapshot = {
    model: null,
    onboardingCompleted: true,
    provider: "chatgpt",
    providers,
    ...overrides,
  };
  return {
    activeAttempt: null,
    cancelSubscription: vi.fn(),
    connecting: false,
    connectionError: null,
    disconnect: vi.fn(),
    dismissOnboarding: vi.fn(),
    error: null,
    loading: false,
    onboardingOpen: false,
    refresh: vi.fn(),
    saveProvider: vi.fn(),
    saving: false,
    selectedModel: null,
    selectedProvider: snapshot.provider,
    selectModel: vi.fn(),
    selectProvider: vi.fn(),
    snapshot,
    startSubscription: vi.fn(),
    ...extra,
  } as unknown as AiConnectionContextValue;
}

beforeEach(() => {
  ai.connection = null;
  account.state = {
    data: {
      account: { avatarUrl: null, name: "Matias Solina", username: "mati" },
      tokenPass: {
        dashboardUrl: "https://vercel.com",
        limitUsd: 80,
        percentUsed: 12.5,
        resetsAt: "2026-11-10T08:00:00.000Z",
        status: "active",
        usedUsd: 10,
      },
    },
    error: false,
    loading: false,
  };
});

afterEach(() => {
  cleanup();
});

describe("account AI connection summary", () => {
  it("shows the saved ChatGPT provider even when the draft points to Grok", () => {
    ai.connection = context(
      { model: "openai/gpt-6.1-sol", provider: "chatgpt" },
      { selectedModel: "grok/grok-4.7", selectedProvider: "grok" }
    );

    render(
      <>
        <AccountAiMenuContent />
        <AccountAiConnectionCard />
      </>
    );

    expect(screen.getByText("Using ChatGPT")).toBeTruthy();
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("heading", {
        name: "ChatGPT subscription",
      })
    ).toBeTruthy();
    expect(screen.getByText(chatgptModelName)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: manageUsageName }).getAttribute("href")
    ).toBe("https://chatgpt.com/settings/usage");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("shows Grok as the active connection and links to its dashboard", () => {
    ai.connection = context({ model: "grok/grok-4.7", provider: "grok" });

    render(
      <>
        <AccountAiMenuContent />
        <AccountAiConnectionCard />
      </>
    );

    expect(screen.getByText("Using Grok")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Grok subscription" })
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: grokUsageName }).getAttribute("href")
    ).toBe("https://grok.com/dashboard");
    expect(screen.queryByText(usedName)).toBeNull();
  });

  it("keeps Token Pass usage when there is no AI connection context", () => {
    render(
      <>
        <AccountAiMenuContent />
        <AccountAiConnectionCard />
      </>
    );

    expect(screen.getByText("Token Pass usage")).toBeTruthy();
    expect(screen.getByText("12.5%")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "12.5"
    );
  });

  it("does not show stale Token Pass usage while AI settings are loading", () => {
    ai.connection = context({}, { loading: true, snapshot: null });

    render(
      <>
        <AccountAiMenuContent />
        <AccountAiConnectionCard />
      </>
    );

    expect(screen.getAllByText("AI connection").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Checking…").length).toBeGreaterThan(0);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText("12.5%")).toBeNull();
  });

  it("shows AI Gateway when it is saved, even if the draft changed", () => {
    ai.connection = context(
      { provider: "gateway" },
      { selectedProvider: "token-pass" }
    );

    render(
      <>
        <AccountAiMenuContent />
        <AccountAiConnectionCard />
      </>
    );

    expect(screen.getAllByText("AI Gateway")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "AI Gateway" })).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("keeps the Token Pass usage widget for a saved Token Pass connection", () => {
    ai.connection = context(
      { provider: "token-pass" },
      { selectedProvider: "chatgpt" }
    );

    render(
      <>
        <AccountAiMenuContent />
        <AccountAiConnectionCard />
      </>
    );

    expect(screen.getByText("Token Pass usage")).toBeTruthy();
    expect(screen.getByText("12.5%")).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("does not present allowance usage when saved Token Pass is unconfigured", () => {
    ai.connection = context({
      provider: "token-pass",
      providers: providers.map((option) =>
        option.id === "token-pass"
          ? { ...option, status: "unconfigured" as const }
          : option
      ),
    });

    render(
      <>
        <AccountAiMenuContent />
        <AccountAiConnectionCard />
      </>
    );

    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(tokenPassUsageName)).toBeNull();
    expect(
      screen.getAllByText(tokenPassNotConfiguredName).length
    ).toBeGreaterThan(0);
  });

  it("keeps a saved Token Pass card actionable when settings refresh fails", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    ai.connection = context(
      { provider: "token-pass" },
      { error: "Couldn't load AI settings.", refresh }
    );

    render(<AccountAiConnectionCard />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn't load AI settings"
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps AI Gateway refresh errors visible with a billing docs link", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    ai.connection = context(
      { provider: "gateway" },
      { error: "Couldn't load AI settings.", refresh }
    );

    render(<AccountAiConnectionCard />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn't load AI settings"
    );
    expect(
      screen
        .getByRole("link", { name: gatewayBillingDocsName })
        .getAttribute("href")
    ).toBe("https://vercel.com/docs/ai-gateway");
  });

  it("keeps an active saved provider when a draft save reports an error", () => {
    ai.connection = context(
      { model: "openai/gpt-6.1-sol", provider: "chatgpt" },
      { error: "Couldn't save AI settings." }
    );

    render(
      <>
        <AccountAiMenuContent />
        <AccountAiConnectionCard />
      </>
    );

    expect(screen.getByText("Using ChatGPT")).toBeTruthy();
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("heading", {
        name: "ChatGPT subscription",
      })
    ).toBeTruthy();
  });

  it("asks to reconnect a saved subscription that is no longer connected", () => {
    ai.connection = context({
      provider: "chatgpt",
      providers: providers.map((option) =>
        option.id === "chatgpt"
          ? { ...option, status: "not-connected" as const }
          : option
      ),
    });

    render(
      <>
        <AccountAiMenuContent />
        <AccountAiConnectionCard />
      </>
    );

    expect(screen.getByText("ChatGPT")).toBeTruthy();
    expect(screen.getAllByText("Reconnect").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("heading", {
        name: "ChatGPT subscription",
      })
    ).toBeTruthy();
    expect(screen.getByText(botsUsingConnectionName)).toBeTruthy();
  });

  it("offers a retry when the saved connection status cannot be loaded", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    ai.connection = context(
      {},
      { error: "Couldn't load AI settings.", refresh }
    );

    render(
      <>
        <AccountAiMenuContent />
        <AccountAiConnectionCard />
      </>
    );

    expect(screen.getByText(settingsLoadErrorName)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(refresh).toHaveBeenCalledOnce();
  });
});
