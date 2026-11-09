import type { Billing } from "../db/status-values";

// AI Gateway ids: any model works per bot (spec 4.9, "model-agnostic").
// Token Pass pays only for its featured models; a Token Pass key gets a 403 on the rest
// (https://vercel.com/docs/ai-gateway/token-pass/models-and-routing).
// Fast is AI Gateway's `priority` service tier (eve's **Fast** mode): only models the catalog prices one for
// (https://ai-gateway.vercel.sh/v1/models, `pricing.service_tiers.priority`), at about twice the price.
export const MODELS = [
  { fast: false, id: "moonshotai/kimi-k3", label: "Kimi K3", tokenPass: true },
  { fast: false, id: "zai/glm-5.3", label: "GLM 5.3", tokenPass: true },
  {
    fast: false,
    id: "deepseek/deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash",
    tokenPass: true,
  },
  {
    fast: false,
    id: "anthropic/claude-sonnet-5.5",
    label: "Claude Sonnet 5.5",
    tokenPass: false,
  },
  {
    fast: true,
    id: "openai/gpt-6.1-terra",
    label: "GPT-6.1 Terra",
    tokenPass: false,
  },
  { fast: true, id: "spacexai/grok-4.7", label: "Grok 4.7", tokenPass: false },
  {
    fast: true,
    id: "google/gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    tokenPass: false,
  },
];

export const coveredByTokenPass = (model: string) =>
  MODELS.some((m) => m.id === model && m.tokenPass);

export const supportsFast = (model: string) =>
  MODELS.some((m) => m.id === model && m.fast);

/**
 * How a bot pays: the team's Token Pass (the hub's TOKEN_PASS_API_KEY), AI Gateway credits (its OIDC)
 * or a connected subscription. The list lives with its database CHECK in lib/db/status-values.ts.
 */
export type { Billing } from "../db/status-values";

export const isSubscriptionBilling = (
  billing: Billing
): billing is "chatgpt" | "grok" => billing === "chatgpt" || billing === "grok";

/** Token Pass offers only its featured models; AI Gateway runs any of them. */
export const modelsFor = (billing: Billing) =>
  MODELS.filter(
    (m) => billing === "gateway" || (billing === "token-pass" && m.tokenPass)
  );
