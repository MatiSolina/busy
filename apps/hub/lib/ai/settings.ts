import { eq } from "drizzle-orm";
import { type Billing, isSubscriptionBilling } from "../bots/models";
import { type AppAiSettingsRow, appAiSettings, db } from "../db";
import { aiProviderCatalog, aiProviderOption } from "./catalog";
import { type AiIssue, AiIssueError, aiIssue } from "./errors";
import { listGatewayModels } from "./gateway-models";
import { listSubscriptionConnections } from "./subscription-store";
import type { AiSettingsSnapshot } from "./types";

const DEFAULT_ID = "default";

function snapshot(
  row:
    | Pick<AppAiSettingsRow, "provider" | "model" | "onboardingCompletedAt">
    | undefined,
  providers: AiSettingsSnapshot["providers"]
): AiSettingsSnapshot {
  return {
    model: row?.model ?? null,
    onboardingCompleted: Boolean(row?.onboardingCompletedAt),
    provider: row?.provider ?? null,
    providers,
  };
}

export async function getAiSettings(
  env: Record<string, string | undefined> = process.env
): Promise<AiSettingsSnapshot> {
  const [row] = await db()
    .select({
      model: appAiSettings.model,
      onboardingCompletedAt: appAiSettings.onboardingCompletedAt,
      provider: appAiSettings.provider,
    })
    .from(appAiSettings)
    .where(eq(appAiSettings.id, DEFAULT_ID));
  const [connections, gatewayModels] = await Promise.all([
    listSubscriptionConnections(),
    listGatewayModels(),
  ]);
  const providers = aiProviderCatalog(env, connections).map((provider) =>
    provider.id === "gateway"
      ? { ...provider, models: gatewayModels }
      : provider
  );
  return snapshot(row, providers);
}

/**
 * Select the configured legacy billing mode for new deployments. Existing
 * bots keep their own billing field; this helper intentionally never updates
 * them.
 */
export async function getDefaultAiSelection(
  env: Record<string, string | undefined> = process.env
): Promise<{ billing: Billing; model?: string }> {
  const [row] = await db()
    .select({ model: appAiSettings.model, provider: appAiSettings.provider })
    .from(appAiSettings)
    .where(eq(appAiSettings.id, DEFAULT_ID));
  const provider = row?.provider ?? "token-pass";
  const connections = isSubscriptionBilling(provider)
    ? await listSubscriptionConnections()
    : [];
  const option = aiProviderOption(provider, env, connections);
  if (option?.status !== "available") {
    if (isSubscriptionBilling(provider)) {
      throw new AiProviderUnavailableError(
        aiIssue("connection_not_connected", provider, {
          action: "settings",
          message:
            "Reconnect your subscription in Settings before creating a bot.",
        })
      );
    }
    throw new AiProviderUnavailableError(
      aiIssue(
        provider === "gateway"
          ? "gateway_unavailable"
          : "provider_unconfigured",
        provider
      )
    );
  }
  if (isSubscriptionBilling(provider)) {
    if (
      !(row?.model && option.models?.some((model) => model.id === row.model))
    ) {
      throw new AiProviderUnavailableError(
        aiIssue("model_unavailable", provider, {
          message: "Choose an available subscription model in Settings.",
        })
      );
    }
    return { billing: provider, model: row.model };
  }
  return { billing: provider };
}

export async function getDefaultAiBilling(
  env: Record<string, string | undefined> = process.env
): Promise<Billing> {
  return (await getDefaultAiSelection(env)).billing;
}

export class AiProviderUnavailableError extends AiIssueError {
  constructor(
    issueOrMessage:
      | AiIssue
      | string = "Token Pass is not configured. Choose another AI connection in Settings."
  ) {
    const issue =
      typeof issueOrMessage === "string"
        ? aiIssue("provider_unconfigured", "token-pass", {
            message: issueOrMessage,
          })
        : issueOrMessage;
    super(issue, 409);
    this.name = "AiProviderUnavailableError";
  }
}

/** A prefix identifies routing; only the connected account can authorize a model. */
export async function assertSubscriptionModelAvailable(
  provider: Billing,
  model: string
): Promise<void> {
  if (!isSubscriptionBilling(provider)) {
    return;
  }
  const connections = await listSubscriptionConnections();
  const connection = connections.find((item) => item.provider === provider);
  if (!connection?.models.some((entry) => entry.id === model)) {
    throw new AiProviderUnavailableError(
      aiIssue("model_unavailable", provider, {
        message:
          "Choose a model available to your connected subscription in Settings.",
      })
    );
  }
}

export async function saveAiSettings(
  provider: Billing,
  env: Record<string, string | undefined> = process.env,
  model?: string
): Promise<AiSettingsSnapshot> {
  const connections = isSubscriptionBilling(provider)
    ? await listSubscriptionConnections()
    : [];
  const option = aiProviderOption(provider, env, connections);
  if (option?.status !== "available") {
    throw new AiProviderUnavailableError(
      isSubscriptionBilling(provider)
        ? aiIssue("connection_not_connected", provider, {
            message: "Connect your subscription before selecting it.",
          })
        : aiIssue(
            provider === "gateway"
              ? "gateway_unavailable"
              : "provider_unconfigured",
            provider
          )
    );
  }
  if (
    isSubscriptionBilling(provider) &&
    !(model && option.models?.some((entry) => entry.id === model))
  ) {
    throw new AiProviderUnavailableError(
      aiIssue("model_unavailable", provider, {
        message: "Choose an available subscription model.",
      })
    );
  }
  const savedModel = isSubscriptionBilling(provider) ? (model ?? null) : null;

  const now = new Date();
  await db()
    .insert(appAiSettings)
    .values({
      id: DEFAULT_ID,
      model: savedModel,
      onboardingCompletedAt: now,
      provider,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      set: {
        model: savedModel,
        onboardingCompletedAt: now,
        provider,
        updatedAt: now,
      },
      target: appAiSettings.id,
    });
  return getAiSettings(env);
}
