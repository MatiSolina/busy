/**
 * State-machine regressions for remote code tasks (H-06, H-13, H-14, H-15,
 * N-03 and the code-task side of H-25). Every race is forced with a barrier
 * placed inside the real call path: the competing write commits between the
 * writer's read and its compare-and-set. PGlite is a single connection, so
 * row-lock contention between connections is not reproduced; the CAS
 * predicates are what these tests prove.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { FxAgentHostTool, FxToolContext } from "libfx";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { botsMigrations } from "./lib/bots/test-helpers";
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
const repoId = "33333333-3333-4333-8333-333333333333";
const taskId = "44444444-4444-4444-8444-444444444444";
const otherTaskId = "55555555-5555-4555-8555-555555555555";
const SESSION = "wrun_task";
const MINUTE = 60_000;

type TransitionArgs = [string, Record<string, unknown>];
const h = vi.hoisted(() => ({
  agentOptions: new Map<string, Record<string, unknown>>(),
  beforeTransition: null as
    | ((...args: [string, Record<string, unknown>]) => Promise<void>)
    | null,
  cancel: vi.fn(),
  github: vi.fn(),
  lines: new Map<string, unknown[]>(),
  probes: [] as string[],
  prompt: vi.fn(),
  sendMessage: vi.fn(),
  steer: vi.fn(),
}));

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
let runtime: typeof import("./lib/code-tasks/runtime");
let tools: typeof import("./lib/code-tasks/agent-tools");
let notify: typeof import("./lib/code-tasks/notify");
let deletion: typeof import("./lib/code-tasks/bot-deletion");

function fakeSession(id: string) {
  return {
    cancel: async () => {
      await h.cancel(id);
    },
    prompt: (_text: string, options: { messageId: string }) => ({
      accepted: Promise.resolve(h.prompt(id, options)).then(() => ({
        messageId: options.messageId,
        sessionId: id,
      })),
    }),
    resume: () => ({
      accepted: Promise.resolve({
        messageId: h.probes.shift() ?? "probe-unused",
        sessionId: id,
      }),
    }),
    steer: async (text: string, options: { messageId: string }) => {
      await h.steer(id, text, options);
      return { messageId: options.messageId };
    },
    stream: (cursor = 0) => {
      const encoder = new TextEncoder();
      const pending = (h.lines.get(id) ?? []).filter(
        (line) => (line as { cursor: number }).cursor > cursor
      );
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of pending) {
            controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          }
          controller.close();
        },
      });
    },
  };
}

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
  await client.exec(botsMigrations());
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
  vi.doMock("@/lib/db", () => ({ ...schema, db: () => database }));
  vi.doMock("libfx", () => ({
    createFxAgent: (options: Record<string, unknown>) => {
      h.agentOptions.set(String(options.name), options);
      return {
        name: options.name,
        newSessionId: async () => SESSION,
        session: (id: string) => fakeSession(id),
      };
    },
  }));
  vi.doMock("libfx/durable-world", () => ({ world: () => ({}) }));
  vi.doMock("durable-harness", () => ({
    getWorld: async () => ({}),
    sandbox: () => ({}),
    waitUntil: () => undefined,
  }));
  vi.doMock("durable-harness/fx", () => ({
    fxTools: () => [
      {
        description: "shell",
        execute: async () => JSON.stringify({ exit_code: 0, output_delta: "" }),
        idempotent: false,
        inputSchema: {},
        name: "shell",
      },
    ],
  }));
  vi.doMock("@vercel/oidc", () => ({ getVercelOidcToken: async () => "oidc" }));
  vi.doMock("@/lib/ai/subscription-store", () => ({
    getSubscriptionAccess: async () => ({
      credentials: { accessToken: "subscription-token" },
      models: [],
    }),
  }));
  vi.doMock("@/lib/eve/client", () => ({ sendMessage: h.sendMessage }));
  vi.doMock("@/lib/chat/store", () => ({ syncBot: async () => undefined }));
  vi.doMock("@/lib/hub-token", () => ({ signCodeTaskToken: () => "token" }));
  vi.doMock("./lib/code-tasks/github", () => ({
    downloadRepositoryArchive: h.github,
    publishChanges: h.github,
    reconcilePublication: h.github,
    resolveRepository: h.github,
    updateDraftDetails: h.github,
  }));
  vi.doMock("./lib/code-tasks/workspace", () => ({
    captureWorkspace: vi.fn(),
    prepareWorkspace: vi.fn(),
  }));
  vi.doMock("./lib/code-tasks/store", async () => {
    const actual = await vi.importActual<
      typeof import("./lib/code-tasks/store")
    >("./lib/code-tasks/store");
    return {
      ...actual,
      transitionTask: async (...args: TransitionArgs) => {
        const barrier = h.beforeTransition;
        if (barrier) {
          // One-shot: the competing write runs exactly once, inside the gap.
          h.beforeTransition = null;
          await barrier(...args);
        }
        return actual.transitionTask(
          ...(args as unknown as Parameters<typeof actual.transitionTask>)
        );
      },
    };
  });
  vi.resetModules();
  store = await import("./lib/code-tasks/store");
  runtime = await import("./lib/code-tasks/runtime");
  tools = await import("./lib/code-tasks/agent-tools");
  notify = await import("./lib/code-tasks/notify");
  deletion = await import("./lib/code-tasks/bot-deletion");
});

beforeEach(async () => {
  await client.exec(
    "DELETE FROM code_task_bot_shutdowns; DELETE FROM code_task_events; DELETE FROM code_task_commands; DELETE FROM code_tasks; DELETE FROM code_bot_contexts; DELETE FROM code_repository_access; DELETE FROM code_repositories; DELETE FROM bots;"
  );
  await client.exec(`
    INSERT INTO bots (id, slug, name, session_id, url) VALUES
      ('${alphaId}', 'alpha', 'Alpha', 'main-session', 'https://alpha.bots.test');
    INSERT INTO code_repositories (id, github_id, full_name, default_branch, connection_id)
      VALUES ('${repoId}', '9001', 'acme/web', 'main', NULL);
  `);
  h.beforeTransition = null;
  h.lines.clear();
  h.probes = [];
  h.cancel.mockReset();
  h.github.mockReset();
  h.prompt.mockReset();
  h.steer.mockReset();
  h.sendMessage.mockReset();
  h.sendMessage.mockResolvedValue({ deliveryId: "delivery" });
});

afterEach(async () => {
  // N-03: no transition in any scenario may break terminal ⇔ finishedAt.
  const broken = await client.query<{ count: number }>(`
    SELECT count(*)::int AS count FROM code_tasks
    WHERE (status IN ('ready','failed','needs_attention','cancelled') AND finished_at IS NULL)
       OR (status IN ('queued','running','waiting_for_input','cancel_requested') AND finished_at IS NOT NULL)
  `);
  if (broken.rows[0]?.count !== 0) {
    throw new Error("A transition broke the terminal/finishedAt invariant.");
  }
});

afterAll(async () => {
  await client.close();
});

type TaskInsert = Partial<typeof codeTasks.$inferInsert>;

async function seedTask(values: TaskInsert = {}, id = taskId) {
  const status = values.status ?? "running";
  await database.insert(codeTasks).values({
    appliedInstructionVersion: 1,
    baseBranch: "main",
    billing: "gateway",
    botId: alphaId,
    branch: `codex/busy-${id.slice(0, 8)}`,
    durableSessionId: id === taskId ? SESSION : `wrun_${id.slice(0, 8)}`,
    execution: {
      executionReserved: status === "running",
      startedAt: Date.now(),
    },
    finishedAt: store.isTerminalTaskStatus(status) ? new Date() : null,
    goal: "Fix the login redirect.",
    id,
    model: "openai/gpt-test",
    repositoryFullName: id === taskId ? "acme/web" : "acme/other",
    repositoryId: id === taskId ? repoId : null,
    repositorySnapshotId: repoId,
    sourceCallId: `call-${id}`,
    sourceSessionId: "main-session",
    status,
    title: "Fix login",
    ...values,
  });
  return (await store.getTaskRow(id)) as NonNullable<
    Awaited<ReturnType<typeof store.getTaskRow>>
  >;
}

function setTask(values: TaskInsert, id = taskId) {
  return database.update(codeTasks).set(values).where(eq(codeTasks.id, id));
}

async function seedCommand(
  values: Partial<typeof codeTaskCommands.$inferInsert>
) {
  const [row] = await database
    .insert(codeTaskCommands)
    .values({
      expectedVersion: 0,
      instructionVersion: 1,
      kind: "start",
      messageId: `m-${Math.random().toString(36).slice(2)}`,
      revision: 1,
      status: "accepted",
      taskId,
      ...values,
    })
    .returning();
  if (!row) {
    throw new Error("command not inserted");
  }
  return row;
}

async function task(id = taskId) {
  const row = await store.getTaskRow(id);
  if (!row) {
    throw new Error("task missing");
  }
  return row;
}

async function events(id = taskId) {
  const rows = await database
    .select()
    .from(codeTaskEvents)
    .where(eq(codeTaskEvents.taskId, id));
  return rows.map((row) => row.type);
}

function context(generation?: number, sessionId = SESSION): FxToolContext {
  return {
    executionId: `call-${Math.random()}`,
    sessionId,
    signal: new AbortController().signal,
    ...(generation === undefined
      ? {}
      : { context: { executionGeneration: generation } }),
  };
}

function hostTool(name: string): FxAgentHostTool {
  const shell: FxAgentHostTool = {
    description: "shell",
    execute: async () => "ok",
    idempotent: false,
    inputSchema: {},
    name: "shell",
  };
  const found = tools
    .codingTools([shell], async () => undefined)
    .find((tool) => tool.name === name);
  if (!found) {
    throw new Error(`missing tool ${name}`);
  }
  return found;
}

function streamLines(lines: Record<string, unknown>[]) {
  h.lines.set(SESSION, lines as unknown[]);
}

describe("H-06 cancellation is never overwritten", () => {
  it("ask_user loses to a cancellation committed after taskFor read running", async () => {
    await seedTask();
    h.beforeTransition = async () => {
      await store.enqueueCommand(taskId, {
        kind: "cancel",
        messageId: "cancel-during-ask",
      });
    };
    await expect(
      hostTool("ask_user").execute({ question: "Which branch?" }, context())
    ).rejects.toThrow("cancelled");
    expect(await task()).toMatchObject({
      finishedAt: null,
      status: "cancel_requested",
    });
    expect(await events()).not.toContain("question");
  });

  it("the profileFor execution limit does not overwrite a concurrent cancellation", async () => {
    await seedTask({
      execution: {
        executionReserved: true,
        startedAt: Date.now() - 46 * MINUTE,
      },
    });
    h.beforeTransition = async () => {
      await store.enqueueCommand(taskId, {
        kind: "cancel",
        messageId: "cancel-during-limit",
      });
    };
    await expect(runtime.profileFor(SESSION)).resolves.toBeNull();
    expect((await task()).status).toBe("cancel_requested");
  });

  it("a dispatch failure after three attempts does not overwrite cancel_requested", async () => {
    await seedTask();
    await seedCommand({
      attempts: 2,
      instructionVersion: 2,
      kind: "steer",
      messageId: "steer-fails",
      status: "queued",
      text: "Also update docs.",
    });
    await setTask({ instructionVersion: 2 });
    h.steer.mockImplementation(async () => {
      // The cancellation lands while the provider call is in flight.
      await store.enqueueCommand(taskId, {
        kind: "cancel",
        messageId: "cancel-during-dispatch",
      });
      throw new Error("provider unavailable");
    });
    await runtime.dispatchCodeCommands();
    expect((await task()).status).toBe("cancel_requested");
    const [steer] = await database
      .select()
      .from(codeTaskCommands)
      .where(eq(codeTaskCommands.messageId, "steer-fails"));
    expect(steer?.status).toBe("failed");
  });

  it("an ended turn does not park a task that was cancelled before the write", async () => {
    await seedTask();
    streamLines([
      {
        cursor: 1,
        messageId: "turn-1",
        stopReason: "end_turn",
        type: "turn_end",
      },
    ]);
    h.beforeTransition = async (_id, transition) => {
      if (transition.to === "needs_attention") {
        await store.enqueueCommand(taskId, {
          kind: "cancel",
          messageId: "cancel-during-turn-end",
        });
      }
    };
    await runtime.projectTask(taskId);
    expect((await task()).status).toBe("cancel_requested");
    expect(await events()).not.toContain("task.needs_attention");
  });

  it("confirms only the probe of the dispatched order; a retry adds no order", async () => {
    await seedTask();
    const first = await store.enqueueCommand(taskId, {
      kind: "cancel",
      messageId: "cancel-one",
    });
    const again = await store.enqueueCommand(taskId, {
      kind: "cancel",
      messageId: "cancel-one",
    });
    expect(again.id).toBe(first.id);
    h.probes.push("probe-1");
    await runtime.dispatchCodeCommands();
    let row = await task();
    expect(row.status).toBe("cancel_requested");
    expect(row.execution).toMatchObject({
      cancelCommandId: first.id,
      cancelProbeId: "probe-1",
    });
    streamLines([{ cursor: 1, requestId: "probe-foreign", type: "idle" }]);
    await runtime.projectTask(taskId);
    expect((await task()).status).toBe("cancel_requested");
    streamLines([
      { cursor: 1, requestId: "probe-foreign", type: "idle" },
      { cursor: 2, requestId: "probe-1", type: "idle" },
    ]);
    await runtime.projectTask(taskId);
    row = await task();
    expect(row.status).toBe("cancelled");
    expect(row.finishedAt).not.toBeNull();
    const commands = await database
      .select()
      .from(codeTaskCommands)
      .where(eq(codeTaskCommands.taskId, taskId));
    expect(commands.map((command) => command.status)).toEqual(["settled"]);
    // A late duplicate confirmation changes nothing.
    const { version } = row;
    await setTask({ lastStreamCursor: 0 });
    await runtime.projectTask(taskId);
    expect((await task()).version).toBe(version);
  });

  it("cancels a task that never got a session without waiting for a stream", async () => {
    await seedTask({
      durableSessionId: null,
      execution: {},
      status: "queued",
    });
    await store.enqueueCommand(taskId, { kind: "cancel", messageId: "c" });
    await runtime.dispatchCodeCommands();
    expect(await task()).toMatchObject({ status: "cancelled" });
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("cancelling a ready task keeps its PR and performs no GitHub mutation", async () => {
    await seedTask({
      pullRequestUrl: "https://github.com/acme/web/pull/7",
      status: "ready",
    });
    await store.enqueueCommand(taskId, { kind: "cancel", messageId: "c" });
    h.probes.push("probe-ready");
    await runtime.dispatchCodeCommands();
    streamLines([{ cursor: 1, requestId: "probe-ready", type: "idle" }]);
    await runtime.projectTask(taskId);
    expect(await task()).toMatchObject({
      pullRequestUrl: "https://github.com/acme/web/pull/7",
      status: "cancelled",
    });
    expect(h.github).not.toHaveBeenCalled();
  });
});

describe("H-13 watchdog: silent runtime, fencing and recovery", () => {
  async function silentTask(extra: Record<string, unknown> = {}) {
    return await seedTask({
      execution: {
        executionReserved: true,
        runtimeHeartbeatAt: Date.now() - 20 * MINUTE,
        startedAt: Date.now() - 30 * MINUTE,
        ...extra,
      },
      updatedAt: new Date(Date.now() - 30 * MINUTE),
    });
  }

  it("fences first, keeps slot and workspace, then releases only after a confirmed stop", async () => {
    await silentTask();
    await seedTask({ execution: {}, status: "queued" }, otherTaskId);
    await setTask({ repositoryFullName: "acme/web" }, otherTaskId);
    h.probes.push("probe-stop");
    const now = Date.now();
    await runtime.superviseCodeTasks(now);
    let row = await task();
    expect(row).toMatchObject({ phase: "recovering", status: "running" });
    expect(row.finishedAt).toBeNull();
    expect(row.execution).toMatchObject({
      executionGeneration: 1,
      executionReserved: true,
      recovery: { probeId: "probe-stop", reason: "runtime_silent" },
    });
    expect(h.cancel).toHaveBeenCalledWith(SESSION);
    // The repository slot is still held.
    expect(await store.reserveExecution(otherTaskId)).toBeNull();

    // Repeating the cron is idempotent.
    const { version } = row;
    await runtime.superviseCodeTasks(now + 1000);
    expect((await task()).version).toBe(version);
    expect(
      (await events()).filter((type) => type === "task.recovering")
    ).toHaveLength(1);

    // The old runtime is rejected at every broker point.
    await expect(
      hostTool("ask_user").execute({ question: "?" }, context(0))
    ).rejects.toThrow();
    await expect(
      store.withPublicationLease(taskId, 1, 1, async () => "published", 0)
    ).rejects.toThrow("stale");
    await expect(runtime.profileFor(SESSION)).resolves.toBeNull();
    await runtime.codeAgents();
    const codex = h.agentOptions.get("busy-code-chatgpt") as {
      credentials: (input: { sessionId: string }) => Promise<unknown>;
    };
    await setTask({ billing: "chatgpt" });
    await expect(codex.credentials({ sessionId: SESSION })).rejects.toThrow(
      "does not belong"
    );
    await setTask({ billing: "gateway" });

    // The stop probe comes back: confirmed stop, reservation released once.
    streamLines([{ cursor: 1, requestId: "probe-stop", type: "idle" }]);
    await runtime.projectTask(taskId);
    row = await task();
    expect(row).toMatchObject({ phase: null, status: "needs_attention" });
    expect(row.finishedAt).not.toBeNull();
    expect(row.execution).toMatchObject({
      executionReserved: false,
      recovery: { outcome: "stop_confirmed" },
    });
    expect(row.execution.workspaceDeletedAt).toBeUndefined();
    expect(await store.reserveExecution(otherTaskId)).not.toBeNull();

    // A new writer after an explicit correction uses the new generation.
    await store.enqueueCommand(taskId, {
      kind: "steer",
      messageId: "resume-after-recovery",
      text: "Continue.",
    });
    await setTask({ status: "running" });
    expect(await store.admitToolCall(taskId, SESSION, 0)).toBeNull();
    expect(await store.admitToolCall(taskId, SESSION, 1)).not.toBeNull();
    expect((await task()).execution).toMatchObject({
      lastRecovery: { outcome: "stop_confirmed" },
    });
  });

  it("an unconfirmed stop never releases anything, however long it lasts; it only retries the stop", async () => {
    await silentTask();
    await seedTask({ execution: {}, status: "queued" }, otherTaskId);
    await setTask({ repositoryFullName: "acme/web" }, otherTaskId);
    h.cancel.mockRejectedValueOnce(new Error("world unreachable"));
    h.probes.push("probe-lost", "probe-late");
    const now = Date.now();
    await runtime.superviseCodeTasks(now);
    await runtime.superviseCodeTasks(now + MINUTE);
    expect(h.cancel).toHaveBeenCalledTimes(2);
    await runtime.superviseCodeTasks(now + 2 * MINUTE);
    // Within the retry window no further stop request is sent.
    expect(h.cancel).toHaveBeenCalledTimes(2);
    for (const hours of [1, 6, 48]) {
      // biome-ignore lint/performance/noAwaitInLoops: each pass observes the previous one.
      await runtime.superviseCodeTasks(now + hours * 60 * MINUTE);
      const row = await task();
      expect(row).toMatchObject({
        finishedAt: null,
        phase: "recovering",
        status: "running",
      });
      expect(row.execution).toMatchObject({ executionReserved: true });
      expect(row.execution.workspaceDeletedAt).toBeUndefined();
      expect(await store.reserveExecution(otherTaskId)).toBeNull();
    }
    expect(h.cancel.mock.calls.length).toBeGreaterThan(2);
    // A probe from an earlier stop request still confirms the stop.
    streamLines([{ cursor: 1, requestId: "probe-lost", type: "idle" }]);
    await runtime.projectTask(taskId);
    const row = await task();
    expect(row.status).toBe("needs_attention");
    expect(row.execution).toMatchObject({
      executionReserved: false,
      recovery: { outcome: "stop_confirmed" },
    });
  });

  it("a recent heartbeat protects a task; recent projection alone does not", async () => {
    await seedTask({
      execution: {
        executionReserved: true,
        runtimeHeartbeatAt: Date.now() - MINUTE,
        startedAt: Date.now() - 40 * MINUTE,
      },
    });
    await seedTask(
      {
        execution: {
          executionReserved: true,
          observedAt: Date.now(),
          runtimeHeartbeatAt: Date.now() - 20 * MINUTE,
          startedAt: Date.now() - 40 * MINUTE,
        },
      },
      otherTaskId
    );
    await runtime.superviseCodeTasks(Date.now());
    expect((await task()).phase).not.toBe("recovering");
    expect((await task(otherTaskId)).phase).toBe("recovering");
  });

  it("two concurrent crons fence a task exactly once", async () => {
    await silentTask();
    const before = (await task()).version;
    const now = Date.now();
    await Promise.all([
      runtime.superviseCodeTasks(now),
      runtime.superviseCodeTasks(now),
    ]);
    expect((await task()).version).toBe(before + 1);
    expect(
      (await events()).filter((type) => type === "task.recovering")
    ).toHaveLength(1);
  });

  it("a runtime admitted between the watchdog's read and its fence wins", async () => {
    await silentTask();
    h.beforeTransition = async (_id, transition) => {
      if (transition.patch && "phase" in (transition.patch as object)) {
        await store.admitToolCall(taskId, SESSION, 0);
      }
    };
    await runtime.superviseCodeTasks(Date.now());
    const row = await task();
    expect(row.phase).not.toBe("recovering");
    expect(store.activeRecovery(row.execution)).toBeNull();
  });

  it("a stalled cancellation stays cancel_requested until the stop is confirmed, then reconciles its order", async () => {
    await seedTask({
      execution: {
        cancelRequestedAt: Date.now() - 20 * MINUTE,
        executionReserved: true,
        runtimeHeartbeatAt: Date.now() - 25 * MINUTE,
        startedAt: Date.now() - 30 * MINUTE,
      },
      status: "cancel_requested",
    });
    await seedCommand({ kind: "cancel", status: "accepted" });
    h.probes.push("probe-cancel-stop");
    const now = Date.now();
    await runtime.superviseCodeTasks(now);
    expect(await task()).toMatchObject({
      phase: "recovering",
      status: "cancel_requested",
    });
    await runtime.superviseCodeTasks(now + 24 * 60 * MINUTE);
    expect((await task()).status).toBe("cancel_requested");
    streamLines([{ cursor: 1, requestId: "probe-cancel-stop", type: "idle" }]);
    await runtime.projectTask(taskId);
    expect((await task()).status).toBe("cancelled");
    const commands = await database
      .select()
      .from(codeTaskCommands)
      .where(eq(codeTaskCommands.taskId, taskId));
    expect(commands.map((command) => command.status)).toEqual(["settled"]);
    expect(await events()).toContain("command.reconciled");
  });

  it("a turn_end recorded by the session also confirms the stop of a recovering task", async () => {
    await silentTask();
    h.probes.push("probe-unanswered");
    await runtime.superviseCodeTasks(Date.now());
    streamLines([
      {
        cursor: 1,
        messageId: "turn-1",
        stopReason: "cancelled",
        type: "turn_end",
      },
    ]);
    await runtime.projectTask(taskId);
    const row = await task();
    expect(row.status).toBe("needs_attention");
    expect(row.execution).toMatchObject({
      executionReserved: false,
      recovery: { outcome: "turn_ended" },
    });
  });

  it("a task with a queued command is left to dispatch", async () => {
    await silentTask();
    await seedCommand({
      instructionVersion: 2,
      kind: "steer",
      status: "queued",
    });
    await runtime.superviseCodeTasks(Date.now());
    expect((await task()).phase).not.toBe("recovering");
  });
});

describe("H-14 markInstructionApplied never revives a terminal task", () => {
  const statuses = [
    "ready",
    "waiting_for_input",
    "cancel_requested",
    "cancelled",
    "failed",
    "needs_attention",
  ] as const;
  it.each(statuses)(
    "keeps %s on a late turn_start/user_message",
    async (status) => {
      const seeded = await seedTask({
        execution: { executionReserved: false },
        instructionVersion: 2,
        status,
      });
      const command = await seedCommand({
        instructionVersion: 2,
        kind: "steer",
        status: "accepted",
      });
      const result = await store.markInstructionApplied(taskId, command.id);
      expect(result.status).toBe(status);
      const row = await task();
      expect(row.status).toBe(status);
      expect(row.finishedAt?.getTime() ?? null).toBe(
        seeded.finishedAt?.getTime() ?? null
      );
      const [after] = await database
        .select()
        .from(codeTaskCommands)
        .where(eq(codeTaskCommands.id, command.id));
      const terminal = ["cancelled", "failed", "needs_attention"].includes(
        status
      );
      expect(after?.status).toBe(terminal ? "settled" : "applied");
      // Replays are idempotent: no further version bump.
      await store.markInstructionApplied(taskId, command.id);
      expect((await task()).version).toBe(row.version);
    }
  );

  it("moves only queued/running to running", async () => {
    await seedTask({ execution: {}, status: "queued" });
    const command = await seedCommand({ status: "accepted" });
    await setTask({ appliedInstructionVersion: 0 });
    expect(
      (await store.markInstructionApplied(taskId, command.id)).status
    ).toBe("running");
  });

  it("an explicit steer is the only way to revive needs_attention", async () => {
    await seedTask({ status: "needs_attention" });
    await store.enqueueCommand(taskId, {
      kind: "steer",
      messageId: "explicit-steer",
      text: "Try again.",
    });
    expect(await task()).toMatchObject({
      finishedAt: null,
      phase: "recovering",
      status: "queued",
    });
  });

  it("projecting late turn_start after cancellation leaves it terminal", async () => {
    await seedTask({ status: "cancelled" });
    const command = await seedCommand({ kind: "start", status: "accepted" });
    await setTask({ appliedInstructionVersion: 0 });
    streamLines([
      {
        cursor: 1,
        messageId: command.messageId,
        sessionId: SESSION,
        type: "turn_start",
      },
    ]);
    await runtime.projectTask(taskId);
    expect((await task()).status).toBe("cancelled");
  });
});

describe("H-15 status-aware result outbox", () => {
  it("notifies waiting_for_input and then cancelled with distinct ids", async () => {
    await seedTask({ status: "waiting_for_input", summary: "Which branch?" });
    await runtime.recoverCodeTasks();
    await setTask({ finishedAt: new Date(), status: "cancelled" });
    await runtime.recoverCodeTasks();
    await runtime.recoverCodeTasks();
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
    const [first, second] = h.sendMessage.mock.calls.map(
      (call) => call[2] as { id: string; text: string }
    );
    expect(first?.id).not.toBe(second?.id);
    expect(second?.text).toContain("Status: cancelled");
  });

  it("retries of the same status reuse one message id", async () => {
    await seedTask({ status: "ready" });
    h.sendMessage.mockRejectedValueOnce(new Error("bot offline"));
    await runtime.recoverCodeTasks();
    await runtime.recoverCodeTasks();
    await runtime.recoverCodeTasks();
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
    const ids = h.sendMessage.mock.calls.map((call) => call[2].id);
    expect(new Set(ids).size).toBe(1);
  });

  it("a status change during the send is not marked delivered nor sent to a replacement session", async () => {
    await seedTask({ status: "waiting_for_input" });
    h.sendMessage.mockImplementationOnce(async () => {
      await setTask({ finishedAt: new Date(), status: "cancelled" });
      await client.exec(
        `UPDATE bots SET session_id = 'replacement' WHERE id = '${alphaId}'`
      );
      return { deliveryId: "d" };
    });
    await notify.notifyCodeResult(taskId);
    expect(notify.notificationOwed(await task())).toBe(true);
    await notify.notifyCodeResult(taskId);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const row = await task();
    expect(row.execution).toMatchObject({
      notification: {
        key: notify.notificationKey(row),
        outcome: "skipped",
        reason: "source session unavailable",
      },
    });
  });

  it("a deleted bot is skipped once as bot_deleted and never reselected", async () => {
    await seedTask({ status: "ready" });
    await client.exec(`DELETE FROM bots WHERE id = '${alphaId}'`);
    await runtime.recoverCodeTasks();
    const { version } = await task();
    await runtime.recoverCodeTasks();
    await runtime.recoverCodeTasks();
    expect(h.sendMessage).not.toHaveBeenCalled();
    const row = await task();
    expect(row.version).toBe(version);
    expect(row.execution).toMatchObject({
      notification: { outcome: "skipped", reason: "bot_deleted" },
    });
    expect(
      (await events()).filter((type) => type === "notification.skipped")
    ).toHaveLength(1);
  });

  it("does not resend history notified by the legacy marker", async () => {
    await seedTask({
      execution: { notificationInstructionVersion: 1 },
      status: "ready",
    });
    await runtime.recoverCodeTasks();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });
});

describe("N-03 command machine and H-25 orphaned tasks", () => {
  it("a stale lease token cannot settle a command re-leased by another worker", async () => {
    await seedTask({ execution: {}, status: "queued" });
    await seedCommand({ status: "queued" });
    const [first] = await store.claimCommands(new Date());
    if (!first) {
      throw new Error("lease expected");
    }
    const [second] = await store.claimCommands(
      new Date(Date.now() + 10 * MINUTE)
    );
    expect(second?.leaseToken).not.toBe(first.leaseToken);
    await expect(
      store.recordCommandSettled(first.command.id, {
        leaseToken: first.leaseToken,
      })
    ).rejects.toThrow("stale");
    await expect(
      store.recordCommandSettled(first.command.id, {
        leaseToken: second?.leaseToken ?? "",
      })
    ).resolves.toMatchObject({ status: "settled" });
    await expect(
      store.recordCommandSettled(first.command.id, "unsettled")
    ).rejects.toThrow();
  });

  it("transitions keep terminal ⇔ finishedAt and release the reservation", async () => {
    await seedTask();
    const done = await store.transitionTask(taskId, {
      from: ["running"],
      to: "needs_attention",
    });
    expect(done?.finishedAt).not.toBeNull();
    expect(done?.execution.executionReserved).toBe(false);
    expect(
      await store.transitionTask(taskId, { from: ["running"], to: "ready" })
    ).toBeNull();
  });

  it("a whole-object execution patch cannot drop runtime-owned fields", async () => {
    await seedTask();
    const stale = await task();
    await store.patchRuntimeExecution(taskId, {
      cancelProbeId: "probe",
      executionGeneration: 3,
    });
    await store.updateTask(taskId, {
      execution: { ...stale.execution, checks: [] },
    });
    expect((await task()).execution).toMatchObject({
      cancelProbeId: "probe",
      checks: [],
      executionGeneration: 3,
    });
  });

  it("a task whose bot was deleted admits no new instructions, only cancellation", async () => {
    await seedTask({ status: "needs_attention" });
    await client.exec(`DELETE FROM bots WHERE id = '${alphaId}'`);
    await expect(
      store.enqueueCommand(taskId, {
        kind: "steer",
        messageId: "after-delete",
        text: "Continue.",
      })
    ).rejects.toThrow("bot was deleted");
    await expect(
      store.enqueueCommand(taskId, { kind: "cancel", messageId: "stop" })
    ).resolves.toMatchObject({ kind: "cancel" });
    const commands = await database
      .select()
      .from(codeTaskCommands)
      .where(
        and(
          eq(codeTaskCommands.taskId, taskId),
          eq(codeTaskCommands.kind, "steer")
        )
      );
    expect(commands).toHaveLength(0);
  });
});

describe("H-25 bot deletion shuts code tasks down first", () => {
  const queuedId = "66666666-6666-4666-8666-666666666666";
  const waitingId = "77777777-7777-4777-8777-777777777777";
  const readyId = "88888888-8888-4888-8888-888888888888";

  async function seedBotTasks() {
    await seedTask();
    await seedTask(
      { durableSessionId: null, execution: {}, status: "queued" },
      queuedId
    );
    await seedTask({ status: "waiting_for_input" }, waitingId);
    await seedTask(
      {
        pullRequestUrl: "https://github.com/acme/other/pull/9",
        status: "ready",
      },
      readyId
    );
  }

  it("blocks new work, requests each cancellation once and reports what is pending", async () => {
    await seedBotTasks();
    expect(await deletion.requestBotCodeTaskShutdown(alphaId)).toEqual({
      pending: 3,
    });
    expect(await deletion.requestBotCodeTaskShutdown(alphaId)).toEqual({
      pending: 3,
    });
    const cancels = await database
      .select()
      .from(codeTaskCommands)
      .where(eq(codeTaskCommands.kind, "cancel"));
    expect(cancels).toHaveLength(3);
    // The published result is preserved, but accepts no new instruction.
    expect(await task(readyId)).toMatchObject({ status: "ready" });
    await expect(
      store.enqueueCommand(readyId, {
        kind: "steer",
        messageId: "steer-while-deleting",
        text: "More.",
      })
    ).rejects.toThrow("being deleted");
    await expect(
      store.createTask({
        ai: { billing: "gateway", fast: false, model: "openai/gpt-test" },
        botId: alphaId,
        goal: "New work",
        id: "99999999-9999-4999-8999-999999999999",
        repository: { baseBranch: "main", fullName: "acme/web", id: repoId },
        repositoryId: repoId,
        sourceCallId: "new-call",
        sourceSessionId: "main-session",
        title: "New",
      })
    ).rejects.toThrow("being deleted");
  });

  it("reaches pending 0 only after each stop is confirmed, then keeps history with bot_id NULL", async () => {
    await seedBotTasks();
    await deletion.requestBotCodeTaskShutdown(alphaId);
    h.probes.push("probe-running");
    h.lines.set(`wrun_${waitingId.slice(0, 8)}`, []);
    await runtime.dispatchCodeCommands();
    // The session-less task is cancelled at once; the others wait for a stop.
    expect((await task(queuedId)).status).toBe("cancelled");
    expect(await deletion.requestBotCodeTaskShutdown(alphaId)).toEqual({
      pending: 2,
    });
    streamLines([{ cursor: 1, requestId: "probe-running", type: "idle" }]);
    await runtime.projectTask(taskId);
    expect((await task()).status).toBe("cancelled");
    const waitingProbe = (await task(waitingId)).execution.cancelProbeId;
    h.lines.set(`wrun_${waitingId.slice(0, 8)}`, [
      { cursor: 1, requestId: waitingProbe, type: "idle" },
    ]);
    await runtime.projectTask(waitingId);
    expect(await deletion.requestBotCodeTaskShutdown(alphaId)).toEqual({
      pending: 0,
    });

    await client.exec(`DELETE FROM bots WHERE id = '${alphaId}'`);
    const rows = await database.select().from(codeTasks);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.botId === null)).toBe(true);
    expect(await database.select().from(codeTaskBotShutdowns)).toHaveLength(0);
    // Without the marker row, bot_id NULL alone still blocks new instructions.
    await expect(
      store.enqueueCommand(readyId, {
        kind: "steer",
        messageId: "steer-after-delete",
        text: "More.",
      })
    ).rejects.toThrow("bot was deleted");
    expect(await events(readyId)).not.toContain("command.applied");
  });

  it("a task holding a publication lease stays pending instead of failing the deletion", async () => {
    await seedTask({
      leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      leaseUntil: new Date(Date.now() + MINUTE),
    });
    expect(await deletion.requestBotCodeTaskShutdown(alphaId)).toEqual({
      pending: 1,
    });
    expect((await task()).status).toBe("running");
  });
});

describe("0027 migration", () => {
  it("backfills terminal/active finish times and enforces the invariant", {
    timeout: 30_000,
  }, async () => {
    const fresh = new PGlite();
    await fresh.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE TABLE bots (id uuid PRIMARY KEY);
      CREATE TABLE mcp_connections (id uuid PRIMARY KEY);
    `);
    await fresh.exec(
      readFileSync(
        fileURLToPath(
          new URL("./drizzle/0021_code_tasks.sql", import.meta.url)
        ),
        "utf8"
      )
    );
    const insert = (id: string, status: string, finished: string) =>
      fresh.exec(`INSERT INTO code_tasks (id, source_session_id, source_call_id, title, goal,
        repository_snapshot_id, repository_full_name, base_branch, billing, model, status, finished_at)
        VALUES ('${id}', 's', '${id}', 't', 'g', 'r', 'acme/web', 'main', 'gateway', 'm', '${status}', ${finished})`);
    await insert(taskId, "ready", "NULL");
    await insert(otherTaskId, "running", "now()");
    const migration = readFileSync(
      fileURLToPath(
        new URL("./drizzle/0027_code_task_state.sql", import.meta.url)
      ),
      "utf8"
    );
    await fresh.exec(migration);
    await fresh.exec(migration);
    const rows = await fresh.query<{ status: string; finished: boolean }>(
      "SELECT status, finished_at IS NOT NULL AS finished FROM code_tasks ORDER BY status"
    );
    expect(rows.rows).toEqual([
      { finished: true, status: "ready" },
      { finished: false, status: "running" },
    ]);
    await expect(
      fresh.exec(
        `UPDATE code_tasks SET status = 'cancelled' WHERE id = '${otherTaskId}'`
      )
    ).rejects.toThrow("code_tasks_finished_at_check");
    await expect(
      fresh.exec(
        `UPDATE code_tasks SET status = 'running' WHERE id = '${taskId}'`
      )
    ).rejects.toThrow("code_tasks_finished_at_check");
    const rls = await fresh.query<{ relrowsecurity: boolean }>(
      "SELECT relrowsecurity FROM pg_class WHERE relname = 'code_task_bot_shutdowns'"
    );
    expect(rls.rows[0]?.relrowsecurity).toBe(true);
    await fresh.close();
  });
});
