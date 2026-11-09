import { setTimeout } from "node:timers/promises";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { AiIssueError, aiIssue, sanitizeAiMessage } from "../ai/errors";
import { replaceMainSession } from "../chat/session";
import { botCall } from "../chat/store";
import { type BotRow, bots, db } from "../db";
import { need } from "../env";
import { prewarmSession } from "../eve/client";
import { hubPublicKey } from "../hub-token";
import {
  addProjectDomain,
  createDeployment,
  type DeploymentState,
  ensureProject,
  ensureTraceSampling,
  explicitPromotion,
  getDeploymentDetails,
  getDeploymentProjectId,
  getDeploymentState,
  getPromotionStatus,
  promoteDeployment,
  removeProjectEnv,
  setFunctionMemory,
  upsertProjectEnv,
} from "../vercel/client";
import {
  DEPLOY_DEADLINE_MS,
  DEPLOY_TIMED_OUT,
  DEPLOY_UNCONFIRMED,
  type DeployDeps,
  type DeploySettings,
  PROJECT_MISMATCH,
  PROMOTION_LEASE_MS,
  promotionAction,
  refreshStatus,
  startDeploy,
  traceSampleRate,
} from "./deploy";
import { coveredByTokenPass, isSubscriptionBilling } from "./models";
import { type DeployStep, loadDeployProgress } from "./progress";
import { slugify } from "./slug";

const fields = {
  avatar: z.string().max(40).nullish(),
  billing: z.enum(["token-pass", "gateway", "chatgpt", "grok"]),
  description: z.string().trim().min(1).max(140),
  fast: z.boolean(),
  instructions: z.string().max(8000),
  model: z
    .string()
    .max(200)
    .regex(/^[a-z0-9-]+\/[a-z0-9._:-]+$/u),
  name: z.string().trim().min(1).max(60),
};
export const botInput = z.object({
  ...fields,
  billing: fields.billing.default("gateway"),
  fast: fields.fast.default(false),
  instructions: fields.instructions.default(""),
  model: fields.model.default("moonshotai/kimi-k3"),
});
// No defaults here: an omitted field stays omitted, so a rename never resets the prompt or model.
export const botPatch = z.object(fields).partial();
const BOT_BASE_IMAGE_RE = /@sha256:[a-f0-9]{64}$/u;

/** What the app sees: no deploy ids, sessions or URLs. */
export const publicBot = (b: BotRow) => ({
  avatar: b.avatar,
  billing: b.billing,
  createdAt: b.createdAt,
  description: b.description,
  error: sanitizeAiMessage(b.error),
  fast: b.fast,
  instructions: b.instructions,
  model: b.model,
  name: b.name,
  slug: b.slug,
  status: b.status,
});
export type PublicBot = ReturnType<typeof publicBot>;

/** A Token Pass key gets a 403 on any model Token Pass doesn't cover: the bot would fail every message. */
export const billingFits = (bot: Pick<BotRow, "billing" | "model">) => {
  if (isSubscriptionBilling(bot.billing)) {
    return bot.model.startsWith(`${bot.billing}/`);
  }
  if (bot.billing === "gateway") {
    return !(bot.model.startsWith("chatgpt/") || bot.model.startsWith("grok/"));
  }
  return coveredByTokenPass(bot.model);
};

function settings(): DeploySettings {
  const botBaseImage = need("BOT_BASE_IMAGE");
  if (!BOT_BASE_IMAGE_RE.test(botBaseImage)) {
    throw new Error("BOT_BASE_IMAGE must be a digest-pinned image reference");
  }
  return {
    botBaseImage,
    botsDomain: need("BOTS_DOMAIN"),
    hubPublicKey: hubPublicKey(),
    hubUrl: need("HUB_URL"),
    teamSlug: need("VERCEL_TEAM_SLUG"),
    traceSampleRate: traceSampleRate(process.env.BOT_TRACE_SAMPLE_RATE),
  };
}

const vercelCfg = () => ({
  teamId: need("VERCEL_TEAM_ID"),
  token: need("VERCEL_TOKEN"),
});

function deps(): DeployDeps {
  const cfg = vercelCfg();
  return {
    addProjectDomain: (name, domain) => addProjectDomain(cfg, name, domain),
    createDeployment: (name, deployFiles) =>
      createDeployment(cfg, name, deployFiles),
    ensureProject: async (name) => {
      const result = await ensureProject(cfg, name);
      await setFunctionMemory(cfg, name);
      return result;
    },
    ensureTraceSampling: (name, percent) =>
      ensureTraceSampling(cfg, name, percent),
    getDeploymentState: (id) => getDeploymentState(cfg, id),
    // The helper's operationId is per main-session generation: a retried create returns the same
    // session, and a rotated bot that gets redeployed starts a new one.
    openMainSession: async (bot) =>
      (await replaceMainSession(bot, null, { call: botCall(bot.slug) }))
        .sessionId,
    removeProjectEnv: (name, key) => removeProjectEnv(cfg, name, key),
    upsertProjectEnv: (name, vars) => upsertProjectEnv(cfg, name, vars),
    warmSession: (slug, sessionId) => prewarmSession(botCall(slug), sessionId),
  };
}

/** Bots the app shows and routes to: one being deleted is gone for everyone but its deletion. */
const visible = sql`${bots.deletionState} is distinct from 'deleting'`;

export async function listBots(): Promise<BotRow[]> {
  return await db()
    .select()
    .from(bots)
    .where(visible)
    .orderBy(asc(bots.createdAt));
}

export async function getBot(slug: string): Promise<BotRow | undefined> {
  const [row] = await db()
    .select()
    .from(bots)
    .where(and(eq(bots.slug, slug), visible));
  return row;
}

/** Two creations with the same name raced past every free slug candidate: the route answers 409. */
export class SlugConflictError extends Error {
  constructor() {
    super("Could not reserve a free slug for this bot");
    this.name = "SlugConflictError";
  }
}

const SLUG_ATTEMPTS = 5;

/**
 * The unique slug is the authority: a concurrent create that takes the candidate first makes this
 * insert a no-op (ON CONFLICT on slug only), so the next attempt re-reads the slugs and takes the
 * next suffix. Any other unique violation still throws.
 */
export async function insertBot(
  input: z.infer<typeof botInput>
): Promise<BotRow> {
  for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt += 1) {
    const taken = new Set(
      // biome-ignore lint/performance/noAwaitInLoops: Each attempt must re-read the slugs a concurrent create just took.
      (await db().select({ slug: bots.slug }).from(bots)).map((r) => r.slug)
    );
    const [row] = await db()
      .insert(bots)
      .values({
        ...input,
        avatar: input.avatar ?? null,
        deployGeneration: 1,
        deployStartedAt: new Date(),
        slug: slugify(input.name, taken),
      })
      .onConflictDoNothing({ target: bots.slug })
      .returning();
    if (row) {
      return row;
    }
    // A concurrency signal, without the name or slug.
    console.warn("bot slug collision", { attempt });
    await setTimeout(Math.floor(Math.random() * 25 * attempt));
  }
  throw new SlugConflictError();
}

/** The deploy a workflow run owns: a bot row and the generation it was started for. */
export interface DeployTarget {
  botId: string;
  generation: number;
}

/** The v2 argument of deployBotWorkflow for the row's current generation. */
export type DeployRunArg = DeployTarget & { v: 2 };
export const deployRunArg = (bot: {
  deployGeneration: number;
  id: string;
}): DeployRunArg => ({
  botId: bot.id,
  generation: bot.deployGeneration,
  v: 2,
});

/** Every write of a deploy outcome names the generation (and deployment) it belongs to. */
const ofGeneration = (target: DeployTarget) =>
  and(eq(bots.id, target.botId), eq(bots.deployGeneration, target.generation));

/**
 * Interface for the bot deletion flow (owned elsewhere): a row being deleted carries a non-null
 * `deletionState`; a deploy run stops as soon as it sees one, or when the row is gone. Read
 * defensively so this module doesn't depend on that column's rollout.
 */
export function isBeingDeleted(row: object): boolean {
  const state = (row as { deletionState?: unknown }).deletionState;
  return state !== undefined && state !== null;
}

/** The row, while `target` is still its current generation and it isn't being deleted. */
export async function currentDeploy(
  target: DeployTarget
): Promise<BotRow | null> {
  const [row] = await db().select().from(bots).where(eq(bots.id, target.botId));
  if (
    !row ||
    row.deployGeneration !== target.generation ||
    isBeingDeleted(row)
  ) {
    return null;
  }
  return row;
}

/** The legacy workflow argument was a slug: adopt the row's current generation. */
export async function deployTargetOf(
  arg: string | DeployTarget
): Promise<DeployTarget | null> {
  if (typeof arg !== "string") {
    return arg;
  }
  const row = await getBot(arg);
  return row && !isBeingDeleted(row)
    ? { botId: row.id, generation: row.deployGeneration }
    : null;
}

/**
 * `start()` of the deploy workflow threw after the row was saved: show a retryable failure instead
 * of a silent "creating". Conditional on the generation, so a newer deploy is never overwritten.
 */
export async function markDeployStartFailed(bot: BotRow): Promise<BotRow> {
  const [row] = await db()
    .update(bots)
    .set({
      deployFinishedAt: new Date(),
      error: aiIssue("deployment_failed", bot.billing).message,
      status: "failed",
      updatedAt: new Date(),
    })
    .where(
      and(
        ofGeneration({ botId: bot.id, generation: bot.deployGeneration }),
        eq(bots.status, "creating"),
        isNull(bots.deploymentId)
      )
    )
    .returning();
  return row ?? (await getBot(bot.slug)) ?? bot;
}

/** A unique violation on the project id: that Vercel project already belongs to another bot. */
function projectTaken(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const e = current as {
      cause?: unknown;
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
    };
    if (
      e.code === "23505" &&
      (e.constraint === "bots_vercel_project_id_key" ||
        e.constraint_name === "bots_vercel_project_id_key")
    ) {
      return true;
    }
    current = e.cause;
  }
  return false;
}

async function failGeneration(
  target: DeployTarget,
  from: BotRow["status"],
  error: string,
  deploymentId: string | null
): Promise<void> {
  await db()
    .update(bots)
    .set({
      deployFinishedAt: new Date(),
      error,
      // A failure releases the promotion lease only when this deployment holds it.
      promotionDeploymentId: sql`case when ${bots.promotionDeploymentId} = ${deploymentId} then null else ${bots.promotionDeploymentId} end`,
      status: "failed",
      updatedAt: new Date(),
    })
    .where(
      and(
        ofGeneration(target),
        eq(bots.status, from),
        deploymentId === null
          ? isNull(bots.deploymentId)
          : eq(bots.deploymentId, deploymentId)
      )
    );
}

/**
 * Workflow step: build the target generation, once. "stale" when the generation moved on (its
 * deployment, if any, is never promoted); "adopted" when a deployment is already recorded for it
 * (a restarted run follows that one instead of building another).
 */
export async function deployBot(
  target: DeployTarget
): Promise<"adopted" | "failed" | "stale" | "started"> {
  const bot = await currentDeploy(target);
  if (!bot) {
    return "stale";
  }
  if (bot.status !== "creating" || bot.deploymentId) {
    return "adopted";
  }
  try {
    const { deploymentId, projectId } = await startDeploy(
      bot,
      { ...settings(), tokenPassKey: process.env.TOKEN_PASS_API_KEY },
      deps()
    );
    if (!projectId) {
      throw new Error("Vercel did not return the bot's project id");
    }
    const [row] = await db()
      .update(bots)
      .set({
        deploymentId,
        error: null,
        status: "deploying",
        updatedAt: new Date(),
        vercelProjectId: projectId,
      })
      .where(
        and(
          ofGeneration(target),
          eq(bots.status, "creating"),
          isNull(bots.deploymentId),
          or(isNull(bots.vercelProjectId), eq(bots.vercelProjectId, projectId))
        )
      )
      .returning({ id: bots.id });
    // Lost to a newer generation (or another run of this one): this deployment is never promoted.
    return row ? "started" : "stale";
  } catch (e) {
    // The bot shows a generic message; the cause stays in the logs.
    console.error("deploy start failed", {
      botId: target.botId,
      error: e instanceof Error ? e.message : String(e),
    });
    let { message } = aiIssue("deployment_failed", bot.billing);
    if (e instanceof AiIssueError) {
      ({ message } = e.issue);
    } else if (projectTaken(e)) {
      message = PROJECT_MISMATCH;
    }
    await failGeneration(target, "creating", message, null);
    return "failed";
  }
}

/** The deploy's steps for the app while the bot isn't ready (one or two Vercel reads while it builds). */
export async function botProgress(bot: BotRow): Promise<DeployStep[] | null> {
  return await loadDeployProgress(bot, (id) =>
    getDeploymentDetails(vercelCfg(), id)
  );
}

/**
 * A row deployed before project ids were stored: link it to the project its own recorded deployment
 * belongs to (Vercel says so), never to whatever project a token or a name claims.
 */
async function linkDeploymentProject(
  bot: BotRow,
  deploymentId: string
): Promise<string | null> {
  const projectId = await getDeploymentProjectId(vercelCfg(), deploymentId);
  if (!projectId) {
    return null;
  }
  const [row] = await db()
    .update(bots)
    .set({ vercelProjectId: projectId })
    .where(
      and(
        eq(bots.id, bot.id),
        eq(bots.deploymentId, deploymentId),
        isNull(bots.vercelProjectId)
      )
    )
    .returning({ id: bots.id });
  return row ? projectId : null;
}

/**
 * The deployment's state as refreshStatus should see it: "READY" only once Vercel confirms this
 * generation's deployment is production. Runs the promotion protocol (lib/bots/deploy.ts
 * promotionAction) under the bot's lease; every lease write is conditional on the generation,
 * the exact deployment and the lease it observed.
 */
async function promotedState(
  bot: BotRow,
  deploymentId: string,
  now: () => Date
): Promise<DeploymentState> {
  const cfg = vercelCfg();
  const state = await getDeploymentState(cfg, deploymentId);
  if (state !== "READY") {
    return state;
  }
  if (!explicitPromotion()) {
    // The deployment published itself (BOT_DEPLOY_PROMOTION off): READY is production. Linking the
    // project id stays best effort so identity (H-08) is recorded either way.
    if (!bot.vercelProjectId) {
      await linkDeploymentProject(bot, deploymentId).catch(() => null);
    }
    return state;
  }
  const projectId =
    bot.vercelProjectId ?? (await linkDeploymentProject(bot, deploymentId));
  if (!projectId) {
    return "BUILDING";
  }
  const action = promotionAction({
    deploymentId,
    lease: {
      deploymentId: bot.promotionDeploymentId,
      until: bot.promotionUntil,
    },
    now: now(),
    promotion: await getPromotionStatus(cfg, projectId),
    state,
  });
  if (action === "promoted") {
    return "READY";
  }
  if (action === "failed") {
    return "ERROR";
  }
  if (action === "wait") {
    return "BUILDING";
  }
  const [claimed] = await db()
    .update(bots)
    .set({
      promotionDeploymentId: deploymentId,
      promotionUntil: new Date(now().getTime() + PROMOTION_LEASE_MS),
    })
    .where(
      and(
        ofGeneration({ botId: bot.id, generation: bot.deployGeneration }),
        eq(bots.status, "deploying"),
        eq(bots.deploymentId, deploymentId),
        bot.promotionDeploymentId === null
          ? isNull(bots.promotionDeploymentId)
          : eq(bots.promotionDeploymentId, bot.promotionDeploymentId),
        bot.promotionUntil === null
          ? isNull(bots.promotionUntil)
          : eq(bots.promotionUntil, bot.promotionUntil)
      )
    )
    .returning({ id: bots.id });
  // ponytail: Vercel has no fencing token for the promote call. A newer generation that appears
  // while it's in flight waits for this request to settle (or the lease to expire) before promoting.
  // "current": Vercel confirms this exact deployment is production (a new project's first deploy).
  const promoted =
    claimed && (await promoteDeployment(cfg, projectId, deploymentId));
  return promoted === "current" ? "READY" : "BUILDING";
}

/** Past the deadline, a build Vercel still reports as building (and not mid-promotion) has timed out. */
async function buildTimedOut(
  bot: BotRow,
  deploymentId: string,
  late: boolean
): Promise<boolean> {
  return (
    late &&
    bot.promotionDeploymentId !== deploymentId &&
    (await getDeploymentState(vercelCfg(), deploymentId)) === "BUILDING"
  );
}

/** Applies refreshStatus' patch only to the generation, status and exact deployment it checked. */
async function applyRefresh(
  target: DeployTarget,
  bot: BotRow,
  patch: Partial<BotRow>,
  finishedAt: Date
): Promise<void> {
  const { deploymentId } = bot;
  const finished = patch.status === "ready" || patch.status === "failed";
  await db()
    .update(bots)
    .set({
      ...patch,
      ...(finished
        ? {
            deployFinishedAt: finishedAt,
            // Releases the promotion lease only when this deployment holds it.
            promotionDeploymentId: sql`case when ${bots.promotionDeploymentId} = ${deploymentId} then null else ${bots.promotionDeploymentId} end`,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        ofGeneration(target),
        eq(bots.status, bot.status),
        deploymentId === null
          ? isNull(bots.deploymentId)
          : eq(bots.deploymentId, deploymentId),
        patch.sessionId ? isNull(bots.sessionId) : undefined
      )
    );
}

/**
 * Workflow step: advance the target generation once. Writes only with the generation and the
 * exact deployment it checked; a session is only ever set where none is. "done" when there's
 * nothing more for this run to do.
 */
export async function refreshBot(
  target: DeployTarget,
  now: () => Date = () => new Date()
): Promise<"continue" | "done"> {
  const bot = await currentDeploy(target);
  if (!bot || bot.status === "failed") {
    return "done";
  }
  const late =
    now().getTime() >
    (bot.deployStartedAt ?? bot.updatedAt).getTime() + DEPLOY_DEADLINE_MS;
  if (bot.status === "creating") {
    // The build step of this generation didn't record a deployment: the reconciler takes over.
    return late ? "done" : "continue";
  }
  const { deploymentId } = bot;
  if (bot.status === "ready" ? Boolean(bot.sessionId) : !deploymentId) {
    return "done";
  }
  if (
    bot.status === "deploying" &&
    deploymentId &&
    (await buildTimedOut(bot, deploymentId, late))
  ) {
    await failGeneration(target, "deploying", DEPLOY_TIMED_OUT, deploymentId);
    return "done";
  }
  const patch = await refreshStatus(bot, settings(), {
    ...deps(),
    getDeploymentState: (id) => promotedState(bot, id, now),
  });
  if (Object.keys(patch).length) {
    await applyRefresh(target, bot, patch, now());
  }
  const next = { ...bot, ...patch };
  if (next.status === "failed" || (next.status === "ready" && next.sessionId)) {
    return "done";
  }
  // Ready without a session stays recoverable: opening it is the session helper's job, not the deploy's.
  return late ? "done" : "continue";
}

/** Fields that only change what the deployment builds: changing one starts a new generation. */
const needsDeploy = (bot: BotRow, patch: z.infer<typeof botPatch>) =>
  (patch.instructions !== undefined &&
    patch.instructions !== bot.instructions) ||
  (patch.model !== undefined && patch.model !== bot.model) ||
  (patch.billing !== undefined && patch.billing !== bot.billing) ||
  (patch.fast !== undefined && patch.fast !== bot.fast);

/** A retry was asked for a bot that isn't stuck or failed. */
export class DeployRetryConflictError extends Error {
  constructor() {
    super("Only a bot that is creating or failed can retry its deploy");
    this.name = "DeployRetryConflictError";
  }
}

/**
 * Saves the edit; when it changes what the bot builds (or it's a retry) it starts a new deploy
 * generation in the same UPDATE, so the config and the generation that builds it never diverge.
 * The previous generation's runs stop at their next step and their deployment is never promoted.
 */
export async function patchBot(
  bot: BotRow,
  patch: z.infer<typeof botPatch>,
  options: { retry?: boolean } = {}
): Promise<{ bot: BotRow; redeploy: boolean }> {
  if (options.retry && bot.status !== "creating" && bot.status !== "failed") {
    throw new DeployRetryConflictError();
  }
  // Name, avatar and description live in the hub and show at once; only the prompt, model and billing need a deploy (spec 4.1).
  // A bot whose deploy failed retries on any save, an empty one included: that's the app's Try again.
  const redeploy =
    options.retry === true ||
    bot.status === "failed" ||
    needsDeploy(bot, patch);
  const [row] = await db()
    .update(bots)
    .set({
      ...patch,
      ...(redeploy
        ? {
            deployFinishedAt: null,
            deployGeneration: sql`${bots.deployGeneration} + 1`,
            deploymentId: null,
            deployRecoveries: 0,
            deployStartedAt: new Date(),
            error: null,
            status: "creating" as const,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(bots.id, bot.id))
    .returning();
  if (!row) {
    throw new Error("Bot update did not return a row");
  }
  return { bot: row, redeploy };
}

/** A generation the workflow should have finished by now: restart it, a bounded number of times. */
export const STALE_CREATING_MS = 10 * 60_000;
export const STALE_DEPLOYING_MS = DEPLOY_DEADLINE_MS + 5 * 60_000;
export const MAX_DEPLOY_RECOVERIES = 3;

/**
 * Cron: every creating/deploying generation whose workflow should be over gets a new run of the
 * same generation, which adopts its recorded deployment instead of building another. Each restart
 * is claimed by a conditional increment, so overlapping crons start one run, and after
 * MAX_DEPLOY_RECOVERIES the generation becomes a visible, retryable failure. Never builds or
 * promotes by itself.
 */
export async function reconcileDeploys(
  startRun: (target: DeployTarget) => Promise<unknown>,
  now: Date = new Date()
): Promise<{ failed: number; restarted: number; startErrors: number }> {
  const startedAt = sql`coalesce(${bots.deployStartedAt}, ${bots.updatedAt})`;
  // The cutoff goes as an explicit timestamptz: compared with a raw expression, postgres.js gets no
  // column type for a JS Date and refuses to serialize it (PGlite accepts it, so tests did not see it).
  const olderThan = (ms: number) =>
    sql`${startedAt} < ${new Date(now.getTime() - ms).toISOString()}::timestamptz`;
  const stale = await db()
    .select({
      deployGeneration: bots.deployGeneration,
      deploymentId: bots.deploymentId,
      deployRecoveries: bots.deployRecoveries,
      id: bots.id,
      status: bots.status,
    })
    .from(bots)
    .where(
      or(
        and(eq(bots.status, "creating"), olderThan(STALE_CREATING_MS)),
        and(eq(bots.status, "deploying"), olderThan(STALE_DEPLOYING_MS))
      )
    )
    .limit(25);
  const result = { failed: 0, restarted: 0, startErrors: 0 };
  for (const bot of stale) {
    const target = { botId: bot.id, generation: bot.deployGeneration };
    const claim = and(
      ofGeneration(target),
      eq(bots.status, bot.status),
      eq(bots.deployRecoveries, bot.deployRecoveries)
    );
    if (bot.deployRecoveries >= MAX_DEPLOY_RECOVERIES) {
      // biome-ignore lint/performance/noAwaitInLoops: Few rows; each claim is its own conditional write.
      const [row] = await db()
        .update(bots)
        .set({
          deployFinishedAt: now,
          error: DEPLOY_UNCONFIRMED,
          status: "failed",
          updatedAt: now,
        })
        .where(claim)
        .returning({ id: bots.id });
      result.failed += row ? 1 : 0;
      continue;
    }
    const [row] = await db()
      .update(bots)
      .set({
        deployRecoveries: bot.deployRecoveries + 1,
        deployStartedAt: now,
        updatedAt: now,
      })
      .where(claim)
      .returning({ id: bots.id });
    if (!row) {
      continue;
    }
    console.warn("deploy reconciler restarting a generation", {
      attempt: bot.deployRecoveries + 1,
      botId: bot.id,
      hasDeployment: Boolean(bot.deploymentId),
    });
    try {
      await startRun(target);
      result.restarted += 1;
    } catch {
      // Claimed but not started: the next pass after the stale window tries again (bounded).
      result.startErrors += 1;
    }
  }
  return result;
}

// Deleting a bot is durable and lives in ./deletion.ts (requestBotDeletion + workflows/delete-bot.ts).
