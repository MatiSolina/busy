import { asc, eq } from "drizzle-orm";
import { botSectionMemberships, botSections, bots, db } from "@/lib/db";
import {
  BotNotFoundError,
  type Section,
  SectionConflictError,
  SectionNotFoundError,
} from "./types";

type Database = ReturnType<typeof db>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Transaction;

function uniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return false;
    }
    if ("code" in current && current.code === "23505") {
      return true;
    }
    current = "cause" in current ? current.cause : null;
  }
  return false;
}

function mapSectionError(error: unknown): unknown {
  return uniqueViolation(error) ? new SectionConflictError() : error;
}

async function selectSections(executor: Executor): Promise<Section[]> {
  const rows = await executor
    .select({
      botSlug: bots.slug,
      sectionId: botSections.id,
      sectionName: botSections.name,
    })
    .from(botSections)
    .leftJoin(
      botSectionMemberships,
      eq(botSectionMemberships.sectionId, botSections.id)
    )
    .leftJoin(bots, eq(botSectionMemberships.botId, bots.id))
    .orderBy(
      asc(botSections.createdAt),
      asc(botSections.id),
      asc(bots.createdAt),
      asc(bots.id)
    );

  const sections = new Map<string, Section>();
  for (const row of rows) {
    let section = sections.get(row.sectionId);
    if (!section) {
      section = { botSlugs: [], id: row.sectionId, name: row.sectionName };
      sections.set(row.sectionId, section);
    }
    if (row.botSlug) {
      section.botSlugs.push(row.botSlug);
    }
  }
  return [...sections.values()];
}

async function selectSection(
  executor: Executor,
  id: string
): Promise<Section | undefined> {
  return (await selectSections(executor)).find((section) => section.id === id);
}

export function listSections(): Promise<Section[]> {
  return selectSections(db());
}

export async function createSection(name: string): Promise<Section> {
  try {
    const [row] = await db().insert(botSections).values({ name }).returning();
    if (!row) {
      throw new Error("Section was not created.");
    }
    const section = await selectSection(db(), row.id);
    if (!section) {
      throw new SectionNotFoundError();
    }
    return section;
  } catch (error) {
    throw mapSectionError(error);
  }
}

export async function updateSection(
  id: string,
  name: string
): Promise<Section> {
  try {
    const [row] = await db()
      .update(botSections)
      .set({ name })
      .where(eq(botSections.id, id))
      .returning();
    if (!row) {
      throw new SectionNotFoundError();
    }
    const section = await selectSection(db(), row.id);
    if (!section) {
      throw new SectionNotFoundError();
    }
    return section;
  } catch (error) {
    throw mapSectionError(error);
  }
}

export async function deleteSection(id: string): Promise<void> {
  const [row] = await db()
    .delete(botSections)
    .where(eq(botSections.id, id))
    .returning({ id: botSections.id });
  if (!row) {
    throw new SectionNotFoundError();
  }
}

/** Assigns or clears one bot's section in one transaction. */
export async function setBotSection(
  botSlug: string,
  sectionId: string | null
): Promise<void> {
  try {
    await db().transaction(async (tx) => {
      const [bot] = await tx
        .select({ id: bots.id })
        .from(bots)
        .where(eq(bots.slug, botSlug))
        .for("update");
      if (!bot) {
        throw new BotNotFoundError();
      }

      if (sectionId === null) {
        await tx
          .delete(botSectionMemberships)
          .where(eq(botSectionMemberships.botId, bot.id));
        return;
      }

      const [section] = await tx
        .select({ id: botSections.id })
        .from(botSections)
        .where(eq(botSections.id, sectionId))
        .for("update");
      if (!section) {
        throw new SectionNotFoundError();
      }

      await tx
        .insert(botSectionMemberships)
        .values({ botId: bot.id, sectionId: section.id })
        .onConflictDoUpdate({
          set: { sectionId: section.id },
          target: botSectionMemberships.botId,
        });
    });
  } catch (error) {
    throw mapSectionError(error);
  }
}
