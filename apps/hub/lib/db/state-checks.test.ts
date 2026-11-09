// Applies the real SQL migrations and checks every state column: each value the
// runtime writes is accepted and anything else fails on the named constraint.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it as test } from "vitest";
import { createMigratedDatabase } from "@/scripts/migration-database";
import {
  CODE_TASK_COMMAND_KINDS,
  CODE_TASK_COMMAND_STATUSES,
  CODE_TASK_STATUSES,
  type CodeTaskPhase,
} from "../code-tasks/types";
import type { FiresideStatus } from "../firesides/types";
import type { RoutineRunStatus } from "../routines/types";
import {
  BILLINGS,
  CONSULTATION_STATUSES,
  FILE_STATUSES,
  MCP_CONNECTION_STATUSES,
} from "./status-values";

// Lists of union types, checked for completeness at compile time.
type Complete<Union, List extends readonly unknown[]> = [
  Exclude<Union, List[number]>,
] extends [never]
  ? List
  : never;
const complete =
  <Union>() =>
  <const List extends readonly Union[]>(list: Complete<Union, List>) =>
    list;

const ROUTINE_RUN_STATUSES = complete<RoutineRunStatus>()([
  "pending",
  "dispatched",
  "succeeded",
  "failed",
  "cancelled",
]);
const FIRESIDE_STATUSES = complete<FiresideStatus>()([
  "running",
  "waiting",
  "paused",
  "closing",
  "closed",
  "failed",
]);
const CODE_TASK_PHASES = complete<CodeTaskPhase>()([
  null,
  "preparing",
  "inspecting",
  "editing",
  "checking",
  "publishing",
  "waiting",
  "recovering",
]);

const BOT = "11111111-1111-4111-8111-111111111111";
const ROUTINE = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";
const COMMAND = "55555555-5555-4555-8555-555555555555";
const FIRESIDE = "66666666-6666-4666-8666-666666666666";
const MESSAGE = "77777777-7777-4777-8777-777777777777";
const FILE = "88888888-8888-4888-8888-888888888888";
const OBJECT = "99999999-9999-4999-8999-999999999999";
const CONSULTATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONNECTION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let client: PGlite;

beforeAll(async () => {
  client = await createMigratedDatabase();
  await client.exec(`
    INSERT INTO bots (id, slug, name, description) VALUES ('${BOT}', 'bot', 'Bot', '');
    INSERT INTO routines (id, bot_id, name, prompt, time, time_zone, days_of_week)
      VALUES ('${ROUTINE}', '${BOT}', 'Daily', 'Report', '09:00', 'UTC', '[1]');
    INSERT INTO routine_runs (id, routine_id, bot_id, scheduled_for, prompt, status)
      VALUES ('${RUN}', '${ROUTINE}', '${BOT}', now(), 'Report', 'succeeded');
    INSERT INTO code_tasks (id, bot_id, source_session_id, source_call_id, title, goal,
        repository_snapshot_id, repository_full_name, base_branch, billing, model)
      VALUES ('${TASK}', '${BOT}', 'session', 'call', 'Fix', 'Fix it', 'snap', 'acme/app',
        'main', 'gateway', 'model');
    INSERT INTO code_task_commands (id, task_id, kind, revision, instruction_version,
        expected_version, message_id)
      VALUES ('${COMMAND}', '${TASK}', 'start', 1, 1, 0, 'message');
    INSERT INTO firesides (id, bot_id, origin_id, status, state)
      VALUES ('${FIRESIDE}', '${BOT}', gen_random_uuid(), 'closed', '{}');
    INSERT INTO messages (id, bot_id, text) VALUES ('${MESSAGE}', '${BOT}', 'hi');
    INSERT INTO library_objects (id, sha256, pathname, content_type, size)
      VALUES ('${OBJECT}', repeat('a', 64), 'library/a', 'text/plain', 1);
    INSERT INTO files (id, bot_id, name, pathname, content_type, size, source, version)
      VALUES ('${FILE}', '${BOT}', 'a.txt', 'files/a.txt', 'text/plain', 1, 'user', 1);
    INSERT INTO consultations (id, call_id, from_bot_id, parent_session_id)
      VALUES ('${CONSULTATION}', 'call', '${BOT}', 'session');
    INSERT INTO mcp_connections (id, catalog_id) VALUES ('${CONNECTION}', 'github');
  `);
}, 60_000);

afterAll(async () => {
  await client.close();
});

interface Case {
  /** Columns another CHECK ties to this one, set along with it. */
  also?: string;
  column: string;
  constraint: string;
  id: string;
  invalid: unknown[];
  table: string;
  valid: readonly unknown[];
}

const cases: Case[] = [
  {
    column: "status",
    constraint: "routine_runs_status_check",
    id: RUN,
    invalid: ["bogus", "running", "Pending"],
    table: "routine_runs",
    valid: ROUTINE_RUN_STATUSES,
  },
  {
    column: "status",
    constraint: "library_objects_status_check",
    id: OBJECT,
    invalid: ["bogus", "blocked"],
    table: "library_objects",
    valid: ["pending", "ready"],
  },
  {
    // code_tasks_finished_at_check (0027): terminal <=> finished_at.
    also: "finished_at = CASE WHEN $1 IN ('ready', 'failed', 'needs_attention', 'cancelled') THEN now() END",
    column: "status",
    constraint: "code_tasks_status_check",
    id: TASK,
    invalid: ["bogus", "succeeded"],
    table: "code_tasks",
    valid: CODE_TASK_STATUSES,
  },
  {
    column: "phase",
    constraint: "code_tasks_phase_check",
    id: TASK,
    invalid: ["bogus", ""],
    table: "code_tasks",
    valid: CODE_TASK_PHASES,
  },
  {
    column: "billing",
    constraint: "code_tasks_billing_check",
    id: TASK,
    invalid: ["bogus", "openai"],
    table: "code_tasks",
    valid: BILLINGS,
  },
  {
    column: "kind",
    constraint: "code_task_commands_kind_check",
    id: COMMAND,
    invalid: ["bogus"],
    table: "code_task_commands",
    valid: CODE_TASK_COMMAND_KINDS,
  },
  {
    column: "status",
    constraint: "code_task_commands_status_check",
    id: COMMAND,
    invalid: ["bogus"],
    table: "code_task_commands",
    valid: CODE_TASK_COMMAND_STATUSES,
  },
  {
    column: "status",
    constraint: "firesides_status_check",
    id: FIRESIDE,
    invalid: ["bogus", "open"],
    table: "firesides",
    valid: FIRESIDE_STATUSES,
  },
  {
    column: "billing",
    constraint: "bots_billing_check",
    id: BOT,
    invalid: ["bogus", "Gateway"],
    table: "bots",
    valid: BILLINGS,
  },
  {
    column: "status",
    constraint: "files_status_check",
    id: FILE,
    invalid: ["bogus", "expired"],
    table: "files",
    valid: FILE_STATUSES,
  },
  {
    column: "status",
    constraint: "consultations_status_check",
    id: CONSULTATION,
    invalid: ["bogus", "closed"],
    table: "consultations",
    valid: CONSULTATION_STATUSES,
  },
  {
    column: "status",
    constraint: "mcp_connections_status_check",
    id: CONNECTION,
    invalid: ["bogus"],
    table: "mcp_connections",
    valid: MCP_CONNECTION_STATUSES,
  },
  {
    column: "selected_skills",
    constraint: "messages_selected_skills_array_check",
    id: MESSAGE,
    invalid: [{ skillName: "x" }, 1, true],
    table: "messages",
    valid: [[], [{ capabilityId: "c", skillName: "s" }]],
  },
  {
    column: "payload_hash",
    constraint: "messages_payload_hash_check",
    id: MESSAGE,
    invalid: ["XYZ", "A".repeat(64), "a".repeat(63)],
    table: "messages",
    valid: [null, "0123456789abcdef".repeat(4)],
  },
];

const update = ({ also, column, id, table }: Case, value: unknown) =>
  client.query(
    `UPDATE ${table} SET ${column} = $1${also ? `, ${also}` : ""} WHERE id = $2`,
    [
      value !== null && typeof value === "object"
        ? JSON.stringify(value)
        : value,
      id,
    ]
  );

describe.each(
  cases.map((entry) => [`${entry.table}.${entry.column}`, entry] as const)
)("%s", (_name, entry) => {
  const { constraint, invalid, valid } = entry;
  test.each(valid.map((value) => [value]))("accepts %j", async (value) => {
    const result = await update(entry, value);
    expect(result.affectedRows).toBe(1);
  });

  test.each(invalid.map((value) => [value]))(
    `rejects %j with ${constraint}`,
    async (value) => {
      await expect(update(entry, value)).rejects.toMatchObject({
        code: "23514",
        constraint,
      });
    }
  );
});
