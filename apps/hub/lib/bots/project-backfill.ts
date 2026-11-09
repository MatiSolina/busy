import { and, asc, eq, isNull } from "drizzle-orm";
import { bots, db } from "../db";
import type { VercelProject } from "../vercel/client";

export type BackfillOutcome =
  /** Linked now: the team project `bot-<slug>` holds the bot's own recorded deployment. */
  | "linked"
  /** Never deployed (no deployment id to prove ownership): its next deploy links it. */
  | "no-deployment"
  /** No team project with that exact name. */
  | "missing"
  /** The project exists but the bot's deployment isn't in it, or Vercel's answer didn't match. */
  | "mismatch"
  /** That project is already linked to another bot. */
  | "taken"
  /** Linked meanwhile by someone else (a deploy): nothing to do. */
  | "already-linked"
  /** Vercel couldn't be asked; rerun later. */
  | "error";

export interface BackfillVercel {
  /** The team's project with exactly this name, or null (lib/vercel/client.ts findProject). */
  findProject: (name: string) => Promise<VercelProject | null>;
  /** The project a deployment belongs to (lib/vercel/client.ts getDeploymentProjectId). */
  getDeploymentProjectId: (deploymentId: string) => Promise<string | null>;
}

/**
 * Links each bot without `vercel_project_id` to its Vercel project, only when Vercel proves it:
 * the team project named `bot-<slug>` must contain the deployment recorded on the row. Ambiguous,
 * missing or conflicting rows stay unlinked (their bot tokens keep being refused unless
 * BOT_OIDC_ALLOW_UNLINKED is on) and are reported. Never trusts a project id from a token.
 * Idempotent: a linked row is skipped and every link is conditional on the row still being unlinked.
 */
export async function backfillBotProjectIds(
  vercel: BackfillVercel,
  options: { dryRun?: boolean } = {}
): Promise<{ outcome: BackfillOutcome; slug: string }[]> {
  const rows = await db()
    .select({ deploymentId: bots.deploymentId, id: bots.id, slug: bots.slug })
    .from(bots)
    .where(isNull(bots.vercelProjectId))
    .orderBy(asc(bots.createdAt));
  const report: { outcome: BackfillOutcome; slug: string }[] = [];
  for (const row of rows) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential keeps well under the Vercel API's rate limits.
    const outcome = await backfillOne(vercel, row, options.dryRun === true);
    report.push({ outcome, slug: row.slug });
  }
  return report;
}

async function backfillOne(
  vercel: BackfillVercel,
  row: { deploymentId: string | null; id: string; slug: string },
  dryRun: boolean
): Promise<BackfillOutcome> {
  if (!row.deploymentId) {
    return "no-deployment";
  }
  let project: VercelProject | null;
  let owner: string | null;
  try {
    project = await vercel.findProject(`bot-${row.slug}`);
    owner = project
      ? await vercel.getDeploymentProjectId(row.deploymentId)
      : null;
  } catch {
    return "error";
  }
  if (!project) {
    return "missing";
  }
  if (owner !== project.id) {
    return "mismatch";
  }
  const [holder] = await db()
    .select({ id: bots.id })
    .from(bots)
    .where(eq(bots.vercelProjectId, project.id));
  if (holder) {
    return holder.id === row.id ? "already-linked" : "taken";
  }
  if (dryRun) {
    return "linked";
  }
  try {
    const [linked] = await db()
      .update(bots)
      .set({ vercelProjectId: project.id })
      .where(and(eq(bots.id, row.id), isNull(bots.vercelProjectId)))
      .returning({ id: bots.id });
    return linked ? "linked" : "already-linked";
  } catch (error) {
    // The unique index: another bot took it between the check and the write.
    if (uniqueViolation(error)) {
      return "taken";
    }
    throw error;
  }
}

function uniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const e = current as { cause?: unknown; code?: unknown };
    if (e.code === "23505") {
      return true;
    }
    current = e.cause;
  }
  return false;
}
