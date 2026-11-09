import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { asc, eq, sql } from "drizzle-orm";
import { type AppCapabilityRow, appCapabilities, db } from "@/lib/db";
import type {
  CapabilityInput,
  CapabilitySkill,
  PublicCapability,
  RuntimeSkill,
  SkillOrigin,
} from "./types";
import {
  CapabilityConflictError,
  CapabilityNotFoundError,
  MAX_ENABLED_CAPABILITIES,
  MAX_ENABLED_CONTENT_BYTES,
  MAX_ENABLED_SKILLS,
  parseCapabilitySkills,
} from "./validation";

export type CapabilityRow = AppCapabilityRow;
type DbTransaction = Parameters<
  Parameters<ReturnType<typeof db>["transaction"]>[0]
>[0];

export function publicCapability(row: CapabilityRow): PublicCapability {
  return {
    description: row.description,
    enabled: row.enabled,
    id: row.id,
    kind: row.kind,
    name: row.name,
    origin: row.origin ?? null,
    skills: parseCapabilitySkills(row.skills),
    version: row.version,
  };
}

export async function listCapabilities(): Promise<CapabilityRow[]> {
  return await db()
    .select()
    .from(appCapabilities)
    .orderBy(asc(appCapabilities.createdAt));
}

export async function getCapability(
  id: string
): Promise<CapabilityRow | undefined> {
  const [row] = await db()
    .select()
    .from(appCapabilities)
    .where(eq(appCapabilities.id, id));
  return row;
}

export async function createCapability(
  input: CapabilityInput,
  origin: SkillOrigin | null = null
): Promise<CapabilityRow> {
  return await db().transaction(async (tx) => {
    await lockApp(tx);
    return await insertCapability(tx, input, origin);
  });
}

async function insertCapability(
  tx: DbTransaction,
  input: CapabilityInput,
  origin: SkillOrigin | null
): Promise<CapabilityRow> {
  const id = randomUUID();
  await ensureEnabledCapacity(tx, { id, skills: input.skills });
  const [row] = await tx
    .insert(appCapabilities)
    .values({
      description: input.description,
      enabled: true,
      id,
      kind: input.kind,
      name: input.name,
      origin,
      skills: input.skills,
      version: input.version ?? null,
    })
    .returning()
    .catch((error: unknown) => {
      throw mapDatabaseError(error);
    });
  if (!row) {
    throw new Error("Capability was not created.");
  }
  return row;
}

/** What a catalog mutation decided after reading the locked rows. */
export type CatalogChange =
  | { create: CapabilityInput }
  | { id: string; update: CapabilityInput };

/**
 * Apply one semantic mutation to the shared catalog: `plan` sees the rows read under the app lock
 * and `FOR UPDATE`, so its decision (name taken, origin, merged skills) is made on the same
 * snapshot the write replaces. A read taken before this call can only be a UX preflight.
 */
export async function changeCapabilityCatalog(
  plan: (rows: readonly CapabilityRow[]) => CatalogChange
): Promise<{ created: boolean; row: CapabilityRow }> {
  return await db().transaction(async (tx) => {
    await lockApp(tx);
    const rows = await tx
      .select()
      .from(appCapabilities)
      .orderBy(asc(appCapabilities.createdAt))
      .for("update");
    const change = plan(rows);
    if ("create" in change) {
      return {
        created: true,
        row: await insertCapability(tx, change.create, null),
      };
    }
    const existing = rows.find((row) => row.id === change.id);
    if (!existing) {
      throw new CapabilityNotFoundError("Capability not found.");
    }
    return {
      created: false,
      row: await updateExistingCapability(
        tx,
        change.id,
        existing,
        change.update
      ),
    };
  });
}

/** Install a skills.sh revision atomically in the shared app catalog. */
export async function installRegistryCapability(
  input: CapabilityInput,
  origin: SkillOrigin
): Promise<{ row: CapabilityRow; reused: boolean }> {
  return await db().transaction(async (tx) => {
    await lockApp(tx);
    const rows = await tx.select().from(appCapabilities).for("update");
    const existing = rows.find(
      (candidateRow) =>
        candidateRow.origin?.registry === "skills.sh" &&
        candidateRow.origin.id === origin.id
    );
    if (existing) {
      if (existing.origin?.hash !== origin.hash) {
        throw new CapabilityConflictError(
          "A different revision of this skill is already installed."
        );
      }
      if (existing.origin.modified) {
        throw new CapabilityConflictError(
          "This skill has local edits; review them before reinstalling."
        );
      }
      if (!existing.enabled) {
        await ensureEnabledCapacity(tx, {
          id: existing.id,
          skills: parseCapabilitySkills(existing.skills),
        });
        const [row] = await tx
          .update(appCapabilities)
          .set({ enabled: true, updatedAt: new Date() })
          .where(eq(appCapabilities.id, existing.id))
          .returning();
        if (!row) {
          throw new Error("Capability could not be re-enabled.");
        }
        return { reused: true, row };
      }
      return { reused: true, row: existing };
    }
    const id = randomUUID();
    await ensureEnabledCapacity(tx, { id, skills: input.skills });
    const [row] = await tx
      .insert(appCapabilities)
      .values({
        description: input.description,
        enabled: true,
        id,
        kind: input.kind,
        name: input.name,
        origin,
        skills: input.skills,
        version: input.version ?? null,
      })
      .returning()
      .catch((error: unknown) => {
        throw mapDatabaseError(error);
      });
    if (!row) {
      throw new Error("Capability was not installed.");
    }
    return { reused: false, row };
  });
}

export async function updateCapability(
  id: string,
  patch: { enabled: boolean } | CapabilityInput
): Promise<CapabilityRow> {
  return await db().transaction(async (tx) => {
    await lockApp(tx);
    const existing = await selectCapability(tx, id, true);
    if (!existing) {
      throw new CapabilityNotFoundError("Capability not found.");
    }
    return updateExistingCapability(tx, id, existing, patch);
  });
}

async function updateExistingCapability(
  tx: DbTransaction,
  id: string,
  existing: AppCapabilityRow,
  patch: { enabled: boolean } | CapabilityInput
): Promise<AppCapabilityRow> {
  const enabled = "enabled" in patch ? patch.enabled : existing.enabled;
  if (enabled) {
    const candidate = "enabled" in patch ? existing.skills : patch.skills;
    await ensureEnabledCapacity(tx, {
      id: existing.id,
      skills: parseCapabilitySkills(candidate),
    });
  }
  if ("enabled" in patch) {
    const [row] = await tx
      .update(appCapabilities)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(appCapabilities.id, id))
      .returning();
    if (!row) {
      throw new Error("Capability could not be updated.");
    }
    return row;
  }
  if (patch.kind !== existing.kind) {
    throw new CapabilityConflictError("Capability kind cannot change.");
  }
  const changed =
    existing.name !== patch.name ||
    existing.description !== patch.description ||
    existing.version !== (patch.version ?? null) ||
    !isDeepStrictEqual(existing.skills, patch.skills);
  const origin = existing.origin
    ? { ...existing.origin, ...(changed ? { modified: true } : {}) }
    : null;
  const [row] = await tx
    .update(appCapabilities)
    .set({
      description: patch.description,
      enabled: existing.enabled,
      name: patch.name,
      origin,
      skills: patch.skills,
      updatedAt: new Date(),
      version: patch.version ?? null,
    })
    .where(eq(appCapabilities.id, id))
    .returning()
    .catch((error: unknown) => {
      throw mapDatabaseError(error);
    });
  if (!row) {
    throw new Error("Capability could not be updated.");
  }
  return row;
}

export async function removeCapability(id: string): Promise<void> {
  const result = await db().transaction(async (tx) => {
    await lockApp(tx);
    return tx
      .delete(appCapabilities)
      .where(eq(appCapabilities.id, id))
      .returning({ id: appCapabilities.id });
  });
  if (result.length === 0) {
    throw new CapabilityNotFoundError("Capability not found.");
  }
}

/** Runtime skills are intentionally independent of the requesting bot. */
export async function runtimeSkills(): Promise<RuntimeSkill[]> {
  const rows = await db()
    .select()
    .from(appCapabilities)
    .where(eq(appCapabilities.enabled, true))
    .orderBy(asc(appCapabilities.createdAt));
  return rows.flatMap((row) =>
    parseCapabilitySkills(row.skills).map((skill) => ({
      ...skill,
      name: runtimeSkillName(row.id, skill.name),
    }))
  );
}

export function runtimeSkillName(id: string, name: string): string {
  const digest = createHash("sha256")
    .update(`${id}\0${name}`)
    .digest("hex")
    .slice(0, 16);
  return `s_${digest}_${name.slice(0, 44)}`;
}

async function selectCapability(
  tx: DbTransaction,
  id: string,
  lock: boolean
): Promise<AppCapabilityRow | undefined> {
  const query = tx
    .select()
    .from(appCapabilities)
    .where(eq(appCapabilities.id, id));
  const rows = lock ? await query.for("update") : await query;
  return rows[0];
}

// A table-wide row lock is empty before the first install. Advisory locking
// gives create/enable/edit operations one stable app-level critical section
// even when several bots make model calls concurrently.
async function lockApp(tx: DbTransaction) {
  await tx.execute(sql`select pg_advisory_xact_lock(183746592)`);
}

async function ensureEnabledCapacity(
  tx: DbTransaction,
  candidate: { id: string; skills: CapabilitySkill[] }
) {
  const rows = await tx
    .select({ id: appCapabilities.id, skills: appCapabilities.skills })
    .from(appCapabilities)
    .where(eq(appCapabilities.enabled, true));
  const active = rows.filter((row) => row.id !== candidate.id);
  const enabledCount = active.length + 1;
  const enabledSkills =
    active.reduce(
      (sum, row) => sum + parseCapabilitySkills(row.skills).length,
      0
    ) + candidate.skills.length;
  const runtime = active.flatMap((row) =>
    parseCapabilitySkills(row.skills).map((skill) => ({
      ...skill,
      name: runtimeSkillName(row.id, skill.name),
    }))
  );
  runtime.push(
    ...candidate.skills.map((skill) => ({
      ...skill,
      name: runtimeSkillName(candidate.id, skill.name),
    }))
  );
  const encoded = new TextEncoder().encode(
    JSON.stringify({ skills: runtime })
  ).byteLength;
  if (enabledCount > MAX_ENABLED_CAPABILITIES) {
    throw new CapabilityConflictError(
      "The app already has the maximum number of enabled capabilities."
    );
  }
  if (enabledSkills > MAX_ENABLED_SKILLS) {
    throw new CapabilityConflictError(
      "The app already has the maximum number of enabled skills."
    );
  }
  if (encoded > MAX_ENABLED_CONTENT_BYTES) {
    throw new CapabilityConflictError(
      "Enabled capability content exceeds the app limit."
    );
  }
}

function mapDatabaseError(error: unknown): Error {
  if (databaseErrorCode(error) === "23505") {
    return new CapabilityConflictError(
      "A capability with this name already exists."
    );
  }
  return error instanceof Error
    ? error
    : new Error("Capability update failed.");
}

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const direct =
    "code" in error ? (error as { code?: unknown }).code : undefined;
  if (typeof direct === "string") {
    return direct;
  }
  const cause =
    "cause" in error ? (error as { cause?: unknown }).cause : undefined;
  return databaseErrorCode(cause);
}
