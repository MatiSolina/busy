import { and, eq, isNull } from "drizzle-orm";
import type { JWTVerifyGetKey } from "jose";
import { bots, db } from "./db";
import { need } from "./env";
import { verifyBotRequest } from "./oidc";

/**
 * Compatibility window for rows deployed before `bots.vercel_project_id` existed: with
 * `BOT_OIDC_ALLOW_UNLINKED=1`, a row that has no linked project yet is still matched by slug.
 * Off by default; turn it off again once `scripts/backfill-bot-project-ids.ts` reports every
 * bot linked (docs/acceptance.md, "Bot identity"). A linked row is never matched by slug.
 */
export const allowUnlinkedBots = () =>
  process.env.BOT_OIDC_ALLOW_UNLINKED === "1";

const unauthorized = () => new Response("unauthorized", { status: 401 });

/**
 * Resolves the calling bot, or a 401 response to return as-is. The identity is the Vercel project
 * the token was minted for (`project_id`), which must be the project linked to the bot row; the
 * subject's slug must still be that row's slug. A project left over from a deleted bot, or any other
 * team project named `bot-<slug>`, is refused even when its slug matches.
 */
export async function botFromRequest(
  req: Request,
  opts: { jwks?: JWTVerifyGetKey } = {}
): Promise<{ slug: string } | Response> {
  let caller: { projectId: string; slug: string };
  try {
    caller = await verifyBotRequest(req, {
      jwks: opts.jwks,
      team: need("VERCEL_TEAM_SLUG"),
    });
  } catch {
    return unauthorized();
  }
  const [linked] = await db()
    .select({ deletionState: bots.deletionState, slug: bots.slug })
    .from(bots)
    .where(eq(bots.vercelProjectId, caller.projectId));
  if (linked?.deletionState) {
    // Its deletion has started: the old runtime gets nothing more from the hub (H-08/H-11).
    return new Response("bot deleted", { status: 410 });
  }
  if (linked) {
    if (linked.slug === caller.slug) {
      return { slug: linked.slug };
    }
    // Never log the token; ids and slugs are enough to investigate.
    console.warn("bot token slug mismatch", {
      projectId: caller.projectId,
      slug: caller.slug,
    });
    return unauthorized();
  }
  if (allowUnlinkedBots()) {
    const [legacy] = await db()
      .select({ slug: bots.slug })
      .from(bots)
      .where(
        and(
          eq(bots.slug, caller.slug),
          isNull(bots.vercelProjectId),
          isNull(bots.deletionState)
        )
      );
    if (legacy) {
      return { slug: legacy.slug };
    }
  }
  console.warn("bot token project mismatch", {
    projectId: caller.projectId,
    slug: caller.slug,
  });
  return unauthorized();
}
