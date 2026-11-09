import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
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
import type { TaskPlan } from "../../templates/bot/agent/lib/task-plan";
import { events, sessionRecoveries } from "./lib/db/schema";

const fixture = vi.hoisted(() => ({ database: null as unknown }));
vi.mock("@/lib/db", () => ({
  db: () => fixture.database,
  events,
  sessionRecoveries,
}));
const { readRootPlanSnapshot } = await import("./lib/chat/recovery-plan-store");

const BOT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BOT_ID = "44444444-4444-4444-8444-444444444444";
const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";
const plan: TaskPlan = {
  dispatchCount: 1,
  id: "saved-plan",
  revision: 2,
  steps: [
    {
      assignee: "agent",
      dependsOn: [],
      execution: {
        id: "execution",
        kind: "agent",
        owner: { sessionId: "original" },
        planRevision: 2,
        status: "running",
        taskId: "durable-task",
      },
      expectedResult: "Verified work",
      id: "work",
      status: "in_progress",
      taskId: "durable-task",
      title: "Work",
    },
  ],
  title: "Saved work",
};
let client: PGlite;
let database: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE bots (id uuid PRIMARY KEY);
    CREATE TABLE events (
      bot_id uuid NOT NULL, session_id text NOT NULL, line integer NOT NULL,
      index integer NOT NULL, at timestamptz NOT NULL, type text NOT NULL,
      data jsonb NOT NULL, PRIMARY KEY (session_id, line, index)
    );
    INSERT INTO bots VALUES ('${BOT_ID}'), ('${OTHER_BOT_ID}');
  `);
  await client.exec(
    readFileSync(
      new URL("./drizzle/0025_session_recovery.sql", import.meta.url),
      "utf8"
    )
  );
  database = drizzle(client);
  fixture.database = database;
});

beforeEach(async () => {
  await client.exec("TRUNCATE session_recoveries, events;");
});
afterAll(async () => {
  await client.close();
});

async function inherited(state: "completed" | "failed" = "completed") {
  await database.insert(sessionRecoveries).values({
    botId: BOT_ID,
    messageId: MESSAGE_ID,
    operationId: "first-recovery",
    packet: { version: 1 },
    planSnapshot: { ...plan },
    reservedSessionId: "middle",
    sourceSessionId: "original",
    state,
  });
}

describe("consecutive root plan recoveries", () => {
  it.each(["completed", "failed"] as const)(
    "preserves an inherited plan without later plan-tool events (%s)",
    async (state) => {
      await inherited(state);
      const first = await readRootPlanSnapshot(BOT_ID, "middle", []);
      expect(first).toMatchObject({
        dispatchCount: 1,
        id: "saved-plan",
        revision: 3,
        steps: [
          {
            execution: { status: "blocked" },
            status: "blocked",
            taskId: "durable-task",
          },
        ],
      });
      if (!first) {
        throw new Error("The inherited plan is missing.");
      }
      await database.insert(sessionRecoveries).values({
        botId: BOT_ID,
        messageId: MESSAGE_ID,
        operationId: "second-recovery",
        packet: { version: 1 },
        planSnapshot: { ...first },
        reservedSessionId: "last",
        sourceSessionId: "middle",
        state: "completed",
      });
      await expect(readRootPlanSnapshot(BOT_ID, "last", [])).resolves.toEqual(
        first
      );
      await expect(
        readRootPlanSnapshot(OTHER_BOT_ID, "middle", [])
      ).resolves.toBeNull();
    }
  );

  it("reduces later root cancellation events over the inherited baseline", async () => {
    await inherited();
    const baseline = await readRootPlanSnapshot(BOT_ID, "middle", []);
    if (!baseline) {
      throw new Error("The inherited plan is missing.");
    }
    const cancelled = {
      ...baseline,
      revision: baseline.revision + 1,
      steps: baseline.steps.map((step) => ({
        ...step,
        note: "Cancelled by the user.",
        status: "cancelled",
      })),
    };
    await database.insert(events).values([
      {
        at: new Date(),
        botId: BOT_ID,
        data: {
          data: {
            callId: "cancel",
            capability: { name: "manage_plan" },
            input: {
              action: "cancel",
              id: baseline.id,
              revision: baseline.revision,
            },
          },
          scope: {},
        },
        index: 0,
        line: 1,
        sessionId: "middle",
        type: "call.requested",
      },
      {
        at: new Date(),
        botId: BOT_ID,
        data: {
          data: {
            callId: "cancel",
            outcome: "completed",
            output: { plan: cancelled },
          },
          scope: {},
        },
        index: 0,
        line: 2,
        sessionId: "middle",
        type: "call.settled",
      },
    ]);
    await expect(readRootPlanSnapshot(BOT_ID, "middle", [])).resolves.toEqual(
      cancelled
    );
  });

  it("does not silently discard a corrupted inherited snapshot", async () => {
    await inherited();
    await database
      .update(sessionRecoveries)
      .set({ planSnapshot: { id: "corrupt", steps: [] } });
    await expect(readRootPlanSnapshot(BOT_ID, "middle", [])).rejects.toThrow(
      "The inherited recovery plan could not be validated."
    );
  });
});
