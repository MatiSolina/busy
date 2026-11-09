import type { AiSettingsSnapshot } from "../ai/types";
import { type Billing, coveredByTokenPass, MODELS } from "../bots/models";
import type { BotRow } from "../db";

export interface ModelChoice {
  billing: Billing;
  bot?: BotRow;
  model: string;
  name: string;
}
const XAI_PREFIX = /^spacexai\//u;
const VENDOR_PREFIX = /^(?:openai|xai)\//u;
const SUBSCRIPTION_PREFIX = /^(?:chatgpt|grok)\//u;
export const canonicalModel = (model: string) =>
  model
    .replace(SUBSCRIPTION_PREFIX, "")
    .replace(XAI_PREFIX, "xai/")
    .replace(VENDOR_PREFIX, "");

function isConfiguredProvider(
  id: Billing,
  primary: BotRow,
  bots: BotRow[],
  settings: AiSettingsSnapshot
) {
  return (
    id === primary.billing ||
    settings.provider === id ||
    bots.some((bot) => bot.billing === id)
  );
}

function availableChoices(
  primary: BotRow,
  bots: BotRow[],
  settings: AiSettingsSnapshot
): ModelChoice[] {
  const choices: ModelChoice[] = [];
  for (const provider of settings.providers) {
    if (provider.status !== "available") {
      continue;
    }
    if (provider.id === "chatgpt" || provider.id === "grok") {
      for (const model of provider.models ?? []) {
        choices.push({
          billing: provider.id,
          model: model.id,
          name: model.label,
        });
      }
    } else if (isConfiguredProvider(provider.id, primary, bots, settings)) {
      for (const model of MODELS) {
        if (provider.id === "token-pass" && !coveredByTokenPass(model.id)) {
          continue;
        }
        choices.push({
          billing: provider.id,
          model: model.id,
          name: model.label,
        });
      }
    }
  }
  return choices;
}

export function chooseGuest(
  primary: BotRow,
  bots: BotRow[],
  settings: AiSettingsSnapshot
): ModelChoice | null {
  const choices = availableChoices(primary, bots, settings);
  const allowed = choices.filter(
    (c) => canonicalModel(c.model) !== canonicalModel(primary.model)
  );
  for (const peer of bots) {
    if (peer.id === primary.id || peer.status !== "ready") {
      continue;
    }
    const match = allowed.find(
      (c) =>
        c.billing === peer.billing &&
        canonicalModel(c.model) === canonicalModel(peer.model)
    );
    if (match) {
      return { ...match, bot: peer, name: peer.name };
    }
  }
  return (
    allowed.find((c) => c.billing !== primary.billing) ?? allowed[0] ?? null
  );
}
