import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  SubscriptionModel,
  SubscriptionProvider,
} from "../ai/subscription-types";
import {
  CODE_TASK_COMMAND_KINDS,
  CODE_TASK_COMMAND_STATUSES,
  CODE_TASK_STATUSES,
} from "../code-tasks/types";
import type { FiresideState } from "../firesides/types";
import {
  BILLINGS,
  type Billing,
  CONSULTATION_STATUSES,
  type ConsultationStatus,
  FILE_STATUSES,
  type FileStatus,
  MCP_CONNECTION_STATUSES,
  type McpConnectionStatus,
} from "./status-values";

const created = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// Named CHECK constraints mirror apps/hub/drizzle/*.sql under the exact names
// PostgreSQL gave them (`<table>_<column>_check` for inline checks). Keep the
// two in sync: drizzle-kit drops any constraint it does not find here, and
// scripts/schema-drift.test.ts fails when they differ. Never run
// `drizzle-kit push` against a database that has data (docs/code-quality.md).
const oneOf = (column: AnyPgColumn, values: readonly string[]) =>
  sql`${column} in (${sql.raw(values.map((value) => `'${value}'`).join(", "))})`;

export const botStatus = pgEnum("bot_status", [
  "creating",
  "deploying",
  "ready",
  "failed",
]);

export const bots = pgTable(
  "bots",
  {
    avatar: text("avatar"),
    billing: text("billing").$type<Billing>().notNull().default("gateway"),
    createdAt: created(),
    // Deletion is a durable phase of the live row (lib/bots/deletion.ts, drizzle/0029): while it is set
    // the slug stays reserved, uploads are refused and a workflow retries the external effects.
    deletionAttempts: integer("deletion_attempts").notNull().default(0),
    deletionLastError: text("deletion_last_error"),
    deletionNextAttemptAt: timestamp("deletion_next_attempt_at", {
      withTimezone: true,
    }),
    // The Vercel project id captured once by the deletion; the project is only ever deleted by id.
    deletionProjectId: text("deletion_project_id"),
    deletionRequestedAt: timestamp("deletion_requested_at", {
      withTimezone: true,
    }),
    deletionState: text("deletion_state").$type<"deleting" | "attention">(),
    deletionToken: uuid("deletion_token"),
    deployFinishedAt: timestamp("deploy_finished_at", { withTimezone: true }),
    // Bumped with the config it builds on every create/redeploy/retry; deploy writes are conditional on it (0028).
    deployGeneration: integer("deploy_generation").notNull().default(0),
    // The current generation's deployment (cleared when the generation moves).
    deploymentId: text("deployment_id"),
    deployRecoveries: integer("deploy_recoveries").notNull().default(0),
    deployStartedAt: timestamp("deploy_started_at", { withTimezone: true }),
    description: text("description").notNull(),
    error: text("error"),
    // Fast mode: AI Gateway's priority tier, on the models that have one (lib/bots/models.ts).
    fast: boolean("fast").notNull().default(false),
    // Its session was opened before any message (the live screen did): the next message carries the history.
    historyPending: boolean("history_pending").notNull().default(false),
    id: uuid("id").primaryKey().defaultRandom(),
    instructions: text("instructions").notNull().default(""),
    // Someone has the bot's live screen open until then (lib/live.ts); its computer stays on.
    liveUntil: timestamp("live_until", { withTimezone: true }),
    model: text("model").notNull().default("moonshotai/kimi-k3"),
    name: text("name").notNull(),
    // Per-bot promotion lease: the deployment whose production promotion is in flight, until when.
    promotionDeploymentId: text("promotion_deployment_id"),
    promotionUntil: timestamp("promotion_until", { withTimezone: true }),
    sessionId: text("session_id"),
    slug: text("slug").notNull().unique(),
    status: botStatus("status").notNull().default("creating"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    url: text("url"),
    // Its Vercel project: bot OIDC tokens must carry this project_id (lib/bot-auth.ts).
    vercelProjectId: text("vercel_project_id"),
  },
  (t) => [
    uniqueIndex("bots_vercel_project_id_key").on(t.vercelProjectId),
    index("bots_deploy_pending_idx")
      .on(t.deployStartedAt)
      .where(sql`${t.status} in ('creating', 'deploying')`),
    check("bots_billing_check", oneOf(t.billing, BILLINGS)),
    check(
      "bots_deploy_generation_check",
      sql`${t.deployGeneration} >= 0 AND ${t.deployRecoveries} >= 0`
    ),
    check(
      "bots_deletion_state_check",
      sql`(${t.deletionState} IS NULL AND ${t.deletionToken} IS NULL) OR (${t.deletionState} IN ('deleting', 'attention') AND ${t.deletionToken} IS NOT NULL AND ${t.deletionRequestedAt} IS NOT NULL)`
    ),
    index("bots_deletion_due_idx")
      .on(t.deletionNextAttemptAt)
      .where(sql`${t.deletionState} IS NOT NULL`),
  ]
);
export type BotRow = typeof bots.$inferSelect;

// Written right before a deleted bot's row goes. Not a routing row and not unique by slug: a new bot
// may reuse the slug while late callbacks of the old id/project stay recognizable.
export const botTombstones = pgTable(
  "bot_tombstones",
  {
    botCreatedAt: timestamp("bot_created_at", { withTimezone: true }).notNull(),
    botId: uuid("bot_id").primaryKey(),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletionRequestedAt: timestamp("deletion_requested_at", {
      withTimezone: true,
    }).notNull(),
    slug: text("slug").notNull(),
    vercelProjectId: text("vercel_project_id"),
  },
  (t) => [
    index("bot_tombstones_slug_idx").on(t.slug),
    index("bot_tombstones_project_idx")
      .on(t.vercelProjectId)
      .where(sql`${t.vercelProjectId} IS NOT NULL`),
  ]
);

// The bot's computer as the hub coordinates it (lib/live.ts, drizzle/0031_bot_computers.sql): the
// keep-on generation, one shutdown claim tied to a session, a login hold and the reported sandbox name.
export const botComputers = pgTable(
  "bot_computers",
  {
    botId: uuid("bot_id")
      .primaryKey()
      .references(() => bots.id, { onDelete: "cascade" }),
    claim: uuid("claim"),
    claimAt: timestamp("claim_at", { withTimezone: true }),
    claimPhase: text("claim_phase").$type<"checking" | "stopping">(),
    claimSessionId: text("claim_session_id"),
    generation: integer("generation").notNull().default(0),
    holdSessionId: text("hold_session_id"),
    holdUntil: timestamp("hold_until", { withTimezone: true }),
    sandboxName: text("sandbox_name"),
    sandboxReportedAt: timestamp("sandbox_reported_at", { withTimezone: true }),
    sandboxSessionId: text("sandbox_session_id"),
  },
  (t) => [
    check(
      "bot_computers_claim_phase_check",
      sql`${t.claimPhase} IS NULL OR ${t.claimPhase} IN ('checking', 'stopping')`
    ),
    check(
      "bot_computers_claim_shape_check",
      sql`(${t.claim} IS NULL AND ${t.claimSessionId} IS NULL AND ${t.claimPhase} IS NULL AND ${t.claimAt} IS NULL) OR (${t.claim} IS NOT NULL AND ${t.claimSessionId} IS NOT NULL AND ${t.claimPhase} IS NOT NULL AND ${t.claimAt} IS NOT NULL)`
    ),
    check(
      "bot_computers_hold_shape_check",
      sql`(${t.holdSessionId} IS NULL) = (${t.holdUntil} IS NULL)`
    ),
    check(
      "bot_computers_sandbox_shape_check",
      sql`(${t.sandboxSessionId} IS NULL AND ${t.sandboxName} IS NULL AND ${t.sandboxReportedAt} IS NULL) OR (${t.sandboxSessionId} IS NOT NULL AND ${t.sandboxName} IS NOT NULL AND ${t.sandboxReportedAt} IS NOT NULL)`
    ),
  ]
);

export const firesides = pgTable(
  "firesides",
  {
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    createdAt: created(),
    id: uuid("id").primaryKey(),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    originId: uuid("origin_id").notNull().unique(),
    parentSessionId: text("parent_session_id"),
    state: jsonb("state").$type<FiresideState>().notNull(),
    status: text("status").$type<FiresideState["status"]>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    version: integer("version").notNull().default(0),
  },
  (t) => [
    index("firesides_bot_created_idx").on(t.botId, t.createdAt),
    uniqueIndex("firesides_active_bot_idx")
      .on(t.botId)
      .where(sql`${t.status} in ('running', 'waiting', 'paused', 'closing')`),
    check(
      "firesides_status_check",
      oneOf(t.status, [
        "running",
        "waiting",
        "paused",
        "closing",
        "closed",
        "failed",
      ])
    ),
  ]
);
export type FiresideRow = typeof firesides.$inferSelect;

export const firesideCommands = pgTable("fireside_commands", {
  createdAt: created(),
  firesideId: uuid("fireside_id")
    .notNull()
    .references(() => firesides.id, { onDelete: "cascade" }),
  id: uuid("id").primaryKey(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
});

// drizzle/0034: the single durable runner of a fireside (lib/firesides/runner.ts).
export const firesideRunners = pgTable(
  "fireside_runners",
  {
    attempts: integer("attempts").notNull().default(0),
    createdAt: created(),
    firesideId: uuid("fireside_id")
      .primaryKey()
      .references(() => firesides.id, { onDelete: "cascade" }),
    generation: integer("generation").notNull().default(1),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    lastError: text("last_error"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    runId: uuid("run_id").notNull(),
    status: text("status").$type<"starting" | "active" | "idle">().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    wakes: integer("wakes").notNull().default(0),
    workflowRunId: text("workflow_run_id"),
  },
  (t) => [
    index("fireside_runners_status_lease_idx").on(t.status, t.leaseUntil),
    check(
      "fireside_runners_status_check",
      sql`${t.status} in ('starting', 'active', 'idle')`
    ),
  ]
);

// Sections are hub navigation metadata. Membership is kept in its own table so
// the bot row and deployment payload stay unchanged; one bot can be in at most
// one section because bot_id is the membership primary key.
export const botSections = pgTable(
  "bot_sections",
  {
    createdAt: created(),
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
  },
  (t) => [
    uniqueIndex("bot_sections_name_ci_idx").on(sql`lower(${t.name})`),
    check(
      "bot_sections_name_check",
      sql`${t.name} = btrim(${t.name}) and length(${t.name}) between 1 and 60`
    ),
  ]
);
export type BotSectionRow = typeof botSections.$inferSelect;

export const botSectionMemberships = pgTable(
  "bot_section_memberships",
  {
    botId: uuid("bot_id")
      .primaryKey()
      .references(() => bots.id, { onDelete: "cascade" }),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => botSections.id, { onDelete: "cascade" }),
  },
  (t) => [index("bot_section_memberships_section_idx").on(t.sectionId)]
);
export type BotSectionMembershipRow = typeof botSectionMemberships.$inferSelect;

// Credentials are encrypted by lib/mcp/crypto.ts. MCP connections are app-level
// configuration; bot_id is retained only as legacy provenance for rows created
// before the app-wide migration and is never used for authorization or deletes.
export const mcpConnections = pgTable(
  "mcp_connections",
  {
    botId: uuid("bot_id"),
    catalogId: text("catalog_id").notNull(),
    createdAt: created(),
    error: text("error"),
    id: uuid("id").primaryKey().defaultRandom(),
    oauthData: text("oauth_data"),
    status: text("status")
      .$type<McpConnectionStatus>()
      .notNull()
      .default("pending"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "mcp_connections_status_check",
      oneOf(t.status, MCP_CONNECTION_STATUSES)
    ),
  ]
);
export type McpConnectionRow = typeof mcpConnections.$inferSelect;

// Full MCP results may include app-only data that must never enter the model's
// history. Store a sealed snapshot and expose only its opaque id to Eve.
export const mcpAppResults = pgTable(
  "mcp_app_results",
  {
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    callId: text("call_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => mcpConnections.id, { onDelete: "cascade" }),
    createdAt: created(),
    id: uuid("id").primaryKey().defaultRandom(),
    sealedResult: text("sealed_result").notNull(),
    sessionId: text("session_id").notNull(),
    toolName: text("tool_name").notNull(),
  },
  (table) => [
    index("mcp_app_results_session_idx").on(table.botId, table.sessionId),
    unique("mcp_app_results_call_unique").on(
      table.botId,
      table.sessionId,
      table.callId,
      table.connectionId
    ),
  ]
);

// App registrations and encrypted provider grants are shared by the hub.
export const mcpProviderClients = pgTable(
  "mcp_provider_clients",
  {
    provider: text("provider").$type<"github" | "google">().primaryKey(),
    sealedClient: text("sealed_client").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    version: uuid("version").notNull().defaultRandom(),
  },
  (t) => [
    check(
      "mcp_provider_clients_provider_check",
      oneOf(t.provider, ["github", "google"])
    ),
  ]
);

// Legacy per-bot rows retained for rollback and migration history. New writes
// use appCapabilities below; bots read the shared app catalog at call time.
export const botCapabilities = pgTable(
  "bot_capabilities",
  {
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    createdAt: created(),
    description: text("description").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<"skill" | "plugin">().notNull(),
    name: text("name").notNull(),
    origin: jsonb("origin").$type<
      import("../capabilities/types").SkillOrigin | null
    >(),
    skills: jsonb("skills")
      .$type<import("../capabilities/types").CapabilitySkill[]>()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    version: text("version"),
  },
  (t) => [
    unique().on(t.botId, t.kind, t.name),
    check("bot_capabilities_kind_check", oneOf(t.kind, ["skill", "plugin"])),
  ]
);
export type BotCapabilityRow = typeof botCapabilities.$inferSelect;

// App-owned capabilities are shared by every bot. The bot runtime reads this
// catalog at call time, so choosing which capability to use remains an agent
// decision rather than part of a bot's identity/configuration.
export const appCapabilities = pgTable(
  "app_capabilities",
  {
    createdAt: created(),
    description: text("description").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<"skill" | "plugin">().notNull(),
    name: text("name").notNull(),
    origin: jsonb("origin").$type<
      import("../capabilities/types").SkillOrigin | null
    >(),
    skills: jsonb("skills")
      .$type<import("../capabilities/types").CapabilitySkill[]>()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    version: text("version"),
  },
  (t) => [
    unique().on(t.kind, t.name),
    check("app_capabilities_kind_check", oneOf(t.kind, ["skill", "plugin"])),
  ]
);
export type AppCapabilityRow = typeof appCapabilities.$inferSelect;

// Marks legacy bot_capabilities rows already copied by 0012_app_capabilities.sql.
export const appCapabilityMigrations = pgTable("app_capability_migrations", {
  migratedAt: timestamp("migrated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  sourceId: uuid("source_id").primaryKey(),
});

// Recurrence belongs to the hub, so creating or changing a routine needs no bot deployment.
export const routines = pgTable(
  "routines",
  {
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    createdAt: created(),
    daysOfWeek: jsonb("days_of_week").$type<number[]>().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(true),
    id: uuid("id").primaryKey(),
    // Occurrences not run because the previous one was still active (0030).
    lastSkippedAt: timestamp("last_skipped_at", { withTimezone: true }),
    lastSkipReason:
      text("last_skip_reason").$type<
        import("../routines/types").RoutineSkipReason
      >(),
    name: text("name").notNull(),
    // ponytail: unused since Vercel Schedules. Kept (nullable) until the performance A/B can push a
    // schema that drops a column the base branch still reads; then drop it with the leases below.
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    prompt: text("prompt").notNull(),
    // Bumped with every change to the Vercel schedule, in the same transaction as its outbox job.
    scheduleGeneration: integer("schedule_generation").notNull().default(1),
    skippedOccurrences: integer("skipped_occurrences").notNull().default(0),
    time: text("time").notNull(),
    timeZone: text("time_zone").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("routines_bot_idx").on(t.botId, t.createdAt),
    check("routines_name_check", sql`length(${t.name}) between 1 and 100`),
    check(
      "routines_prompt_check",
      sql`length(${t.prompt}) between 1 and 20000`
    ),
    check(
      "routines_time_check",
      sql`${t.time} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`
    ),
    check(
      "routines_days_of_week_check",
      sql`jsonb_typeof(${t.daysOfWeek}) = 'array' and jsonb_array_length(${t.daysOfWeek}) between 1 and 7`
    ),
    check(
      "routines_last_skip_reason_check",
      sql`${t.lastSkipReason} in ('active_run', 'awaiting_input', 'duplicate_occurrence')`
    ),
  ]
);
export type RoutineRow = typeof routines.$inferSelect;

// One row per Vercel Schedules execution; its id (derived from the execution id) is eve's message idempotency key.
export const routineRuns = pgTable(
  "routine_runs",
  {
    attempts: integer("attempts").notNull().default(0),
    // Subordinate to `status` (0030): the turn is paused on a question, approval or sign-in.
    awaitingInputAt: timestamp("awaiting_input_at", { withTimezone: true }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    createdAt: created(),
    deliveryId: text("delivery_id"),
    error: text("error"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    id: uuid("id").primaryKey().defaultRandom(),
    // Last time the monitor could read the pinned session (0030); the cron sweep orders by it.
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    // ponytail: unused since Vercel Schedules; see `routines.nextRunAt`.
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    prompt: text("prompt").notNull(),
    retryAt: timestamp("retry_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    routineId: uuid("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    // A retry must use the same session, even if the bot's main session later changes.
    sessionId: text("session_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    status: text("status")
      .$type<import("../routines/types").RoutineRunStatus>()
      .notNull()
      .default("pending"),
  },
  (t) => [
    unique("routine_runs_occurrence_unique").on(t.routineId, t.scheduledFor),
    index("routine_runs_pending_idx").on(t.status, t.retryAt),
    index("routine_runs_bot_idx").on(t.botId),
    uniqueIndex("routine_runs_one_active_idx")
      .on(t.routineId)
      .where(sql`${t.status} in ('pending', 'dispatched')`),
    check(
      "routine_runs_status_check",
      oneOf(t.status, [
        "pending",
        "dispatched",
        "succeeded",
        "failed",
        "cancelled",
      ])
    ),
    index("routine_runs_dispatched_observed_idx")
      .on(t.lastObservedAt)
      .where(sql`${t.status} = 'dispatched'`),
  ]
);
export type RoutineRunRow = typeof routineRuns.$inferSelect;

// One durable Vercel Schedules sync job per routine (lib/routines/outbox.ts). No foreign key: a
// routine removed with its bot still needs the job that deletes its schedule.
export const routineScheduleOutbox = pgTable(
  "routine_schedule_outbox",
  {
    action: text("action")
      .$type<import("../routines/outbox").RoutineScheduleAction>()
      .notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    botId: uuid("bot_id").notNull(),
    createdAt: created(),
    generation: integer("generation").notNull(),
    lastError: text("last_error"),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    routineId: uuid("routine_id").primaryKey(),
    status: text("status")
      .$type<"pending" | "applied">()
      .notNull()
      .default("pending"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("routine_schedule_outbox_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    check(
      "routine_schedule_outbox_action_check",
      sql`${t.action} in ('upsert', 'disable', 'delete')`
    ),
    check(
      "routine_schedule_outbox_status_check",
      sql`${t.status} in ('pending', 'applied')`
    ),
  ]
);

// One fileMemory document per bot (spec 4.5).
export const memories = pgTable("memories", {
  botSlug: text("bot_slug")
    .primaryKey()
    .references(() => bots.slug, { onDelete: "cascade" }),
  content: text("content").notNull(),
  version: integer("version").notNull(),
});

const MEMORY_ORIGINS = ["bot", "legacy", "owner"];
const MEMORY_SOURCE_STATUSES = [
  "bot_identity_only",
  "legacy",
  "trusted_eve_turn",
  "trusted_user",
  "unavailable",
];

// Entry metadata supplements the existing Eve document without changing its format.
export const memoryMetadata = pgTable(
  "memory_metadata",
  {
    author: text("author"),
    botSlug: text("bot_slug")
      .notNull()
      .references(() => bots.slug, { onDelete: "cascade" }),
    createdAt: created(),
    entryId: text("entry_id").notNull(),
    messageId: text("message_id"),
    origin: text("origin")
      .$type<import("../memory-metadata").MemoryOrigin>()
      .notNull(),
    sessionId: text("session_id"),
    sourceStatus: text("source_status")
      .$type<import("../memory-metadata").MemorySourceStatus>()
      .notNull(),
    text: text("text").notNull(),
    turnId: text("turn_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.botSlug, t.entryId] }),
    index("memory_metadata_bot_updated_idx").on(
      t.botSlug,
      t.updatedAt,
      t.entryId
    ),
    check("memory_metadata_entry_id_check", sql`${t.entryId} ~ '^[0-9]+$'`),
    check("memory_metadata_origin_check", oneOf(t.origin, MEMORY_ORIGINS)),
    check(
      "memory_metadata_source_status_check",
      oneOf(t.sourceStatus, MEMORY_SOURCE_STATUSES)
    ),
  ]
);

export const memoryMetadataEvents = pgTable(
  "memory_metadata_events",
  {
    action: text("action")
      .$type<import("../memory-metadata").MemoryChange>()
      .notNull(),
    afterText: text("after_text"),
    author: text("author"),
    beforeText: text("before_text"),
    botSlug: text("bot_slug")
      .notNull()
      .references(() => bots.slug, { onDelete: "cascade" }),
    changeKey: text("change_key").notNull(),
    createdAt: created(),
    documentVersion: integer("document_version").notNull(),
    entryId: text("entry_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: text("message_id"),
    origin: text("origin")
      .$type<import("../memory-metadata").MemoryOrigin>()
      .notNull(),
    sessionId: text("session_id"),
    sourceStatus: text("source_status")
      .$type<import("../memory-metadata").MemorySourceStatus>()
      .notNull(),
    turnId: text("turn_id"),
  },
  (t) => [
    unique().on(t.botSlug, t.changeKey),
    index("memory_metadata_events_bot_entry_idx").on(
      t.botSlug,
      t.entryId,
      t.createdAt
    ),
    check(
      "memory_metadata_events_entry_id_check",
      sql`${t.entryId} ~ '^[0-9]+$'`
    ),
    check(
      "memory_metadata_events_document_version_check",
      sql`${t.documentVersion} > 0`
    ),
    check(
      "memory_metadata_events_action_check",
      oneOf(t.action, ["added", "attributed", "removed", "updated"])
    ),
    check(
      "memory_metadata_events_origin_check",
      oneOf(t.origin, MEMORY_ORIGINS)
    ),
    check(
      "memory_metadata_events_source_status_check",
      oneOf(t.sourceStatus, MEMORY_SOURCE_STATUSES)
    ),
  ]
);

// Persisted eve stream facts, keyed by their stream position (spec 4.3).
export const events = pgTable(
  "events",
  {
    at: timestamp("at", { withTimezone: true }).notNull(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    data: jsonb("data").notNull(),
    index: integer("index").notNull(),
    line: integer("line").notNull(),
    sessionId: text("session_id").notNull(),
    type: text("type").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.line, t.index] })]
);

export const cursors = pgTable("cursors", {
  botId: uuid("bot_id")
    .notNull()
    .references(() => bots.id, { onDelete: "cascade" }),
  nextLine: integer("next_line").notNull().default(0),
  sessionId: text("session_id").primaryKey(),
});

// drizzle/0033: in-flight fast-path slots (docs/fast-path.md). A row lives from the reservation,
// taken before the model runs, until the events are stored (same transaction) or it is released.
export const fastSlotReservations = pgTable(
  "fast_slot_reservations",
  {
    createdAt: created(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    line: integer("line").notNull(),
    messageId: uuid("message_id").notNull(),
    sessionId: text("session_id").notNull(),
    slotIndex: integer("slot_index").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.line, t.slotIndex] }),
    index("fast_slot_reservations_message_idx").on(t.messageId),
  ]
);

export const messageStatus = pgEnum("message_status", [
  "pending",
  "accepted",
  "failed",
]);

/** Fixed reasons of a failed or unresolved delivery attempt (CHECK in 0026_session_bindings.sql). */
export type MessageFailure =
  | "ambiguous"
  | "not_admitted"
  | "not_sent"
  | "rejected"
  | "session_gone"
  | "unconfirmed";

// Client-generated id = eve idempotencyKey.
export const messages = pgTable(
  "messages",
  {
    // Unused since the merge with #195: `message_delivery_attempts` is the delivery identity
    // (lib/chat/attempts.ts). Kept because 0026 is applied in production; no destructive migration.
    attempt: integer("attempt").notNull().default(0),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    // When the message sweeper may look at it again (lib/chat/attempts.ts; null: due when unknown).
    checkAfter: timestamp("check_after", { withTimezone: true }),
    checks: integer("checks").notNull().default(0),
    clientContext: jsonb("client_context").$type<{
      timeZone?: string;
    }>(),
    createdAt: created(),
    deliveryId: text("delivery_id"),
    failure: text("failure").$type<MessageFailure>(),
    fileIds: jsonb("file_ids").$type<string[]>().notNull().default([]),
    id: uuid("id").primaryKey(),
    payloadHash: text("payload_hash"),
    // Snapshot of the first delivery's selection (0020_message_skill_snapshots.sql).
    selectedSkills: jsonb("selected_skills")
      .$type<import("../chat/deliver").MessagePayload["selectedSkills"]>()
      .notNull()
      .default([]),
    // The session that admitted it, projected from `message_delivery_attempts` on acceptance (H-35).
    sessionId: text("session_id"),
    status: messageStatus("status").notNull().default("pending"),
    text: text("text").notNull(),
  },
  (t) => [
    index("messages_payload_hash_idx")
      .on(t.botId, t.payloadHash)
      .where(sql`${t.payloadHash} is not null`),
    check(
      "messages_selected_skills_array_check",
      sql`jsonb_typeof(${t.selectedSkills}) = 'array'`
    ),
    check(
      "messages_payload_hash_check",
      sql`${t.payloadHash} is null or ${t.payloadHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "messages_failure_check",
      sql`${t.failure} IS NULL OR ${t.failure} IN ('ambiguous', 'not_admitted', 'not_sent', 'rejected', 'session_gone', 'unconfirmed')`
    ),
    index("messages_unresolved_idx")
      .on(t.checkAfter)
      .where(
        sql`${t.status} <> 'accepted' and ${t.sessionId} is not null and ${t.checkAfter} is not null`
      ),
  ]
);

// One opening of a bot's main session at a time, committed before eve is called (0026).
export const botSessionOpenings = pgTable("bot_session_openings", {
  botId: uuid("bot_id")
    .primaryKey()
    .references(() => bots.id, { onDelete: "cascade" }),
  createdAt: created(),
  generation: integer("generation").notNull(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
  operationId: text("operation_id").notNull(),
  token: uuid("token").notNull(),
});

// Sessions the hub opened for a bot: installed ones carry their generation, losers wait to be ended.
export const botSessions = pgTable(
  "bot_sessions",
  {
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    createdAt: created(),
    endAttempts: integer("end_attempts").notNull().default(0),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    generation: integer("generation"),
    operationId: text("operation_id").notNull(),
    sessionId: text("session_id").primaryKey(),
  },
  (t) => [
    uniqueIndex("bot_sessions_generation_idx")
      .on(t.botId, t.generation)
      .where(sql`${t.generation} is not null`),
    index("bot_sessions_orphan_idx")
      .on(t.createdAt)
      .where(sql`${t.generation} is null and ${t.endedAt} is null`),
  ]
);

/**
 * The hub-side receipt for one message POST.  Eve's idempotency key makes a
 * retry on this exact session safe, but the hub still needs to remember which
 * session it used when the HTTP acknowledgement was lost.  Keep this beside
 * (rather than in) `messages`: Live wake requests also need transport identity
 * before a user message row exists.
 */
export const messageDeliveryAttempts = pgTable(
  "message_delivery_attempts",
  {
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    createdAt: created(),
    deliveryId: text("delivery_id"),
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id").notNull(),
    operationId: text("operation_id").notNull(),
    postingToken: text("posting_token"),
    postingUntil: timestamp("posting_until", { withTimezone: true }),
    seededClientContext: jsonb("seeded_client_context").$type<
      Record<string, unknown>
    >(),
    seededText: text("seeded_text"),
    sessionId: text("session_id"),
    state: text("state")
      .$type<"reserved" | "sending" | "accepted" | "failed" | "unknown">()
      .notNull()
      .default("reserved"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("message_delivery_attempts_message_id_key").on(t.messageId),
    unique("message_delivery_attempts_operation_id_key").on(t.operationId),
    index("message_delivery_attempt_bot_idx").on(t.botId, t.updatedAt),
    check(
      "message_delivery_attempts_state_check",
      oneOf(t.state, ["reserved", "sending", "accepted", "failed", "unknown"])
    ),
  ]
);
export type MessageDeliveryAttemptRow =
  typeof messageDeliveryAttempts.$inferSelect;

/**
 * A bounded, hub-owned recovery packet is durable before a replacement Eve
 * session is made current.  The partial unique index is the database CAS for
 * concurrent replacement attempts; completed packets remain for audit and
 * retry correlation but do not block a later generation.
 */
export const sessionRecoveries = pgTable(
  "session_recoveries",
  {
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    createdAt: created(),
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id").notNull(),
    operationId: text("operation_id").notNull(),
    packet: jsonb("packet").notNull(),
    planSnapshot: jsonb("plan_snapshot").$type<Record<
      string,
      unknown
    > | null>(),
    reservedSessionId: text("reserved_session_id"),
    sourceSessionId: text("source_session_id"),
    state: text("state")
      .$type<"prepared" | "creating" | "active" | "completed" | "failed">()
      .notNull()
      .default("prepared"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("session_recoveries_operation_id_key").on(t.operationId),
    check(
      "session_recoveries_state_check",
      oneOf(t.state, ["prepared", "creating", "active", "completed", "failed"])
    ),
    uniqueIndex("session_recovery_active_bot_idx")
      .on(t.botId)
      .where(sql`${t.state} in ('prepared', 'creating', 'active')`),
    index("session_recovery_bot_created_idx").on(t.botId, t.createdAt),
  ]
);
export type SessionRecoveryRow = typeof sessionRecoveries.$inferSelect;

export const historyEmbeddings = pgTable(
  "history_embeddings",
  {
    attempts: integer("attempts").notNull().default(0),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    createdAt: created(),
    embedding: jsonb("embedding").$type<number[]>(),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    model: text("model").notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sessionId: text("session_id"),
    source: text("source").$type<"message" | "event" | "memory">().notNull(),
    sourceId: text("source_id").notNull(),
    text: text("text").notNull(),
    turnId: text("turn_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.botId, t.source, t.sourceId, t.model] }),
    index("history_embeddings_pending_idx")
      .on(t.nextAttemptAt, t.updatedAt)
      .where(sql`${t.embedding} IS NULL`),
    index("history_embeddings_bot_model_idx")
      .on(t.botId, t.model, t.updatedAt)
      .where(sql`${t.embedding} IS NOT NULL`),
    check(
      "history_embeddings_source_check",
      oneOf(t.source, ["message", "event", "memory"])
    ),
  ]
);

export const consultations = pgTable(
  "consultations",
  {
    callId: text("call_id").notNull().unique(),
    childSessionId: text("child_session_id"),
    createdAt: created(),
    fromBotId: uuid("from_bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    id: uuid("id").primaryKey().defaultRandom(),
    parentSessionId: text("parent_session_id").notNull(),
    status: text("status")
      .$type<ConsultationStatus>()
      .notNull()
      .default("open"),
    // Another bot's consultation outlives the receiver: deleting it only clears this (H-10).
    toBotId: uuid("to_bot_id").references(() => bots.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    check("consultations_status_check", oneOf(t.status, CONSULTATION_STATUSES)),
  ]
);

export const fileSource = pgEnum("file_source", ["user", "bot"]);

// Repository metadata is app-owned configuration. OAuth grants remain in
// mcp_connections; this table only freezes the repository identity and branch
// policy that a coding task is allowed to use.
export const codeRepositories = pgTable(
  "code_repositories",
  {
    connectionId: uuid("connection_id").references(() => mcpConnections.id, {
      onDelete: "set null",
    }),
    createdAt: created(),
    defaultBranch: text("default_branch").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    fullName: text("full_name").notNull(),
    githubId: text("github_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("code_repositories_github_id_idx").on(t.githubId),
    uniqueIndex("code_repositories_full_name_idx").on(
      sql`lower(${t.fullName})`
    ),
    index("code_repositories_enabled_idx").on(t.enabled),
    check(
      "code_repositories_full_name_check",
      sql`${t.fullName} ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9._-]+$'`
    ),
    check(
      "code_repositories_default_branch_check",
      sql`length(btrim(${t.defaultBranch})) between 1 and 255`
    ),
  ]
);
export type CodeRepositoryRow = typeof codeRepositories.$inferSelect;

// Repository context/provenance is separate from bot deployment data. Repository
// authorization is app-wide; this row records the bot's selected context.
export const codeRepositoryAccess = pgTable(
  "code_repository_access",
  {
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    createdAt: created(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => codeRepositories.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.botId, t.repositoryId] }),
    index("code_repository_access_repository_idx").on(t.repositoryId),
  ]
);
export type CodeRepositoryAccessRow = typeof codeRepositoryAccess.$inferSelect;

export const codeBotContexts = pgTable("code_bot_contexts", {
  botId: uuid("bot_id")
    .primaryKey()
    .references(() => bots.id, { onDelete: "cascade" }),
  repositoryId: uuid("repository_id")
    .notNull()
    .references(() => codeRepositories.id, { onDelete: "cascade" }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export type CodeBotContextRow = typeof codeBotContexts.$inferSelect;

export const codeTasks = pgTable(
  "code_tasks",
  {
    agentName: text("agent_name"),
    appliedInstructionVersion: integer("applied_instruction_version")
      .notNull()
      .default(0),
    baseBranch: text("base_branch").notNull(),
    billing: text("billing").$type<Billing>().notNull(),
    botId: uuid("bot_id").references(() => bots.id, { onDelete: "set null" }),
    branch: text("branch"),
    commitSha: text("commit_sha"),
    createdAt: created(),
    durableSessionId: text("durable_session_id"),
    error: text("error"),
    execution: jsonb("execution")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    fast: boolean("fast").notNull().default(false),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    goal: text("goal").notNull(),
    id: uuid("id").primaryKey(),
    instructionVersion: integer("instruction_version").notNull().default(1),
    lastStreamCursor: integer("last_stream_cursor").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    model: text("model").notNull(),
    phase: text("phase").$type<import("../code-tasks/types").CodeTaskPhase>(),
    pullRequestUrl: text("pull_request_url"),
    repositoryFullName: text("repository_full_name").notNull(),
    repositoryId: uuid("repository_id").references(() => codeRepositories.id, {
      onDelete: "set null",
    }),
    repositorySnapshotId: text("repository_snapshot_id").notNull(),
    revision: integer("revision").notNull().default(1),
    sourceCallId: text("source_call_id").notNull(),
    sourceMessageId: text("source_message_id"),
    sourceSessionId: text("source_session_id").notNull(),
    status: text("status")
      .$type<import("../code-tasks/types").CodeTaskStatus>()
      .notNull()
      .default("queued"),
    summary: text("summary"),
    title: text("title").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    version: integer("version").notNull().default(0),
  },
  (t) => [
    unique("code_tasks_origin_unique").on(
      t.botId,
      t.sourceSessionId,
      t.sourceCallId
    ),
    uniqueIndex("code_tasks_branch_active_idx")
      .on(t.repositoryFullName, t.branch)
      .where(
        sql`${t.status} in ('queued', 'running', 'waiting_for_input', 'cancel_requested')`
      ),
    index("code_tasks_bot_created_idx").on(t.botId, t.createdAt),
    index("code_tasks_status_idx").on(t.status, t.updatedAt),
    check(
      "code_tasks_title_check",
      sql`length(btrim(${t.title})) between 1 and 200`
    ),
    check(
      "code_tasks_goal_check",
      sql`length(btrim(${t.goal})) between 1 and 20000`
    ),
    check("code_tasks_billing_check", oneOf(t.billing, BILLINGS)),
    check("code_tasks_status_check", oneOf(t.status, CODE_TASK_STATUSES)),
    check(
      "code_tasks_phase_check",
      sql`${t.phase} is null or ${oneOf(t.phase, [
        "preparing",
        "inspecting",
        "editing",
        "checking",
        "publishing",
        "waiting",
        "recovering",
      ])}`
    ),
    check("code_tasks_revision_check", sql`${t.revision} > 0`),
    check(
      "code_tasks_instruction_version_check",
      sql`${t.instructionVersion} >= 1`
    ),
    check(
      "code_tasks_applied_instruction_version_check",
      sql`${t.appliedInstructionVersion} >= 0`
    ),
    check("code_tasks_version_check", sql`${t.version} >= 0`),
    // 0027: terminal status <=> finished_at (N-03).
    check(
      "code_tasks_finished_at_check",
      sql`(${t.status} in ('ready', 'failed', 'needs_attention', 'cancelled')) = (${t.finishedAt} is not null)`
    ),
  ]
);
export type CodeTaskRow = typeof codeTasks.$inferSelect;

/** 0027: a bot whose deletion started admits no new code work (H-25). */
export const codeTaskBotShutdowns = pgTable("code_task_bot_shutdowns", {
  botId: uuid("bot_id")
    .primaryKey()
    .references(() => bots.id, { onDelete: "cascade" }),
  requestedAt: timestamp("requested_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const codeTaskCommands = pgTable(
  "code_task_commands",
  {
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    createdAt: created(),
    error: text("error"),
    expectedVersion: integer("expected_version").notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    id: uuid("id").primaryKey().defaultRandom(),
    instructionVersion: integer("instruction_version").notNull(),
    kind: text("kind")
      .$type<import("../code-tasks/types").CodeTaskCommandKind>()
      .notNull(),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    messageId: text("message_id").notNull(),
    revision: integer("revision").notNull(),
    status: text("status")
      .$type<import("../code-tasks/types").CodeTaskCommandStatus>()
      .notNull()
      .default("queued"),
    taskId: uuid("task_id")
      .notNull()
      .references(() => codeTasks.id, { onDelete: "cascade" }),
    text: text("text"),
  },
  (t) => [
    unique("code_task_commands_message_unique").on(t.taskId, t.messageId),
    index("code_task_commands_claim_idx").on(
      t.status,
      t.leaseUntil,
      t.createdAt
    ),
    index("code_task_commands_task_idx").on(t.taskId, t.createdAt),
    check(
      "code_task_commands_kind_check",
      oneOf(t.kind, CODE_TASK_COMMAND_KINDS)
    ),
    check("code_task_commands_revision_check", sql`${t.revision} > 0`),
    check(
      "code_task_commands_instruction_version_check",
      sql`${t.instructionVersion} >= 0`
    ),
    check(
      "code_task_commands_expected_version_check",
      sql`${t.expectedVersion} >= 0`
    ),
    check(
      "code_task_commands_status_check",
      oneOf(t.status, CODE_TASK_COMMAND_STATUSES)
    ),
    check("code_task_commands_attempts_check", sql`${t.attempts} >= 0`),
  ]
);
export type CodeTaskCommandRow = typeof codeTaskCommands.$inferSelect;

export const codeTaskEvents = pgTable(
  "code_task_events",
  {
    createdAt: created(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    revision: integer("revision").notNull(),
    seq: integer("seq").notNull(),
    sourceKey: text("source_key").notNull(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => codeTasks.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.seq] }),
    unique("code_task_events_source_unique").on(t.taskId, t.sourceKey),
    index("code_task_events_task_idx").on(t.taskId, t.createdAt),
    check("code_task_events_seq_check", sql`${t.seq} > 0`),
    check("code_task_events_revision_check", sql`${t.revision} > 0`),
  ]
);
export type CodeTaskEventRow = typeof codeTaskEvents.$inferSelect;

// Physical content is shared; each file row remains a separately authorized reference.
export const libraryObjects = pgTable(
  "library_objects",
  {
    contentType: text("content_type").notNull(),
    createdAt: created(),
    id: uuid("id").primaryKey().defaultRandom(),
    pathname: text("pathname").notNull().unique(),
    sha256: text("sha256").notNull().unique(),
    size: integer("size").notNull(),
    status: text("status")
      .$type<"pending" | "ready">()
      .notNull()
      .default("pending"),
  },
  (t) => [
    index("library_objects_status_idx").on(t.status, t.createdAt),
    check("library_objects_sha256_check", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("library_objects_size_check", sql`${t.size} >= 0`),
    check(
      "library_objects_status_check",
      oneOf(t.status, ["pending", "ready"])
    ),
  ]
);

export const files = pgTable(
  "files",
  {
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    contentType: text("content_type").notNull(),
    createdAt: created(),
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id"),
    name: text("name").notNull(),
    objectId: uuid("object_id").references(() => libraryObjects.id, {
      onDelete: "restrict",
    }),
    pathname: text("pathname").notNull(),
    // A pending reservation can complete only before this (signed PUT TTL plus grace); afterwards the
    // library verification cron removes the row and its Blob (lib/files.ts expirePendingFiles).
    pendingUntil: timestamp("pending_until", { withTimezone: true }),
    sessionId: text("session_id"),
    size: integer("size").notNull(),
    source: fileSource("source").notNull(),
    // A promoted upload can still have a live signed URL. Keep its old path
    // until that URL expires; the library verification cron clears it later.
    stalePathname: text("stale_pathname"),
    staleUntil: timestamp("stale_until", { withTimezone: true }),
    status: text("status").$type<FileStatus>().notNull().default("pending"),
    turnId: text("turn_id"),
    version: integer("version").notNull(),
  },
  (t) => [
    unique().on(t.botId, t.name, t.version),
    index("files_object_id_idx").on(t.objectId),
    index("files_pending_until_idx")
      .on(t.pendingUntil)
      .where(sql`${t.status} = 'pending'`),
    index("files_provenance_idx").on(
      t.botId,
      t.sessionId,
      t.turnId,
      t.messageId
    ),
    check("files_status_check", oneOf(t.status, FILE_STATUSES)),
  ]
);

// Failed password logins, shared by every instance for the rate limit; rows older than the window are pruned.
export const loginFailures = pgTable(
  "login_failures",
  {
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    ip: text("ip").notNull(),
  },
  (t) => [index("login_failures_at_idx").on(t.at)]
);

// Busy is currently a single-account hub, so the selected model access is one
// shared preference. Provider credentials live in separate encrypted records.
export const appAiSettings = pgTable(
  "app_ai_settings",
  {
    id: text("id").primaryKey(),
    model: text("model"),
    onboardingCompletedAt: timestamp("onboarding_completed_at", {
      withTimezone: true,
    }),
    provider: text("provider").$type<Billing | null>(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("app_ai_settings_id_check", sql`${t.id} = 'default'`),
    check(
      "app_ai_settings_provider_check",
      sql`${t.provider} is null or ${t.provider} in ('token-pass', 'gateway', 'chatgpt', 'grok')`
    ),
  ]
);
export type AppAiSettingsRow = typeof appAiSettings.$inferSelect;

export const aiSubscriptionHosts = pgTable(
  "ai_subscription_hosts",
  {
    createdAt: created(),
    hostId: text("host_id").notNull().unique(),
    id: text("id").primaryKey(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [check("ai_subscription_hosts_id_check", sql`${t.id} = 'default'`)]
);
export type AiSubscriptionHostRow = typeof aiSubscriptionHosts.$inferSelect;

export const aiSubscriptionConnections = pgTable(
  "ai_subscription_connections",
  {
    accountId: text("account_id"),
    connectedAt: timestamp("connected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    models: jsonb("models").$type<SubscriptionModel[]>().notNull().default([]),
    provider: text("provider").$type<SubscriptionProvider>().primaryKey(),
    sealedCredentials: text("sealed_credentials").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "ai_subscription_connections_provider_check",
      sql`${t.provider} in ('chatgpt', 'grok')`
    ),
  ]
);
export type AiSubscriptionConnectionRow =
  typeof aiSubscriptionConnections.$inferSelect;

export const aiSubscriptionAttempts = pgTable(
  "ai_subscription_attempts",
  {
    createdAt: created(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }).notNull(),
    provider: text("provider").$type<SubscriptionProvider>().notNull(),
    sealedAttempt: text("sealed_attempt").notNull(),
    user: text("user").notNull(),
  },
  (t) => [
    check(
      "ai_subscription_attempts_provider_check",
      sql`${t.provider} in ('chatgpt', 'grok')`
    ),
    index("ai_subscription_attempts_user_provider_idx").on(t.user, t.provider),
  ]
);
export type AiSubscriptionAttemptRow =
  typeof aiSubscriptionAttempts.$inferSelect;
