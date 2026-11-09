import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { botFromRequest } from "@/lib/bot-auth";
import { bots, db, events, memories } from "@/lib/db";
import { syncMemoryMetadata } from "@/lib/memory-metadata";

// Backend of the bot's fileMemory document (spec 4.5). A bot only reaches its own row.
export async function GET(req: Request) {
  const bot = await botFromRequest(req);
  if (bot instanceof Response) {
    return bot;
  }
  const [row] = await db()
    .select()
    .from(memories)
    .where(eq(memories.botSlug, bot.slug));
  return row
    ? Response.json({ content: row.content, version: row.version })
    : new Response(null, { status: 404 });
}

export async function PUT(req: Request) {
  const bot = await botFromRequest(req);
  if (bot instanceof Response) {
    return bot;
  }
  const parsed = z
    .object({
      content: z.string().max(262_144),
      expectedVersion: z.number().int().nullable(),
    })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return new Response("bad request", { status: 400 });
  }
  const { content, expectedVersion } = parsed.data;
  const result = await db().transaction(async (tx) => {
    // The first write has no row to lock. Serialize that path with the same
    // advisory key used by the owner's editable-memory route.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`busy:memory:${bot.slug}`}))`
    );
    const [existing] = await tx
      .select()
      .from(memories)
      .where(eq(memories.botSlug, bot.slug))
      .for("update");
    if ((existing?.version ?? null) !== expectedVersion) {
      return { conflict: true as const, version: existing?.version ?? null };
    }
    const nextVersion = (existing?.version ?? 0) + 1;
    const written = existing
      ? await tx
          .update(memories)
          .set({ content, version: nextVersion })
          .where(
            and(
              eq(memories.botSlug, bot.slug),
              eq(memories.version, expectedVersion ?? 0)
            )
          )
          .returning()
      : await tx
          .insert(memories)
          .values({ botSlug: bot.slug, content, version: nextVersion })
          .returning();
    const [row] = written;
    if (!row) {
      return { conflict: true as const, version: existing?.version ?? null };
    }
    // The authenticated bot identity is trustworthy, but this PUT has no Eve
    // turn/session context. The later provenance POST can attribute the exact
    // turn without inventing one here.
    await syncMemoryMetadata(tx, {
      botSlug: bot.slug,
      content: row.content,
      documentVersion: row.version,
      previousContent: existing?.content ?? null,
      source: {
        author: `bot:${bot.slug}`,
        messageId: null,
        origin: "bot",
        sessionId: null,
        sourceStatus: "bot_identity_only",
        turnId: null,
      },
    });
    return { conflict: false as const, row };
  });
  if (result.conflict) {
    return new Response("version conflict", { status: 409 });
  }
  return Response.json({
    content: result.row.content,
    version: result.row.version,
  });
}

async function turnBelongsToBot(
  botSlug: string,
  sessionId: string,
  turnId: string
) {
  const [bot] = await db()
    .select({ id: bots.id })
    .from(bots)
    .where(eq(bots.slug, botSlug));
  if (!bot) {
    return false;
  }
  const [event] = await db()
    .select({ sessionId: events.sessionId })
    .from(events)
    .where(
      and(
        eq(events.botId, bot.id),
        eq(events.sessionId, sessionId),
        eq(events.type, "turn.started"),
        sql`${events.data}->'scope'->>'turnId' = ${turnId}`
      )
    )
    .limit(1);
  return Boolean(event);
}

/**
 * Eve's memory backend cannot carry session context in its PUT contract. The
 * template's turn-completed hook calls this endpoint with trusted Eve context;
 * the bot identity still comes from OIDC, and the session is checked against
 * persisted hub events before a turn id is recorded.
 */
export async function POST(req: Request) {
  const bot = await botFromRequest(req);
  if (bot instanceof Response) {
    return bot;
  }
  const parsed = z
    .object({
      content: z.string().max(262_144),
      sessionId: z.string().min(1).max(256),
      turnId: z.string().min(1).max(256),
      version: z.number().int().positive(),
    })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return new Response("bad request", { status: 400 });
  }
  const verifiedTurn = await turnBelongsToBot(
    bot.slug,
    parsed.data.sessionId,
    parsed.data.turnId
  );
  const result = await db().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`busy:memory:${bot.slug}`}))`
    );
    const [row] = await tx
      .select()
      .from(memories)
      .where(eq(memories.botSlug, bot.slug))
      .for("update");
    if (
      !row ||
      row.version !== parsed.data.version ||
      row.content !== parsed.data.content
    ) {
      return { conflict: true as const };
    }
    await syncMemoryMetadata(tx, {
      botSlug: bot.slug,
      content: row.content,
      documentVersion: row.version,
      previousContent: row.content,
      source: {
        author: `bot:${bot.slug}`,
        messageId: null,
        origin: "bot",
        sessionId: verifiedTurn ? parsed.data.sessionId : null,
        sourceStatus: verifiedTurn ? "trusted_eve_turn" : "bot_identity_only",
        turnId: verifiedTurn ? parsed.data.turnId : null,
      },
    });
    return { conflict: false as const, row, verifiedTurn };
  });
  if (result.conflict) {
    return new Response("version conflict", { status: 409 });
  }
  return Response.json({
    content: result.row.content,
    sourceStatus: result.verifiedTurn
      ? "trusted_eve_turn"
      : "bot_identity_only",
    version: result.row.version,
  });
}
