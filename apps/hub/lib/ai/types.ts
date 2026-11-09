import type { Billing } from "../bots/models";
import type { SubscriptionModel } from "./subscription-types";

export type AiProviderId = "chatgpt" | "grok" | "token-pass" | "gateway";

export interface AiProviderOption {
  accountLabel?: string | null;
  description: string;
  detail: string | null;
  id: AiProviderId;
  label: string;
  learnMoreUrl: string | null;
  models?: (SubscriptionModel & { fast?: boolean })[];
  status: "available" | "not-connected" | "unconfigured";
}

export interface AiSettingsSnapshot {
  model?: string | null;
  onboardingCompleted: boolean;
  provider: Billing | null;
  providers: AiProviderOption[];
}
