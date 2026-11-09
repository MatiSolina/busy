import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  bots,
  codeRepositories,
  codeTaskCommands,
  codeTaskEvents,
  codeTasks,
} from "@/lib/db/schema";
import { deployMigration } from "../bots/test-helpers";

const mock = vi.hoisted(() => ({
  deleteSandbox: vi.fn(),
  getWorld: vi.fn(),
}));
vi.mock("durable-harness", () => ({ getWorld: mock.getWorld }));
vi.mock("durable-harness/sandbox", () => ({
  deleteSessionSandbox: mock.deleteSandbox,
}));

const taskId = "44444444-4444-4444-8444-444444444444";
const runningId = "55555555-5555-4555-8555-555555555555";
const pendingId = "66666666-6666-4666-8666-666666666666";
const repositoryId = "33333333-3333-4333-8333-333333333333";
const botId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-11-10T00:00:00.000Z");
const old = new Date("2026-11-01T00:00:00.000Z");
const world = {
  events: { create: vi.fn() },
  runs: { get: vi.fn() },
  specVersion: 2,
};

let client: PGlite;
let database: ReturnType<typeof drizzle>;
let cleanup: typeof import("./cleanup");

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE TABLE bots (
      id uuid PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      name text NOT NULL DEFAULT 'Bot',
      avatar text,
      description text NOT NULL DEFAULT '',
      instructions text NOT NULL DEFAULT '',
      model text NOT NULL DEFAULT 'model/example',
      billing text NOT NULL DEFAULT 'gateway',
      fast boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'ready',
      deployment_id text,
      url text,
      session_id text,
      live_until timestamptz,
      history_pending boolean NOT NULL DEFAULT false,
      deletion_state text, deletion_token uuid, deletion_requested_at timestamptz,
      deletion_attempts integer NOT NULL DEFAULT 0, deletion_next_attempt_at timestamptz,
      deletion_last_error text, deletion_project_id text,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE mcp_connections (
      id uuid PRIMARY KEY,
      bot_id uuid,
      catalog_id text NOT NULL,
      status text NOT NULL DEFAULT 'connected',
      error text,
      oauth_data text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  // Bots columns added by later SQL migrations (bots predates drizzle/).
  await client.exec(deployMigration());
  await client.exec(
    readFileSync(
      fileURLToPath(
        new URL("../../drizzle/0021_code_tasks.sql", import.meta.url)
      ),
      "utf8"
    )
  );
  const schema = {
    bots,
    codeRepositories,
    codeTaskCommands,
    codeTaskEvents,
    codeTasks,
  };
  database = drizzle(client, { schema });
  vi.doMock("@/lib/db", () => ({
    bots,
    codeRepositories,
    codeTaskCommands,
    codeTaskEvents,
    codeTasks,
    db: () => database,
  }));
  vi.resetModules();
  cleanup = await import("./cleanup");
});

beforeEach(async () => {
  await client.exec(
    "DELETE FROM code_task_events; DELETE FROM code_task_commands; DELETE FROM code_tasks; DELETE FROM code_repositories; DELETE FROM bots;"
  );
  await database.insert(bots).values({
    description: "",
    id: botId,
    name: "Cleanup",
    slug: "cleanup",
  });
  await database.insert(codeRepositories).values({
    defaultBranch: "main",
    fullName: "acme/cleanup",
    githubId: "9001",
    id: repositoryId,
  });
  mock.deleteSandbox.mockReset();
  mock.deleteSandbox.mockResolvedValue({
    drive: "deleted",
    name: "sandbox",
    sandbox: "deleted",
  });
  world.events.create.mockReset();
  world.runs.get.mockReset();
  world.runs.get.mockResolvedValue({ status: "completed" });
  mock.getWorld.mockResolvedValue(world);
});

afterAll(async () => {
  await client.close();
});

function oldTask(id: string, status: "ready" | "running") {
  return database.insert(codeTasks).values({
    baseBranch: "main",
    billing: "gateway",
    botId,
    branch: `codex/busy-${id}`,
    createdAt: old,
    durableSessionId: `session-${id}`,
    execution: { checks: [] },
    finishedAt: status === "ready" ? old : null,
    goal: "Clean up",
    id,
    model: "openai/gpt-6.1-terra",
    phase: null,
    repositoryFullName: "acme/cleanup",
    repositoryId,
    repositorySnapshotId: repositoryId,
    sourceCallId: `call-${id}`,
    sourceSessionId: `source-${id}`,
    status,
    title: "Cleanup",
    updatedAt: old,
  });
}

describe("code task workspace cleanup", () => {
  it("deletes only old terminal workspaces and never forces an open session", async () => {
    await oldTask(taskId, "ready");
    await oldTask(runningId, "running");
    await oldTask(pendingId, "ready");
    await database.insert(codeTaskCommands).values({
      expectedVersion: 0,
      instructionVersion: 1,
      kind: "steer",
      messageId: "pending",
      revision: 1,
      status: "queued",
      taskId: pendingId,
    });

    const result = await cleanup.cleanupCodeTaskWorkspaces({ now });

    expect(result.deleted.map((item) => item.id)).toEqual([taskId]);
    expect(result.kept).toBe(1);
    expect(result.examined).toBe(2);
    expect(mock.deleteSandbox).toHaveBeenCalledWith(
      `session-${taskId}`,
      expect.objectContaining({ force: false, world })
    );
    const deleted = await database
      .select()
      .from(codeTasks)
      .where(eq(codeTasks.id, taskId));
    expect(deleted.find((task) => task.id === taskId)?.execution).toMatchObject(
      {
        workspaceDeletedAt: now.toISOString(),
      }
    );
  });

  it("releases its lease when durable-harness keeps a live session", async () => {
    await oldTask(taskId, "ready");
    world.runs.get.mockResolvedValue({ status: "running" });
    mock.deleteSandbox.mockRejectedValueOnce(
      new Error("session is still open")
    );

    const result = await cleanup.cleanupCodeTaskWorkspaces({ now });

    expect(result.deleted).toHaveLength(0);
    expect(result.failed[0]?.error).toBe(
      "The task workspace could not be cleaned up."
    );
    expect(world.events.create).toHaveBeenCalledWith(
      `session-${taskId}`,
      expect.objectContaining({
        eventData: { cancelReason: "code-task workspace retention" },
        eventType: "run_cancelled",
        specVersion: 2,
      })
    );
    const [task] = await database
      .select()
      .from(codeTasks)
      .where(eq(codeTasks.id, taskId));
    expect(task?.leaseToken).toBeNull();
  });

  it("reconciles an orphan accepted command once instead of blocking cleanup forever (N-03)", async () => {
    await oldTask(taskId, "ready");
    await database.insert(codeTaskCommands).values({
      expectedVersion: 0,
      instructionVersion: 1,
      kind: "steer",
      messageId: "orphan",
      revision: 1,
      status: "accepted",
      taskId,
    });

    const first = await cleanup.cleanupCodeTaskWorkspaces({ now });
    const second = await cleanup.cleanupCodeTaskWorkspaces({ now });

    expect(first.deleted.map((item) => item.id)).toEqual([taskId]);
    expect(second.examined).toBe(0);
    const [command] = await database
      .select()
      .from(codeTaskCommands)
      .where(eq(codeTaskCommands.taskId, taskId));
    expect(command).toMatchObject({ leaseToken: null, status: "settled" });
    expect(command?.finishedAt).not.toBeNull();
    const events = await database
      .select()
      .from(codeTaskEvents)
      .where(eq(codeTaskEvents.taskId, taskId));
    expect(events.map((event) => event.type)).toEqual(["command.reconciled"]);
  });

  it("keeps a real pending (queued) command blocking cleanup", async () => {
    await oldTask(taskId, "ready");
    await database.insert(codeTaskCommands).values({
      expectedVersion: 0,
      instructionVersion: 2,
      kind: "steer",
      messageId: "pending-real",
      revision: 1,
      status: "queued",
      taskId,
    });
    const result = await cleanup.cleanupCodeTaskWorkspaces({ now });
    expect(result.deleted).toHaveLength(0);
    expect(result.kept).toBe(1);
  });

  it("still cleans a terminal workspace after its bot was deleted (H-25)", async () => {
    await oldTask(taskId, "ready");
    await client.exec(`DELETE FROM bots WHERE id = '${botId}';`);
    const result = await cleanup.cleanupCodeTaskWorkspaces({ now });
    expect(result.deleted.map((item) => item.id)).toEqual([taskId]);
    const [task] = await database
      .select()
      .from(codeTasks)
      .where(eq(codeTasks.id, taskId));
    expect(task).toMatchObject({ botId: null, status: "ready" });
  });
});
