import { type AgentModelOptionsDefinition, defineAgent } from "eve";
import { defineDynamic } from "eve/models";
import config from "./config.json" with { type: "json" };
import { firesideModel, firesideProfile } from "./lib/fireside";
import { subscriptionModel } from "./lib/subscription-model";

const runtimeConfig = config as typeof config & {
  billing?: string;
};
const { billing } = runtimeConfig;
const subscriptionBilling = billing === "chatgpt" || billing === "grok";
export const subscriptionModelOptions: AgentModelOptionsDefinition = {
  providerOptions: {
    openai: {
      // Subscription responses are replayed from the durable session. Keep
      // every turn self-contained instead of referencing an upstream item
      // that the subscription provider may no longer retain.
      include: ["reasoning.encrypted_content"],
      store: false,
    },
  },
};
export default defineAgent({
  // Compact at 80% of the model's real window, as OpenBot does (docs/lazy-tools.md#compaction).
  compaction: { threshold: 0.8 },
  experimental: {
    // Keep run data so the hub can replay the stream after the app was closed (spec 4.3).
    workflow: { retention: "default" },
  },
  limits: {
    // One long-lived chat per bot (spec 4.1).
    sessionTimeoutMs: 365 * 24 * 60 * 60 * 1000,
  },
  model: defineDynamic(async (ctx) => {
    const fireside = await firesideProfile(ctx);
    if (fireside) {
      return {
        model: firesideModel(fireside, ctx),
        modelContextWindowTokens: 128_000,
        ...(fireside.billing === "chatgpt" || fireside.billing === "grok"
          ? { modelOptions: subscriptionModelOptions }
          : {}),
      };
    }
    return subscriptionBilling
      ? {
          model: subscriptionModel(
            billing,
            runtimeConfig.model,
            ctx.session.id
          ),
          modelContextWindowTokens: 128_000,
          modelOptions: subscriptionModelOptions,
        }
      : {
          model: runtimeConfig.model,
          // Fast requests AI Gateway's priority tier only on supported Gateway models.
          modelOptions: config.fast
            ? { providerOptions: { gateway: { serviceTier: "priority" } } }
            : undefined,
        };
  }),
});
