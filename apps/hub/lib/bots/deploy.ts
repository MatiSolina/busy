import { AiIssueError, aiIssue } from "../ai/errors";
import { gatewaySupportsFast } from "../ai/gateway-models";
import type { BotRow } from "../db/schema";
import type { DeploymentState, PromotionStatus } from "../vercel/client";
import {
  type BotConfig,
  buildBotFiles,
  type DeployFile,
  rolloutFlags,
} from "./files";
import { type Billing, isSubscriptionBilling, supportsFast } from "./models";

export interface DeployDeps {
  addProjectDomain: (name: string, domain: string) => Promise<void>;
  createDeployment: (
    name: string,
    files: DeployFile[]
  ) => Promise<{ id: string; url: string }>;
  /** The project's real Vercel id (lib/vercel/client.ts ensureProject). */
  ensureProject: (name: string) => Promise<{ existed: boolean; id?: string }>;
  ensureTraceSampling: (name: string, percent: number) => Promise<unknown>;
  getDeploymentState: (id: string) => Promise<DeploymentState>;
  /**
   * Opens the bot's main session through lib/chat/session.ts: installed with a compare-and-set on
   * "no session", or the session Live/chat installed meanwhile is adopted. Never part of a patch.
   */
  openMainSession: (
    bot: Pick<BotRow, "id" | "slug" | "deploymentId">
  ) => Promise<string>;
  removeProjectEnv: (name: string, key: string) => Promise<void>;
  upsertProjectEnv: (
    name: string,
    vars: Record<string, string>
  ) => Promise<void>;
  /** eve prewarm of an existing session: moves it to the new deployment and boots its `flow`. */
  warmSession: (slug: string, sessionId: string) => Promise<unknown>;
}

export interface DeploySettings {
  /** Digest-pinned bot computer image owned by this hub operator. */
  botBaseImage: string;
  botsDomain: string;
  hubPublicKey: string;
  hubUrl: string;
  teamSlug: string;
  /** Production trace sampling for the bot's project, 1-100; 0 leaves it alone. */
  traceSampleRate: number;
}

/** `BOT_TRACE_SAMPLE_RATE`: a whole percentage 0-100, default 100. */
export function traceSampleRate(value: string | undefined): number {
  const rate = Number(value?.trim() || "100");
  return Number.isInteger(rate) && rate >= 0 && rate <= 100 ? rate : 100;
}

/** The bot's linked project and the one named `bot-<slug>` today are different projects. */
export const PROJECT_MISMATCH =
  "This bot's Vercel project changed. Ask the Busy account owner to repair it.";

/**
 * Every step is idempotent, so a failed or repeated deploy just runs again (plan task 7). The
 * deployment is built for production but not published: the caller promotes it under the bot's
 * promotion lease. A bot already linked to a Vercel project never deploys into another one.
 */
export async function startDeploy(
  bot: BotConfig & {
    id: string;
    billing: Billing;
    vercelProjectId?: string | null;
  },
  settings: DeploySettings & { tokenPassKey?: string },
  deps: DeployDeps
): Promise<{ deploymentId: string; projectId?: string }> {
  const project = `bot-${bot.slug}`;
  // No automatic fallback to paid AI Gateway (spec 4.9): not when Token Pass runs out, nor when its key is missing.
  const tokenPassKey =
    bot.billing === "token-pass" ? settings.tokenPassKey : undefined;
  if (bot.billing === "token-pass" && !tokenPassKey) {
    throw new AiIssueError(
      aiIssue("provider_unconfigured", "token-pass", {
        action: "contact-owner",
        message: "Token Pass is not configured for this Busy account.",
      }),
      409
    );
  }
  const { id: projectId } = await deps.ensureProject(project);
  if (bot.vercelProjectId && projectId !== bot.vercelProjectId) {
    throw new AiIssueError(
      aiIssue("deployment_failed", bot.billing, {
        action: "contact-owner",
        message: PROJECT_MISMATCH,
      }),
      409
    );
  }
  if (settings.traceSampleRate > 0) {
    // Observability only: a failed sampling update never blocks the deploy.
    await deps
      .ensureTraceSampling(project, settings.traceSampleRate)
      .catch(() => undefined);
  }
  await deps.upsertProjectEnv(project, {
    BOT_BASE_IMAGE: settings.botBaseImage,
    BOTS_DOMAIN: settings.botsDomain,
    // Verifies the hub's per-bot tokens (lib/hub-token.ts, agent/channels/eve.ts).
    HUB_PUBLIC_KEY: settings.hubPublicKey,
    HUB_URL: settings.hubUrl,
    VERCEL_TEAM_SLUG: settings.teamSlug,
    // No EVE_CALLBACK_TRUSTED_ORIGINS: with `https://*.<botsDomain>` a consulted bot sent its OIDC
    // token with each callback to the asking bot, which could replay it. eve sends it only to pass
    // Deployment Protection; the callback is authorized by its URL capability and goes to the asker's
    // production custom domain, which Standard Protection doesn't cover (docs/acceptance.md). A list
    // of origins would break consultations from bots created later (env changes need a redeploy).
    // The key bills Token Pass; without it the bot's OIDC bills AI Gateway credits (an OIDC never spends Token Pass).
    ...(tokenPassKey ? { AI_GATEWAY_API_KEY: tokenPassKey } : {}),
  });
  // A bot moved to AI Gateway drops the key, or it keeps paying with Token Pass.
  if (!tokenPassKey) {
    await deps.removeProjectEnv(project, "AI_GATEWAY_API_KEY");
  }
  await deps.addProjectDomain(project, `${bot.slug}.${settings.botsDomain}`);
  const { slug, name, description, instructions, model } = bot;
  // A model without a priority tier runs at standard speed, whatever was saved. ChatGPT plans
  // ignore `service_tier` on the token-sharing endpoint (measured: priority requested, default served).
  const fast =
    !isSubscriptionBilling(bot.billing) &&
    bot.fast &&
    (supportsFast(model) || (await gatewaySupportsFast(model)));
  const subscription = isSubscriptionBilling(bot.billing)
    ? { billing: bot.billing }
    : {};
  const { id } = await deps.createDeployment(
    project,
    buildBotFiles({
      description,
      fast,
      instructions,
      model,
      name,
      slug,
      ...subscription,
      ...rolloutFlags(slug),
    })
  );
  return { deploymentId: id, projectId };
}

export const BUILD_FAILED = "The deploy failed. Check the build in Vercel.";
export const DEPLOY_TIMED_OUT = "The deploy took too long. Try again.";
export const DEPLOY_UNCONFIRMED =
  "Busy could not confirm this deploy. Try again.";

/** A deploy that isn't READY (and promoted) by then is a visible, retryable failure. */
export const DEPLOY_DEADLINE_MS = 35 * 60_000;
/** How long a promotion request may stay invisible in Vercel before another runner may take over. */
export const PROMOTION_LEASE_MS = 2 * 60_000;

const PROMOTED = new Set(["succeeded", "skipped"]);
const SETTLED = new Set(["succeeded", "skipped", "failed"]);

export type PromotionAction =
  /** Still building, or a promotion (ours or another deployment's) is still running. */
  | "wait"
  /** The build failed, or Vercel failed our promotion. */
  | "failed"
  /** The lease is free, or its holder's promotion is confirmed settled/expired: take it and promote. */
  | "claim"
  /** We hold the lease but our request never showed up in Vercel before it expired: ask again. */
  | "promote"
  /** Vercel confirms our deployment is production ("skipped": it already was). */
  | "promoted";

/**
 * The promotion protocol for one READY deployment of the bot's current generation. Deployments are
 * built without assigning production domains, and only the holder of the bot's promotion lease
 * promotes: an older generation can never publish over a newer one, and two promotions never
 * overlap unless Vercel hides a request past the lease (the remaining external window).
 */
export function promotionAction(input: {
  deploymentId: string;
  lease: { deploymentId: string | null; until: Date | null };
  now: Date;
  promotion: PromotionStatus | null;
  state: DeploymentState;
}): PromotionAction {
  const { deploymentId, lease, now, promotion, state } = input;
  if (state === "BUILDING") {
    return "wait";
  }
  if (state === "ERROR") {
    return "failed";
  }
  const expired = !lease.until || lease.until.getTime() <= now.getTime();
  if (lease.deploymentId === deploymentId) {
    return ownPromotion(deploymentId, promotion, expired);
  }
  if (lease.deploymentId) {
    // Another deployment holds the lease: free only once Vercel settled its request, or when that
    // request never showed up before the lease expired.
    if (promotion?.toDeploymentId === lease.deploymentId) {
      return SETTLED.has(promotion.jobStatus) ? "claim" : "wait";
    }
    return expired ? "claim" : "wait";
  }
  return "claim";
}

function ownPromotion(
  deploymentId: string,
  promotion: PromotionStatus | null,
  expired: boolean
): PromotionAction {
  if (promotion?.toDeploymentId !== deploymentId) {
    return expired ? "promote" : "wait";
  }
  if (PROMOTED.has(promotion.jobStatus)) {
    return "promoted";
  }
  return promotion.jobStatus === "failed" ? "failed" : "wait";
}

type Refreshable = Pick<
  BotRow,
  "id" | "slug" | "status" | "deploymentId" | "sessionId"
>;

/** The patch to apply after checking the deploy; empty when nothing changed. */
export async function refreshStatus(
  bot: Refreshable,
  settings: DeploySettings,
  deps: DeployDeps
): Promise<Partial<BotRow>> {
  const patch: Partial<BotRow> = {};
  if (bot.status === "deploying" && bot.deploymentId) {
    const state = await deps.getDeploymentState(bot.deploymentId);
    if (state === "BUILDING") {
      return patch;
    }
    if (state === "ERROR") {
      return {
        error: BUILD_FAILED,
        status: "failed",
      };
    }
    Object.assign(patch, {
      error: null,
      status: "ready",
      url: `https://${bot.slug}.${settings.botsDomain}`,
    });
  }
  if (patch.status === "ready" && bot.sessionId) {
    // A redeploy leaves the session on the old deployment, and the first message would pay eve's
    // cross-deployment handoff (~8–9 s of cold invocations, vercel/eve#4603). Move it now. Best
    // effort: the send keeps its own retries.
    await deps.warmSession(bot.slug, bot.sessionId).catch(() => undefined);
  }
  const ready = patch.status === "ready" || bot.status === "ready";
  if (ready && !bot.sessionId) {
    // A retried create returns the same session, and a rotated bot (no session) that gets
    // redeployed starts a new one instead of getting its old one back. A brand-new subdomain can take a minute to answer; the next refresh retries. The helper writes
    // the session itself, so this patch can never overwrite one that Live or a chat opened.
    await deps.openMainSession(bot).catch(() => null);
  }
  return patch;
}
