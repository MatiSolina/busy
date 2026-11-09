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
import type { AiConnectionContextValue } from "@/components/ai-connection-provider";
import { BotDialog } from "@/components/bot-dialog";
import { SectionsProvider } from "@/components/sections-provider";
import type { AiProviderOption, AiSettingsSnapshot } from "@/lib/ai/types";
import { pixFor } from "@/lib/avatar";
import { BOT_TEMPLATES } from "@/lib/bots/marketplace";
import { MODELS } from "@/lib/bots/models";
import type { BotLite } from "@/lib/chat/client-store";

const aiConnectionState = vi.hoisted(() => ({
  current: null as AiConnectionContextValue | null,
}));

vi.mock("@/components/ai-connection-provider", () => ({
  useAiConnectionOptional: () => aiConnectionState.current,
}));

const bot = (over: Partial<BotLite> = {}): BotLite => ({
  avatar: "violet",
  billing: "token-pass",
  description: "Reviews contracts",
  error: null,
  fast: false,
  instructions: "Look for material risks.",
  model: "moonshotai/kimi-k3",
  name: "Lawyer",
  slug: "lawyer",
  status: "ready",
  ...over,
});

const saved = bot({
  description: "Finds sourced answers",
  name: "Research Desk",
  slug: "research-desk",
});

const CREATE_FROM_SCRATCH = /^Create from scratch/iu;
const CHOOSE_TEMPLATE = /^Choose a template/iu;
const BACK_TO_CREATION = "Back to bot creation";
const CREATE_BOT = /Create bot/iu;
const CREATING = /Creating/u;
const ENGINEERING = /Engineering/iu;
const WHAT_IT_DOES = /What it does/iu;
const USE_TEMPLATE = /Use template/iu;
const VIEW_TEMPLATE = /^View /iu;
const VIEW_RESEARCH = /View .*Research/iu;
const VIEW_PREFIX = /^View /u;
const MODEL_UNAVAILABLE = /no longer available/iu;

const store = {
  getState: vi.fn(() => ({ order: ["lawyer"] })),
  removeBot: vi.fn(),
  upsertBot: vi.fn(),
};
const select = vi.fn();

function provider(
  id: AiProviderOption["id"],
  status: AiProviderOption["status"],
  models?: AiProviderOption["models"]
): AiProviderOption {
  let label = "Grok";
  if (id === "token-pass") {
    label = "Token Pass";
  } else if (id === "gateway") {
    label = "AI Gateway";
  } else if (id === "chatgpt") {
    label = "ChatGPT";
  }
  return {
    description: `${id} connection`,
    detail: null,
    id,
    label,
    learnMoreUrl: null,
    models,
    status,
  };
}

function defaultProviders(): AiProviderOption[] {
  return [
    provider("token-pass", "available"),
    provider("gateway", "available"),
    provider("chatgpt", "not-connected", [
      { id: "openai/gpt-5", label: "GPT-5" },
    ]),
    provider("grok", "not-connected", [
      { id: "grok/grok-4.7", label: "Grok 4.7" },
    ]),
  ];
}

function settingsSnapshot(
  over: Partial<AiSettingsSnapshot> = {}
): AiSettingsSnapshot {
  return {
    model: null,
    onboardingCompleted: true,
    provider: "gateway",
    providers: defaultProviders(),
    ...over,
  };
}

function connectionContext({
  loading = false,
  snapshot = settingsSnapshot(),
}: {
  loading?: boolean;
  snapshot?: AiSettingsSnapshot | null;
} = {}): AiConnectionContextValue {
  return { loading, snapshot } as AiConnectionContextValue;
}

vi.mock("@/components/chat-app", () => ({
  useSelectBot: () => select,
  useStore: () => store,
}));

vi.mock("@/components/mcp-marketplace", () => ({
  McpMarketplace: () => null,
}));

const flush = async () => {
  await act(async () => {
    await Promise.all(Array.from({ length: 10 }, () => Promise.resolve()));
  });
};

const modelInput = () =>
  screen.getByLabelText("Model", { selector: "input" }) as HTMLInputElement;

/** Search the model combobox and click the matching option. */
const pickModel = async (label: string) => {
  fireEvent.click(screen.getByLabelText("Show models"));
  await flush();
  fireEvent.change(modelInput(), { target: { value: label } });
  await flush();
  fireEvent.click(
    await screen.findByRole("option", { hidden: true, name: label })
  );
  await flush();
};

let request: ReturnType<typeof vi.fn>;
const close = vi.fn<(open: boolean) => void>();
let createFailures = 0;
let holdCreate = false;
let resolveCreate: ((response: Response) => void) | null = null;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  request = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" && createFailures > 0) {
      createFailures -= 1;
      return Promise.resolve(new Response("invalid", { status: 400 }));
    }
    if (method === "POST" && holdCreate) {
      return new Promise<Response>((resolve) => {
        resolveCreate = resolve;
      });
    }
    if (method === "POST" || method === "PATCH") {
      return Promise.resolve(
        new Response(JSON.stringify(saved), {
          status: method === "POST" ? 201 : 200,
        })
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(saved), { status: 200 })
    );
  });
  vi.stubGlobal("fetch", request);
  store.upsertBot.mockReset();
  store.removeBot.mockReset();
  store.getState.mockReturnValue({ order: ["lawyer"] });
  select.mockReset();
  close.mockReset();
  aiConnectionState.current = connectionContext();
  createFailures = 0;
  holdCreate = false;
  resolveCreate = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderCreator(existing?: BotLite) {
  return render(
    <SectionsProvider initial={[]}>
      <BotDialog bot={existing} onOpenChange={close} open />
    </SectionsProvider>
  );
}

function openMarketplace() {
  fireEvent.click(screen.getByRole("button", { name: CHOOSE_TEMPLATE }));
}

function openScratch() {
  fireEvent.click(screen.getByRole("button", { name: CREATE_FROM_SCRATCH }));
}

describe("bot templates", () => {
  it("give every template its own face", () => {
    const avatars = BOT_TEMPLATES.map((template) => template.avatar);
    expect(new Set(avatars).size).toBe(avatars.length);
  });
});

describe("bot creator", () => {
  it("starts with the simple creation choice instead of opening the marketplace", async () => {
    renderCreator();
    await flush();

    expect(screen.getByRole("dialog", { name: "Create bot" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: CREATE_FROM_SCRATCH })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: CHOOSE_TEMPLATE })).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Bot marketplace" })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Skills & plugins" })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Skills, plugins and MCPs" })
    ).toBeNull();
  });

  it("browses the template catalog only after choosing it", async () => {
    renderCreator();
    await flush();
    openMarketplace();

    expect(
      screen.getByRole("dialog", { name: "Bot marketplace" })
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Bot marketplace" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "View Release Captain" })
    ).toBeTruthy();

    const search = screen.getByRole("searchbox", { name: "Search bots" });
    fireEvent.change(search, { target: { value: "research" } });
    expect(screen.getAllByRole("button", { name: VIEW_RESEARCH })).toHaveLength(
      2
    );

    fireEvent.change(search, { target: { value: "no-such-bot" } });
    expect(screen.getByText("No bots found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(
      screen.getByRole("button", { name: "View Release Captain" })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: ENGINEERING }));
    expect(
      screen.getByRole("button", { name: "View Release Captain" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "View Pipeline Coach" })
    ).toBeNull();
  });

  it("creates from scratch with only identity and role fields", async () => {
    renderCreator();
    await flush();
    openScratch();

    expect(screen.getByRole("dialog", { name: "Create bot" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Icon" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Color" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit bot identity" }));
    expect(screen.getByRole("group", { name: "Color" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Instructions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Model" })).toBeNull();
    expect(screen.queryByText("Billing")).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Ops Desk" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: WHAT_IT_DOES }), {
      target: { value: "Keeps operational work moving" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    await flush();

    const post = request.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "POST"
    );
    expect(post).toBeTruthy();
    if (!post) {
      throw new Error("Expected a create request");
    }
    const body = JSON.parse(String((post[1] as RequestInit).body));
    expect(body).toEqual({
      avatar: "red",
      description: "Keeps operational work moving",
      name: "Ops Desk",
    });
    expect(body.templateId).toBeUndefined();
    expect(body.instructions).toBeUndefined();
    expect(body.model).toBeUndefined();
    expect(body.billing).toBeUndefined();
    expect(store.upsertBot).toHaveBeenCalledWith(saved);
    expect(select).toHaveBeenCalledWith(saved.slug);
    expect(close).toHaveBeenCalledWith(false);
  });

  it("returns to the empty state route when deleting the last bot", async () => {
    window.history.replaceState(null, "", "/b/lawyer");
    renderCreator(bot());
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Delete bot" }));
    expect(
      screen.getByRole("button", { name: "Delete Lawyer for good?" })
    ).toBeTruthy();
    store.getState.mockReturnValue({ order: [] });
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Lawyer for good?" })
    );
    await flush();

    expect(window.location.pathname).toBe("/");
    expect(store.removeBot).toHaveBeenCalledWith("lawyer");
    expect(select).not.toHaveBeenCalled();
    window.history.replaceState(null, "", "/");
  });

  it("keeps color when returning to the template catalog", async () => {
    renderCreator();
    await flush();
    openScratch();
    fireEvent.click(screen.getByRole("button", { name: "Edit bot identity" }));
    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    fireEvent.click(screen.getByRole("button", { name: BACK_TO_CREATION }));
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    openMarketplace();
    fireEvent.click(screen.getByRole("button", { name: "Continue draft" }));

    expect(
      screen.getByRole("button", { name: "Red" }).getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("opens a template, sends its id, and keeps advanced configuration out of creation", async () => {
    renderCreator();
    await flush();
    openMarketplace();
    const [viewTemplate] = screen.getAllByRole("button", {
      name: VIEW_TEMPLATE,
    });
    const detailName = viewTemplate
      .getAttribute("aria-label")
      ?.replace(VIEW_PREFIX, "");
    fireEvent.click(viewTemplate);
    expect(screen.getByText("Try asking")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: USE_TEMPLATE }));

    expect(screen.getByRole("dialog", { name: "Create bot" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: CREATE_BOT })).toBeTruthy();
    expect(
      (screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value
    ).toBe(detailName);
    expect(screen.getByRole("textbox", { name: WHAT_IT_DOES })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Instructions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Model" })).toBeNull();
    expect(screen.queryByText("Billing")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    await flush();
    const post = request.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "POST"
    );
    expect(post).toBeTruthy();
    if (!post) {
      throw new Error("Expected a create request");
    }
    const body = JSON.parse(String((post[1] as RequestInit).body));
    expect(body).toEqual({
      avatar: "pix:nerd:lime",
      description: expect.any(String),
      name: detailName,
      templateId: expect.any(String),
    });
    expect(body.instructions).toBeUndefined();
    expect(body.model).toBeUndefined();
    expect(body.billing).toBeUndefined();
  });

  it("keeps a scratch draft after returning to the catalog", async () => {
    renderCreator();
    await flush();
    openScratch();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Ops Desk" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: WHAT_IT_DOES }), {
      target: { value: "Keeps operations moving" },
    });
    fireEvent.click(screen.getByRole("button", { name: BACK_TO_CREATION }));
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    openMarketplace();
    fireEvent.click(screen.getByRole("button", { name: "Continue draft" }));

    expect(
      (screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value
    ).toBe("Ops Desk");
    expect(
      (
        screen.getByRole("textbox", {
          name: WHAT_IT_DOES,
        }) as HTMLTextAreaElement
      ).value
    ).toBe("Keeps operations moving");
  });

  it("starts a fresh draft when scratch is chosen again", async () => {
    renderCreator();
    await flush();
    openScratch();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Abandoned Desk" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit bot identity" }));
    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    fireEvent.click(screen.getByRole("button", { name: BACK_TO_CREATION }));
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    openScratch();

    expect(
      (screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value
    ).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Edit bot identity" }));
    expect(
      screen.getByRole("button", { name: "Lime" }).getAttribute("aria-pressed")
    ).toBe("true");
    expect(screen.queryByRole("group", { name: "Icon" })).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the draft after a failed create and retries without losing edits", async () => {
    renderCreator();
    await flush();
    openScratch();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Retry Desk" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: WHAT_IT_DOES }), {
      target: { value: "Keeps operations moving" },
    });
    createFailures = 1;
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Check the fields");
    expect(
      (screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value
    ).toBe("Retry Desk");

    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    await flush();
    expect(close).toHaveBeenCalledWith(false);
    expect(store.upsertBot).toHaveBeenCalledWith(saved);
  });

  it("shows a safe provider issue while keeping the creation draft", async () => {
    aiConnectionState.current = connectionContext({
      snapshot: settingsSnapshot({ provider: "grok" }),
    });
    renderCreator();
    await flush();
    openScratch();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Retry Desk" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: WHAT_IT_DOES }), {
      target: { value: "Keeps operations moving" },
    });
    request.mockResolvedValueOnce(
      Response.json(
        {
          code: "connection_not_connected",
          error: "private-provider-token=secret",
          message: "private-provider-token=secret",
          provider: "grok",
        },
        { status: 409 }
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    await flush();

    expect(screen.getByRole("alert").textContent).toContain("Grok");
    expect(screen.getByRole("alert").textContent).toContain(
      "connection is no longer available"
    );
    expect(screen.queryByText("private-provider-token=secret")).toBeNull();
    expect(
      (screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value
    ).toBe("Retry Desk");
    expect(close).not.toHaveBeenCalled();
  });

  it("disables navigation and submit controls while creating", async () => {
    renderCreator();
    await flush();
    openScratch();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Pending Desk" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: WHAT_IT_DOES }), {
      target: { value: "Keeps operations moving" },
    });
    holdCreate = true;
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));

    expect(
      (screen.getByRole("button", { name: CREATING }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: BACK_TO_CREATION,
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    holdCreate = false;
    if (!resolveCreate) {
      throw new Error("Expected a pending create request");
    }
    resolveCreate(new Response(JSON.stringify(saved), { status: 201 }));
    await flush();
    expect(close).toHaveBeenCalledWith(false);
  });

  it("keeps editing separate and does not replace a legacy avatar on rename", async () => {
    const existing = bot({ avatar: "legacy-avatar" });
    renderCreator(existing);
    await flush();
    expect(screen.getByRole("dialog", { name: "Edit Lawyer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit bot identity" }));
    const expectedColor = pixFor(existing.slug, existing.avatar);
    const expectedColorLabel =
      expectedColor.slice(0, 1).toUpperCase() + expectedColor.slice(1);
    expect(
      screen
        .getByRole("button", { name: expectedColorLabel })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen.queryByRole("heading", { name: "Bot marketplace" })
    ).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Contract Lawyer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await flush();

    const patch = request.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH"
    );
    expect(patch).toBeTruthy();
    if (!patch) {
      throw new Error("Expected a patch request");
    }
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({
      name: "Contract Lawyer",
    });
    expect(
      request.mock.calls.some(
        (call) => (call[1] as RequestInit | undefined)?.method === "POST"
      )
    ).toBe(false);
  });

  it("keeps advanced fields unchanged when renaming a bot", async () => {
    const description = "Research\nfor my company";
    renderCreator(
      bot({
        avatar: "violet",
        description,
        instructions: "Use sources.\nAsk before acting.",
      })
    );
    await flush();
    expect(screen.getByRole("dialog", { name: "Edit Lawyer" })).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Bot marketplace" })
    ).toBeNull();
    const details = screen
      .getByText("Advanced instructions")
      .closest("details");
    expect(details).toHaveProperty("open", false);
    const descriptionField = screen.getByRole("textbox", {
      name: WHAT_IT_DOES,
    });
    expect(descriptionField).toHaveProperty("value", description);
    expect(descriptionField.closest("details")).toBe(details);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Contract Lawyer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await flush();

    const patch = request.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH"
    );
    expect(patch).toBeTruthy();
    if (!patch) {
      throw new Error("Expected a patch request");
    }
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({
      name: "Contract Lawyer",
    });
    expect(
      request.mock.calls.some(
        (call) => (call[1] as RequestInit | undefined)?.method === "POST"
      )
    ).toBe(false);
  });

  it("loads instructions the chat omits and never overwrites them before they arrive", async () => {
    const held: { answer?: (response: Response) => void } = {};
    request.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        (init?.method ?? "GET") === "GET"
          ? new Promise<Response>((resolve) => {
              held.answer = resolve;
            })
          : Promise.resolve(Response.json(saved))
    );
    renderCreator(bot({ instructions: undefined }));
    await flush();
    expect(request).toHaveBeenCalledWith("/api/bots/lawyer");
    const pending = screen.getByRole("textbox", { name: "Instructions" });
    expect(pending).toHaveProperty("disabled", true);
    expect(pending.getAttribute("placeholder")).toBe("Loading instructions…");

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Contract Lawyer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await flush();
    const patch = request.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH"
    );
    if (!patch) {
      throw new Error("Expected a patch request");
    }
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({
      name: "Contract Lawyer",
    });

    await act(async () => {
      held.answer?.(Response.json(bot({ instructions: "Cite sources." })));
      await Promise.resolve();
    });
    await flush();
    const loaded = screen.getByRole("textbox", { name: "Instructions" });
    expect(loaded).toHaveProperty("disabled", false);
    expect(loaded).toHaveProperty("value", "Cite sources.");
  });

  it("updates instructions through the collapsed Advanced disclosure", async () => {
    const instructions = "Use sources.\nAsk before acting.";
    const updatedInstructions = "Use primary sources.\nAsk before acting.";
    const updatedDescription = "Research and cite every answer.";
    renderCreator(bot({ instructions }));
    await flush();

    const summary = screen.getByText("Advanced instructions");
    const details = summary.closest("details");
    expect(details).toHaveProperty("open", false);

    fireEvent.click(summary);
    expect(details).toHaveProperty("open", true);
    fireEvent.change(screen.getByRole("textbox", { name: WHAT_IT_DOES }), {
      target: { value: updatedDescription },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), {
      target: { value: updatedInstructions },
    });
    fireEvent.click(summary);
    expect(details).toHaveProperty("open", false);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await flush();

    const patch = request.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH"
    );
    expect(patch).toBeTruthy();
    if (!patch) {
      throw new Error("Expected a patch request");
    }
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({
      description: updatedDescription,
      instructions: updatedInstructions,
    });
  });

  it("lets configuration change billing and model while preserving the selected avatar", async () => {
    const gatewayModel = MODELS.find(
      (entry) => !(entry.tokenPass || entry.fast)
    );
    if (!gatewayModel) {
      throw new Error("Expected a gateway model");
    }
    renderCreator(
      bot({
        avatar: "code:violet",
        model: "moonshotai/kimi-k3",
      })
    );
    await flush();

    fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), {
      target: { value: "gateway" },
    });
    await pickModel(gatewayModel.label);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await flush();

    const patch = request.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH"
    );
    expect(patch).toBeTruthy();
    if (!patch) {
      throw new Error("Expected a patch request");
    }
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({
      billing: "gateway",
      model: gatewayModel.id,
    });
    expect(
      request.mock.calls.some(
        (call) => (call[1] as RequestInit | undefined)?.method === "POST"
      )
    ).toBe(false);
  });

  it("keeps a custom Gateway model visible while renaming a bot", async () => {
    const customModel = "custom/provider-model";
    renderCreator(
      bot({
        billing: "gateway",
        model: customModel,
      })
    );
    await flush();

    expect(modelInput().value).toBe(customModel);

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Custom Model Bot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await flush();

    const patch = request.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH"
    );
    expect(patch).toBeTruthy();
    if (!patch) {
      throw new Error("Expected a patch request");
    }
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({
      name: "Custom Model Bot",
    });
  });

  it("enables Fast from the native gateway model combo", async () => {
    const fastModel = MODELS.find((entry) => entry.fast);
    if (!fastModel) {
      throw new Error("Expected a Fast gateway model");
    }
    renderCreator(bot({ billing: "gateway", fast: false }));
    await flush();

    await pickModel(`${fastModel.label} (Fast)`);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await flush();

    const patch = request.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH"
    );
    expect(patch).toBeTruthy();
    if (!patch) {
      throw new Error("Expected a patch request");
    }
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({
      fast: true,
      model: fastModel.id,
    });
  });

  it("shows only active providers in the provider combo", async () => {
    renderCreator(bot());
    await flush();

    const providerSelect = screen.getByRole("combobox", {
      name: "Provider",
    }) as HTMLSelectElement;
    expect(
      Array.from(providerSelect.options).map((option) => option.value)
    ).toEqual(["", "token-pass", "gateway"]);
    expect(providerSelect.value).toBe("token-pass");
    expect(screen.queryByRole("option", { name: "ChatGPT" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Grok" })).toBeNull();
  });

  it("uses only the connected subscription models and turns Fast off", async () => {
    aiConnectionState.current = connectionContext({
      snapshot: settingsSnapshot({
        providers: [
          provider("token-pass", "available"),
          provider("gateway", "available"),
          provider("chatgpt", "available", [
            { id: "openai/gpt-5", label: "GPT-5" },
          ]),
          provider("grok", "not-connected", [
            { id: "grok/grok-4.7", label: "Grok 4.7" },
          ]),
        ],
      }),
    });
    renderCreator(
      bot({
        billing: "gateway",
        fast: true,
        model: "openai/gpt-6.1-terra",
      })
    );
    await flush();

    fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), {
      target: { value: "chatgpt" },
    });
    expect(modelInput().value).toBe("GPT-5");
    fireEvent.click(screen.getByLabelText("Show models"));
    await flush();
    expect(
      within(screen.getByRole("listbox", { hidden: true }))
        .getAllByRole("option", { hidden: true })
        .map((option) => option.textContent)
    ).toEqual(["GPT-5"]);
    await pickModel("GPT-5");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await flush();

    const patch = request.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH"
    );
    expect(patch).toBeTruthy();
    if (!patch) {
      throw new Error("Expected a patch request");
    }
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toMatchObject({
      billing: "chatgpt",
      fast: false,
      model: "openai/gpt-5",
    });
  });

  it("moves a Fast gateway bot to a Token Pass model when requested", async () => {
    renderCreator(
      bot({
        billing: "gateway",
        fast: true,
        model: "openai/gpt-6.1-terra",
      })
    );
    await flush();

    fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), {
      target: { value: "token-pass" },
    });
    expect(modelInput().value).toBe("Kimi K3");
    expect(screen.queryByText("Fast")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await flush();

    const patch = request.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH"
    );
    expect(patch).toBeTruthy();
    if (!patch) {
      throw new Error("Expected a patch request");
    }
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toMatchObject({
      billing: "token-pass",
      fast: false,
      model: "moonshotai/kimi-k3",
    });
  });

  it("keeps provider and model combos empty while connections load", async () => {
    aiConnectionState.current = connectionContext({
      loading: true,
      snapshot: null,
    });
    renderCreator(bot());
    await flush();

    const providerSelect = screen.getByRole("combobox", {
      name: "Provider",
    }) as HTMLSelectElement;
    const modelSelect = modelInput();
    expect(providerSelect.disabled).toBe(true);
    expect(modelSelect.disabled).toBe(true);
    expect(providerSelect.value).toBe("");
    expect(modelSelect.value).toBe("");
    expect(screen.queryByRole("option", { name: "AI Gateway" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Kimi K3" })).toBeNull();
  });

  it("shows disabled empty combos when no provider is active", async () => {
    aiConnectionState.current = connectionContext({
      snapshot: settingsSnapshot({
        provider: null,
        providers: [
          provider("token-pass", "unconfigured"),
          provider("gateway", "unconfigured"),
          provider("chatgpt", "not-connected"),
          provider("grok", "not-connected"),
        ],
      }),
    });
    renderCreator(bot());
    await flush();

    const providerSelect = screen.getByRole("combobox", {
      name: "Provider",
    }) as HTMLSelectElement;
    const modelSelect = modelInput();
    expect(providerSelect.disabled).toBe(true);
    expect(modelSelect.disabled).toBe(true);
    expect(providerSelect.options).toHaveLength(1);
    expect(providerSelect.value).toBe("");
    expect(modelSelect.value).toBe("");
  });

  it("does not replace an inactive saved provider when renaming a bot", async () => {
    aiConnectionState.current = connectionContext({
      snapshot: settingsSnapshot({
        provider: "chatgpt",
        providers: [
          provider("token-pass", "available"),
          provider("gateway", "available"),
          provider("chatgpt", "not-connected", [
            { id: "openai/gpt-5", label: "GPT-5" },
          ]),
          provider("grok", "not-connected"),
        ],
      }),
    });
    renderCreator(
      bot({ billing: "chatgpt", model: "openai/gpt-5", name: "Lawyer" })
    );
    await flush();

    const providerSelect = screen.getByRole("combobox", {
      name: "Provider",
    }) as HTMLSelectElement;
    const modelSelect = modelInput();
    expect(providerSelect.value).toBe("");
    expect(modelSelect.value).toBe("");

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Contract Lawyer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await flush();

    const patch = request.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "PATCH"
    );
    expect(patch).toBeTruthy();
    if (!patch) {
      throw new Error("Expected a patch request");
    }
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({
      name: "Contract Lawyer",
    });
  });

  it("leaves a stale subscription model unselectable and explains the warning", async () => {
    aiConnectionState.current = connectionContext({
      snapshot: settingsSnapshot({
        provider: "chatgpt",
        providers: [
          provider("token-pass", "available"),
          provider("gateway", "available"),
          provider("chatgpt", "available", [
            { id: "openai/gpt-5", label: "GPT-5" },
          ]),
          provider("grok", "not-connected"),
        ],
      }),
    });
    renderCreator(bot({ billing: "chatgpt", model: "openai/retired-model" }));
    await flush();

    const modelSelect = modelInput();
    expect(modelSelect.value).toBe("");
    expect(
      screen.queryByRole("option", { name: "openai/retired-model" })
    ).toBeNull();
    expect(modelSelect.disabled).toBe(false);
    expect(screen.getByRole("status").textContent).toMatch(MODEL_UNAVAILABLE);
  });
});
