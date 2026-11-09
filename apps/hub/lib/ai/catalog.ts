import type {
  SubscriptionModel,
  SubscriptionProvider,
} from "./subscription-types";
import type { AiProviderOption } from "./types";

const OPENAI_PLAN_USAGE_URL =
  "https://developers.openai.com/siwc/token-sharing-open-source";
const XAI_ACCOUNTS_URL = "https://docs.x.ai/build/enterprise";

interface ConnectionMetadata {
  accountLabel: string | null;
  models: SubscriptionModel[];
  provider: SubscriptionProvider;
}

/**
 * Describe the provider choices without treating a subscription account as an
 * API credential. A completed OAuth grant and the account's model catalog
 * determine when a subscription is available.
 */
export function aiProviderCatalog(
  env: Record<string, string | undefined> = process.env,
  connections: ConnectionMetadata[] = []
): AiProviderOption[] {
  const tokenPassConfigured = Boolean(env.TOKEN_PASS_API_KEY?.trim());
  const chatgpt = connections.find((item) => item.provider === "chatgpt");
  const grok = connections.find((item) => item.provider === "grok");
  return [
    {
      description:
        "Use Busy's Vercel AI Gateway connection for any supported model.",
      detail: "Uses AI Gateway credits, billed by model usage.",
      id: "gateway",
      label: "AI Gateway",
      learnMoreUrl: "https://vercel.com/docs/ai-gateway",
      status: "available",
    },
    {
      description: "Use the team's Vercel Token Pass allowance.",
      detail: tokenPassConfigured
        ? "Available for the models covered by your Token Pass."
        : "Token Pass isn't set up for this Busy account yet. Choose another connection or ask the account owner to connect it.",
      id: "token-pass",
      label: "Vercel Token Pass",
      learnMoreUrl: "https://vercel.com/docs/ai-gateway/token-pass",
      status: tokenPassConfigured ? "available" : "unconfigured",
    },
    {
      accountLabel: chatgpt?.accountLabel ?? null,
      description: "Use an eligible ChatGPT plan with explicit consent.",
      detail:
        "Connect with ChatGPT and allow Busy to use your plan. Available models and limits come from your account.",
      id: "chatgpt",
      label: "ChatGPT subscription",
      learnMoreUrl: OPENAI_PLAN_USAGE_URL,
      models: chatgpt?.models ?? [],
      status: chatgpt ? "available" : "not-connected",
    },
    {
      accountLabel: grok?.accountLabel ?? null,
      description: "Use a personal Grok or SuperGrok subscription.",
      detail:
        "Connect with Grok through xAI's sign-in page. Requests use the connected plan's access and limits.",
      id: "grok",
      label: "Grok subscription",
      learnMoreUrl: XAI_ACCOUNTS_URL,
      models: grok?.models ?? [],
      status: grok ? "available" : "not-connected",
    },
  ];
}

export function aiProviderOption(
  id: AiProviderOption["id"],
  env?: Record<string, string | undefined>,
  connections?: ConnectionMetadata[]
) {
  return aiProviderCatalog(env, connections).find(
    (provider) => provider.id === id
  );
}
