import { afterEach, describe, expect, it, vi } from "vitest";
import agent from "./agent";
import config from "./config.json" with { type: "json" };

// eve's own validation of agent.ts (what `eve build` runs), from the installed eve.
type Normalize = (
  value: unknown,
  label: string
) => {
  model: unknown;
  modelOptions?: unknown;
  limits?: { sessionTimeoutMs?: number };
  experimental?: unknown;
};
const eveCore = new URL(
  "../node_modules/eve/dist/src/internal/authored-definition/core.js",
  import.meta.url
);
const { normalizeAgentDefinition } = (await import(eveCore.href)) as {
  normalizeAgentDefinition: Normalize;
};

interface Selection {
  model: unknown;
  modelContextWindowTokens?: number;
  modelOptions?: unknown;
}
function resolveModel(definition: { model?: unknown }, sessionId = "normal") {
  const dynamic = definition.model as Record<
    symbol,
    (ctx: { session: { id: string } }) => Promise<Selection>
  >;
  const select = dynamic[Symbol.for("eve.dynamic")];
  if (!select) {
    throw new Error("Expected a dynamic model");
  }
  return select({ session: { id: sessionId } });
}

afterEach(() => {
  vi.doUnmock("./config.json");
  vi.doUnmock("./lib/subscription-model");
  vi.resetModules();
});

describe("agent.ts", () => {
  it("is a definition eve accepts", () => {
    expect(() => normalizeAgentDefinition(agent, "agent.ts")).not.toThrow();
  });

  it("keeps the long chat timeout and run retention through eve's normalization", () => {
    const normalized = normalizeAgentDefinition(agent, "agent.ts");
    expect(normalized.limits?.sessionTimeoutMs).toBe(
      (agent as { limits: { sessionTimeoutMs: number } }).limits
        .sessionTimeoutMs
    );
    expect(normalized.experimental).toEqual({
      workflow: { retention: "default" },
    });
  });

  it("lasts longer than any gap between the user's messages: a year, in milliseconds", () => {
    const ms = (agent as { limits: { sessionTimeoutMs: number } }).limits
      .sessionTimeoutMs;
    expect(ms).toBeGreaterThanOrEqual(365 * 24 * 60 * 60 * 1000);
    expect(Number.isSafeInteger(ms)).toBe(true);
  });

  it.each(["moonshotai/kimi-k3", "anthropic/claude-sonnet-5", "openai/gpt-6"])(
    "runs the model the hub wrote in config.json (%s)",
    async (model) => {
      vi.resetModules();
      vi.doMock("./config.json", () => ({ default: { ...config, model } }));
      const { default: fresh } = await import("./agent");
      expect((await resolveModel(fresh)).model).toBe(model);
      expect(() => normalizeAgentDefinition(fresh, "agent.ts")).not.toThrow();
    }
  );

  it("asks AI Gateway for its priority tier (eve's Fast mode) only when the hub turned Fast on", async () => {
    vi.resetModules();
    vi.doMock("./config.json", () => ({
      default: { ...config, fast: true, model: "spacexai/grok-4.7" },
    }));
    const { default: fast } = await import("./agent");
    expect((await resolveModel(fast)).modelOptions).toEqual({
      providerOptions: { gateway: { serviceTier: "priority" } },
    });
    expect((await resolveModel(agent)).modelOptions).toBeUndefined();
  });

  it("routes subscription billing through the subscription model without Gateway Fast", async () => {
    const subscriptionModel = vi.fn((provider: string, model: string) => ({
      model,
      provider,
    }));
    vi.resetModules();
    vi.doMock("./lib/subscription-model", () => ({ subscriptionModel }));
    vi.doMock("./config.json", () => ({
      default: {
        ...config,
        billing: "grok",
        fast: true,
        model: "grok/grok-4.7",
      },
    }));
    const { default: subscription } = await import("./agent");
    const definition = subscription.model as unknown as Record<
      symbol,
      (ctx: { session: { id: string } }) => Selection
    >;
    const select = definition[Symbol.for("eve.dynamic")];
    if (!select) {
      throw new Error("expected a dynamic subscription model");
    }
    const selected = await select({ session: { id: "session-one" } });
    expect(subscriptionModel).toHaveBeenCalledWith(
      "grok",
      "grok/grok-4.7",
      "session-one"
    );
    expect(selected.model).toEqual({
      model: "grok/grok-4.7",
      provider: "grok",
    });
    expect(selected.modelContextWindowTokens).toBe(128_000);
    expect(selected.modelOptions).toEqual({
      providerOptions: {
        openai: {
          include: ["reasoning.encrypted_content"],
          store: false,
        },
      },
    });
    expect(() =>
      normalizeAgentDefinition(subscription, "agent.ts")
    ).not.toThrow();
    await select({ session: { id: "session-two" } });
    expect(subscriptionModel).toHaveBeenLastCalledWith(
      "grok",
      "grok/grok-4.7",
      "session-two"
    );
  });
});
