import { experimental_decide } from "ai";
import { z } from "zod";
import { botTemplate } from "./marketplace";
import { type Billing, isSubscriptionBilling, MODELS } from "./models";
import { botInput } from "./service";

/** Fields the create screen is allowed to send. Runtime settings stay server-owned. */
export const botCreateInput = z.strictObject({
  avatar: z.string().trim().min(1).max(40).nullish(),
  description: z.string().trim().min(1).max(140),
  name: z.string().trim().min(1).max(60),
  templateId: z.string().trim().min(1).max(80).optional(),
});

export type BotCreateInput = z.infer<typeof botCreateInput>;
export type ResolvedBotCreate = z.infer<typeof botInput>;

const TOKEN_PASS_MODELS = MODELS.filter((model) => model.tokenPass);
const FALLBACK_MODEL = TOKEN_PASS_MODELS[0]?.id ?? "moonshotai/kimi-k3";
const DECISION_MODEL = "typesafe-ai/jev";
const DECISION_TIMEOUT_MS = 2500;

const modelChoice = Object.fromEntries(
  TOKEN_PASS_MODELS.map((model) => [model.id, `${model.label} (${model.id})`])
);

type DecisionOptions = Parameters<typeof experimental_decide>[0];
export type DecisionRunner = (
  options: DecisionOptions
) => ReturnType<typeof experimental_decide>;

export interface BotCreationDecisionState {
  description: string;
  instructions: string;
  name: string;
}

export class InvalidBotTemplateError extends Error {
  constructor(templateId: string) {
    super(`Unknown bot template: ${templateId}`);
    this.name = "InvalidBotTemplateError";
  }
}

function instructionsFor(input: BotCreateInput): string {
  if (!input.templateId) {
    return "";
  }
  const template = botTemplate(input.templateId);
  if (!template) {
    throw new InvalidBotTemplateError(input.templateId);
  }
  return template.instructions;
}

function decisionState(
  input: BotCreateInput,
  instructions: string
): BotCreationDecisionState {
  return {
    description: input.description,
    instructions,
    name: input.name,
  };
}

function modelFromChoice(choice: unknown): string | null {
  if (typeof choice !== "string") {
    return null;
  }
  return TOKEN_PASS_MODELS.some((model) => model.id === choice) ? choice : null;
}

/**
 * Choose a model for a new bot. The decision model is a server-side AI Gateway
 * call; every selectable result is still constrained to the Token Pass catalog.
 * An unavailable or malformed decision falls back to the first catalog model.
 */
export async function chooseCreationModel(
  state: BotCreationDecisionState,
  decide: DecisionRunner = experimental_decide,
  signal: AbortSignal = AbortSignal.timeout(DECISION_TIMEOUT_MS)
): Promise<string> {
  if (TOKEN_PASS_MODELS.length === 0) {
    return FALLBACK_MODEL;
  }

  try {
    const result = await decide({
      abortSignal: signal,
      maxRetries: 0,
      model: DECISION_MODEL,
      questions: {
        model: {
          criteria: modelChoice,
          instructions:
            "Choose the best language model for this bot. Prefer a Token Pass model whenever it can do the job. Return only one available model option; do not invent a model id.",
          type: "choice",
        },
      },
      state: {
        availableModels: TOKEN_PASS_MODELS.map(({ id, label }) => ({
          id,
          label,
        })),
        bot: {
          description: state.description,
          instructions: state.instructions,
          name: state.name,
        },
      },
    });
    const answer = (result as { answers?: { model?: { choice?: unknown } } })
      .answers?.model;
    return modelFromChoice(answer?.choice) ?? FALLBACK_MODEL;
  } catch {
    return FALLBACK_MODEL;
  }
}

/** Resolve catalog content and server-owned model settings before insertBot. */
export async function resolveBotCreation(
  input: BotCreateInput,
  decide: DecisionRunner = experimental_decide,
  billing: Billing = "token-pass",
  subscriptionModel?: string
): Promise<ResolvedBotCreate> {
  const instructions = instructionsFor(input);
  let model: string;
  if (isSubscriptionBilling(billing)) {
    if (!subscriptionModel?.startsWith(`${billing}/`)) {
      throw new Error("Choose a subscription model in Settings.");
    }
    model = subscriptionModel;
  } else {
    model = await chooseCreationModel(
      decisionState(input, instructions),
      decide
    );
  }

  return botInput.parse({
    avatar: input.avatar ?? null,
    billing,
    description: input.description,
    fast: false,
    instructions,
    model,
    name: input.name,
  });
}
