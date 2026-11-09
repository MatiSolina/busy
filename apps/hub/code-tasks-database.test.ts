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
import { fxMessageId } from "./lib/code-tasks/message-id";
import {
  bots,
  codeBotContexts,
  codeRepositories,
  codeRepositoryAccess,
  codeTaskBotShutdowns,
  codeTaskCommands,
  codeTaskEvents,
  codeTasks,
} from "./lib/db/schema";

const alphaId = "11111111-1111-4111-8111-111111111111";
const betaId = "22222222-2222-4222-8222-222222222222";
const repoId = "33333333-3333-4333-8333-333333333333";
const taskId = "44444444-4444-4444-8444-444444444444";
const secondRepoId = "88888888-8888-4888-8888-888888888888";
const thirdRepoId = "99999999-9999-4999-8999-999999999999";
const secondTaskId = "55555555-5555-4555-8555-555555555555";
const thirdTaskId = "66666666-6666-4666-8666-666666666666";
const fourthTaskId = "77777777-7777-4777-8777-777777777777";

let client: PGlite;
const schema = {
  bots,
  codeBotContexts,
  codeRepositories,
  codeRepositoryAccess,
  codeTaskBotShutdowns,
  codeTaskCommands,
  codeTaskEvents,
  codeTasks,
};
let database: ReturnType<typeof drizzle<typeof schema>>;
let store: typeof import("./lib/code-tasks/store");
const LEGACY_FX_MESSAGE_ID_PATTERN = /^legacy-[a-f0-9]{48}$/u;

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
  await client.exec(
    readFileSync(
      fileURLToPath(new URL("./drizzle/0021_code_tasks.sql", import.meta.url)),
      "utf8"
    )
  );
  await client.exec(
    readFileSync(
      fileURLToPath(
        new URL("./drizzle/0027_code_task_state.sql", import.meta.url)
      ),
      "utf8"
    )
  );
  database = drizzle(client, { schema });
  vi.doMock("@/lib/db", () => ({
    bots,
    codeBotContexts,
    codeRepositories,
    codeRepositoryAccess,
    codeTaskBotShutdowns,
    codeTaskCommands,
    codeTaskEvents,
    codeTasks,
    db: () => database,
  }));
  vi.resetModules();
  store = await import("./lib/code-tasks/store");
});

beforeEach(async () => {
  await client.exec(
    "DELETE FROM code_task_bot_shutdowns; DELETE FROM code_task_events; DELETE FROM code_task_commands; DELETE FROM code_tasks; DELETE FROM code_bot_contexts; DELETE FROM code_repository_access; DELETE FROM code_repositories; DELETE FROM bots;"
  );
  await client.exec(`
    INSERT INTO bots (id, slug, name) VALUES
      ('${alphaId}', 'alpha', 'Alpha'),
      ('${betaId}', 'beta', 'Beta');
  `);
});

afterAll(async () => {
  await client.close();
});

interface TestRepository {
  fullName: string;
  githubId: string;
  id: string;
}

const defaultRepository: TestRepository = {
  fullName: "acme/web",
  githubId: "9001",
  id: repoId,
};

function setTask(id: string, values: Partial<typeof codeTasks.$inferInsert>) {
  // Fixtures respect the 0027 terminal <=> finished_at constraint.
  const finished =
    values.status === undefined
      ? {}
      : {
          finishedAt: store.isTerminalTaskStatus(values.status)
            ? new Date()
            : null,
        };
  return database
    .update(codeTasks)
    .set({ ...finished, ...values })
    .where(eq(codeTasks.id, id));
}

function repository(config: TestRepository = defaultRepository) {
  return store.putRepository({
    defaultBranch: "main",
    ...config,
  });
}

async function task(
  id = taskId,
  botId = alphaId,
  config: TestRepository = defaultRepository
) {
  await repository(config);
  return store.createTask({
    ai: {
      agentName: "busy-code-gateway",
      billing: "gateway",
      fast: false,
      model: "openai/gpt-6.1-terra",
    },
    botId,
    goal: "Fix the login redirect and run the checks.",
    id,
    repository: {
      baseBranch: "main",
      fullName: config.fullName,
      id: config.id,
    },
    repositoryId: config.id,
    sourceCallId: `call:${id}`,
    sourceSessionId: `session:${botId}`,
    title: "Fix login redirect",
  });
}

describe("code task database invariants", () => {
  it("creates one task concurrently and atomically writes its start outbox", async () => {
    const results = await Promise.allSettled([task(), task()]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(2);
    const rows = await database.select().from(codeTasks);
    const commands = await database.select().from(codeTaskCommands);
    expect(rows).toHaveLength(1);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      kind: "start",
      messageId: `code-task-${taskId}-start`,
      status: "queued",
    });
  });

  it("normalizes legacy outbox ids to the libfx-safe alphabet", () => {
    const legacy = `code-task:${taskId}:start`;
    expect(fxMessageId(legacy)).toMatch(LEGACY_FX_MESSAGE_ID_PATTERN);
    expect(fxMessageId(legacy)).not.toBe(
      fxMessageId(`code-task-${taskId}-start`)
    );
    expect(fxMessageId("already-safe_message.id-1")).toBe(
      "already-safe_message.id-1"
    );
  });

  it("canonicalizes a legacy command id before leasing it", async () => {
    await task();
    const legacy = `code-task:${taskId}:start`;
    await database
      .update(codeTaskCommands)
      .set({ messageId: legacy })
      .where(eq(codeTaskCommands.taskId, taskId));
    const [lease] = await store.claimCommands();
    expect(lease?.command.messageId).toBe(fxMessageId(legacy));
    const [persisted] = await database
      .select({ messageId: codeTaskCommands.messageId })
      .from(codeTaskCommands)
      .where(eq(codeTaskCommands.taskId, taskId));
    expect(persisted?.messageId).toBe(fxMessageId(legacy));
  });

  it("treats enabled repositories as app-wide while keeping bot context separate", async () => {
    await repository();
    expect(await store.listRepositories()).toEqual([
      expect.objectContaining({ id: repoId }),
    ]);
    await store.setActiveRepo(alphaId, repoId);
    expect((await store.getActiveRepo(alphaId))?.id).toBe(repoId);
    expect(await store.getActiveRepo(betaId)).toBeNull();
    await expect(
      task("55555555-5555-4555-8555-555555555555", betaId)
    ).resolves.toMatchObject({ botId: betaId });
  });

  it("leases commands in order and distinguishes accepted from applied", async () => {
    await task();
    const [first] = await store.claimCommands();
    expect(first).toBeDefined();
    if (!first) {
      throw new Error("Expected start command lease");
    }
    expect(first.command.kind).toBe("start");
    expect(
      (
        await store.recordCommandAccepted(
          first.command.id,
          first.leaseToken,
          first.command.messageId
        )
      ).status
    ).toBe("accepted");
    expect(
      (await store.markInstructionApplied(taskId, first.command.id))
        .appliedInstructionVersion
    ).toBe(1);
    await store.recordCommandSettled(first.command.id, "unsettled");
    const taskAfterStart = await store.getTaskRow(taskId);
    expect(taskAfterStart).toBeDefined();
    if (!taskAfterStart) {
      throw new Error("Expected task after start");
    }
    const steer = await store.enqueueCommand(taskId, {
      expectedVersion: taskAfterStart.version,
      kind: "steer",
      messageId: "code-task-steer-1",
      text: "Run the database checks first.",
    });
    const [second] = await store.claimCommands();
    expect(second).toBeDefined();
    if (!second) {
      throw new Error("Expected steer command lease");
    }
    expect(second.command.id).toBe(steer.id);
    expect(second.command.kind).toBe("steer");
    expect(second.command.revision).toBe(1);
  });

  it("does not regress a terminal or waiting task when an old instruction is replayed", async () => {
    await task();
    const [lease] = await store.claimCommands();
    expect(lease).toBeDefined();
    if (!lease) {
      throw new Error("Expected lease");
    }
    await store.markInstructionApplied(taskId, lease.command.id);
    await store.recordCommandSettled(lease.command.id, "unsettled");
    await setTask(taskId, { status: "ready" });
    await expect(
      store.markInstructionApplied(taskId, lease.command.id)
    ).resolves.toMatchObject({ appliedInstructionVersion: 1, status: "ready" });
  });

  it("accepts a command whose stream was applied before the delivery acknowledgement", async () => {
    await task();
    const [lease] = await store.claimCommands();
    expect(lease).toBeDefined();
    if (!lease) {
      throw new Error("Expected lease");
    }
    await database
      .update(codeTaskCommands)
      .set({ leaseToken: lease.leaseToken, status: "applied" })
      .where(eq(codeTaskCommands.id, lease.command.id));
    await expect(
      store.recordCommandAccepted(
        lease.command.id,
        lease.leaseToken,
        lease.command.messageId
      )
    ).resolves.toMatchObject({ status: "applied" });
  });

  it("returns an idempotent retry for a command after the task became terminal", async () => {
    await task();
    const command = await store.enqueueCommand(taskId, {
      kind: "cancel",
      messageId: "cancel-once",
    });
    await setTask(taskId, { status: "cancelled" });
    await expect(
      store.enqueueCommand(taskId, { kind: "cancel", messageId: "cancel-once" })
    ).resolves.toMatchObject({ id: command.id, status: "queued" });
  });

  it("rejects a steer after cleanup records a deleted workspace", async () => {
    await task();
    await setTask(taskId, {
      execution: { workspaceDeletedAt: new Date().toISOString() },
    });
    await expect(
      store.enqueueCommand(taskId, {
        kind: "steer",
        messageId: "steer-after-cleanup",
        text: "Continue the implementation.",
      })
    ).rejects.toThrow("workspace is no longer available");
    await expect(
      store.enqueueCommand(taskId, {
        kind: "cancel",
        messageId: "cancel-after-cleanup",
      })
    ).resolves.toMatchObject({ kind: "cancel", status: "queued" });
  });

  it("rejects a steer after cleanup reserves an expired workspace", async () => {
    await task(secondTaskId, betaId);
    await setTask(secondTaskId, {
      execution: { workspaceExpiredAt: new Date().toISOString() },
    });
    await expect(
      store.enqueueCommand(secondTaskId, {
        kind: "steer",
        messageId: "steer-after-expiry",
        text: "Continue the implementation.",
      })
    ).rejects.toThrow("workspace is no longer available");
  });

  it("reserves execution slots atomically by repository and global budget", async () => {
    await task();
    await task(secondTaskId, betaId);
    await task(thirdTaskId, alphaId, {
      fullName: "acme/mobile",
      githubId: "9002",
      id: secondRepoId,
    });
    await task(fourthTaskId, betaId, {
      fullName: "acme/api",
      githubId: "9003",
      id: thirdRepoId,
    });

    const [sameRepositoryFirst, sameRepositorySecond] = await Promise.all([
      store.reserveExecution(taskId),
      store.reserveExecution(secondTaskId),
    ]);
    expect(
      [sameRepositoryFirst, sameRepositorySecond].filter(Boolean)
    ).toHaveLength(1);

    const activeSameRepositoryId = sameRepositoryFirst ? taskId : secondTaskId;
    expect(await store.reserveExecution(thirdTaskId)).toMatchObject({
      id: thirdTaskId,
      status: "running",
    });
    expect(await store.reserveExecution(fourthTaskId)).toBeNull();

    const activeTask = await store.getTaskRow(activeSameRepositoryId);
    if (!activeTask) {
      throw new Error("Expected the task that acquired the repository slot");
    }
    await setTask(activeSameRepositoryId, {
      execution: { ...activeTask.execution, executionReserved: true },
      status: "ready",
    });
    expect(await store.reserveExecution(fourthTaskId)).toMatchObject({
      id: fourthTaskId,
      status: "running",
    });
  });

  it("serializes concurrent reservations against the global budget", async () => {
    await task();
    await task(thirdTaskId, alphaId, {
      fullName: "acme/mobile",
      githubId: "9002",
      id: secondRepoId,
    });
    await task(fourthTaskId, betaId, {
      fullName: "acme/api",
      githubId: "9003",
      id: thirdRepoId,
    });
    expect(await store.reserveExecution(taskId)).toMatchObject({
      id: taskId,
      status: "running",
    });

    const [first, second] = await Promise.all([
      store.reserveExecution(thirdTaskId),
      store.reserveExecution(fourthTaskId),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it("resets the active execution window when waking a waiting task", async () => {
    await task();
    const before = Date.now();
    await setTask(taskId, {
      execution: { executionReserved: true, modelRequests: 11 },
      status: "waiting_for_input",
    });
    const command = await store.enqueueCommand(taskId, {
      kind: "steer",
      messageId: "steer-after-wait",
      text: "Continue from the last checkpoint.",
    });
    const row = await store.getTaskRow(taskId);
    expect(command.kind).toBe("steer");
    expect(row).toMatchObject({ phase: "recovering", status: "queued" });
    expect(row?.execution).toMatchObject({
      executionReserved: false,
      modelRequests: 11,
    });
    expect(row?.execution.startedAt).toBeGreaterThanOrEqual(before);
  });

  it("rejects reassociating a task with another session", async () => {
    await task();
    await store.associateSession(taskId, "wrun_first", "busy-code-gateway");
    await expect(
      store.associateSession(taskId, "wrun_second", "busy-code-gateway")
    ).rejects.toThrow("different durable session");
    await expect(
      store.associateSession(taskId, "wrun_first", "busy-code-gateway")
    ).resolves.toMatchObject({ durableSessionId: "wrun_first" });
  });

  it("keeps a publication lease outside the transaction while guarding updates", async () => {
    await task();
    await store.associateSession(taskId, "wrun_publish", "busy-code-gateway");
    await store.markInstructionApplied(taskId, `${taskId}`);
    await store.recordCommandSettled(taskId, "unsettled");
    await expect(
      store.withPublicationLease(taskId, 1, 1, async (_row, leaseToken) => {
        await expect(
          store.enqueueCommand(taskId, {
            kind: "cancel",
            messageId: "cancel-during-publish",
          })
        ).rejects.toThrow("publishing");
        await store.updateTask(
          taskId,
          { summary: "Published branch checked." },
          { leaseToken }
        );
        return "published";
      })
    ).resolves.toBe("published");
    await expect(
      store.enqueueCommand(taskId, {
        kind: "cancel",
        messageId: "cancel-after-publish",
      })
    ).resolves.toMatchObject({ kind: "cancel" });
  });

  it("preserves task history when the originating bot is deleted", async () => {
    await task();
    await client.exec(`DELETE FROM bots WHERE id = '${alphaId}';`);
    const row = await store.getTaskRow(taskId);
    expect(row).toMatchObject({
      botId: null,
      repositoryFullName: "acme/web",
      title: "Fix login redirect",
    });
  });

  it("deduplicates projected events by source key and advances the cursor", async () => {
    await task();
    const first = await store.appendEvent(
      taskId,
      "fx.text_delta",
      { text: "hello" },
      { sourceKey: "cursor:1" }
    );
    const repeated = await store.appendEvent(
      taskId,
      "fx.text_delta",
      { text: "different" },
      { sourceKey: "cursor:1" }
    );
    expect(repeated).toEqual(first);
    expect((await store.listEvents(taskId)).map((event) => event.seq)).toEqual([
      1, 2,
    ]);
  });

  it("records Gateway generations and costs idempotently", async () => {
    await task();
    await store.recordGenerationId(taskId, "gen_01COST");
    await store.recordGenerationId(taskId, "gen_01COST");
    await store.recordGenerationCost(taskId, {
      gatewayCost: 0.0012,
      generationId: "gen_01COST",
      marketCost: 0.001,
      surchargeCost: 0.0002,
      totalCost: 0.0012,
    });
    await store.recordGenerationCost(taskId, {
      gatewayCost: 0.0012,
      generationId: "gen_01COST",
      marketCost: 0.001,
      surchargeCost: 0.0002,
      totalCost: 0.0012,
    });
    const current = await store.getPublicTask(taskId);
    expect(current?.usage).toMatchObject({
      costStatus: "reported",
      costUsd: 0.0012,
    });
    expect(
      (await store.listEvents(taskId)).filter((event) =>
        event.type.startsWith("usage.")
      )
    ).toHaveLength(2);
  });

  it("keeps recorded usage when a stale execution patch is applied", async () => {
    await task();
    const stale = await store.getTaskRow(taskId);
    await store.recordTurnUsage(taskId, 8, {
      inputTokens: 10,
      outputTokens: 4,
    });
    await store.updateTask(taskId, {
      execution: { ...(stale?.execution ?? {}), modelRequests: 2 },
    });
    const current = await store.getPublicTask(taskId);
    expect(current?.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 4,
      requests: 1,
    });
  });

  it("advances the stream cursor atomically with a projected event", async () => {
    await task();
    await store.appendEvent(
      taskId,
      "agent.message",
      { message: "hello" },
      { sourceKey: "cursor:1", throughStreamCursor: 17 }
    );
    await store.appendEvent(
      taskId,
      "agent.message",
      { message: "hello" },
      { sourceKey: "cursor:1", throughStreamCursor: 12 }
    );
    expect((await store.getTaskRow(taskId))?.lastStreamCursor).toBe(17);
  });

  it("rejects an overlapping narration batch without appending it", async () => {
    await task();
    const initialEvents = await store.listEvents(taskId);
    const first = await store.appendEvent(
      taskId,
      "agent.message",
      { message: "first" },
      { afterStreamCursor: 0, sourceKey: "cursor:1", throughStreamCursor: 17 }
    );
    await expect(
      store.appendEvent(
        taskId,
        "agent.message",
        { message: "overlap" },
        {
          afterStreamCursor: 12,
          sourceKey: "cursor:2",
          throughStreamCursor: 20,
        }
      )
    ).rejects.toThrow("stream advanced");
    expect((await store.listEvents(taskId)).length).toBe(
      initialEvents.length + 1
    );
    await expect(
      store.appendEvent(
        taskId,
        "agent.message",
        { message: "replay" },
        {
          afterStreamCursor: 12,
          sourceKey: "cursor:1",
          throughStreamCursor: 20,
        }
      )
    ).resolves.toMatchObject({ seq: first.seq });
  });
});

describe("code task migration invariants", () => {
  it("enables RLS and revokes browser privileges", async () => {
    const rls = await client.query<{
      relname: string;
      relrowsecurity: boolean;
    }>(
      "SELECT relname, relrowsecurity FROM pg_class WHERE relkind = 'r' AND relname IN ('code_repositories', 'code_tasks', 'code_task_commands', 'code_task_events') ORDER BY relname"
    );
    expect(rls.rows).toEqual([
      { relname: "code_repositories", relrowsecurity: true },
      { relname: "code_task_commands", relrowsecurity: true },
      { relname: "code_task_events", relrowsecurity: true },
      { relname: "code_tasks", relrowsecurity: true },
    ]);
    const privileges = await Promise.all(
      ["anon", "authenticated"].map((role) =>
        client.query<{ allowed: boolean }>(
          `SELECT has_table_privilege('${role}', 'public.code_tasks', 'SELECT') AS allowed`
        )
      )
    );
    for (const result of privileges) {
      expect(result.rows[0]?.allowed).toBe(false);
    }
  });
});
