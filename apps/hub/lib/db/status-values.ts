// Values that a named CHECK constraint in apps/hub/drizzle/*.sql enforces. The
// schema builds its check() from these lists and the runtime types derive from
// them, so a new state cannot ship without a migration: change the list, write
// a migration that drops and re-adds the constraint under the same name (NOT
// VALID, then VALIDATE), and the schema parity test checks that both agree.
// Keep this module free of imports: client components reach it through
// lib/bots/models.ts.

/** How a bot pays for its model (`bots_billing_check`, `code_tasks_billing_check`). */
export const BILLINGS = ["token-pass", "gateway", "chatgpt", "grok"] as const;
export type Billing = (typeof BILLINGS)[number];

/**
 * `files_status_check`. `blocked` is the tombstone of a bot file that failed
 * the safety scan (lib/files.ts).
 */
export const FILE_STATUSES = ["pending", "ready", "blocked"] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/** `consultations_status_check`: opened, finished by the parent stream, then synced. */
export const CONSULTATION_STATUSES = ["open", "done", "synced"] as const;
export type ConsultationStatus = (typeof CONSULTATION_STATUSES)[number];

/** `mcp_connections_status_check`, created inline by 0008_mcp_marketplace.sql. */
export const MCP_CONNECTION_STATUSES = [
  "pending",
  "connected",
  "error",
] as const;
export type McpConnectionStatus = (typeof MCP_CONNECTION_STATUSES)[number];
