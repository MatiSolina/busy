// biome-ignore-all lint/performance/noAwaitInLoops: Fixture writes are deliberately bounded and sequential; seeding is outside the timed evaluation.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { bots, codeTasks, events, messages } from "../../lib/db/schema";
import {
  fixtureTaskId,
  fixtureTaskTitle,
  getWorkload,
  turnFacts,
  turnsForSession,
} from "./workload";

// This fixture must never be pointed at a shared or production database.
const url = URL.parse(process.env.DATABASE_URL ?? "");
if (
  !(url && ["localhost", "127.0.0.1"].includes(url.hostname)) ||
  url.pathname !== "/busy_eval"
) {
  throw new Error(
    "Performance fixtures require a loopback /busy_eval database"
  );
}
const client = postgres(url.toString(), { prepare: false });
const database = drizzle(client);
const workload = getWorkload(process.env.PERF_WORKLOAD);
const INSERT_BATCH_SIZE = 1000;
const insertBatches = async <T>(
  rows: T[],
  insert: (batch: T[]) => Promise<unknown>
) => {
  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    await insert(rows.slice(offset, offset + INSERT_BATCH_SIZE));
  }
};
try {
  for (let botIndex = 0; botIndex < workload.bots; botIndex += 1) {
    const slug = `perf-bot-${botIndex}`;
    const [bot] = await database
      .insert(bots)
      .values({
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, botIndex)),
        description: "Synthetic performance evaluation bot",
        name: `Performance Bot ${botIndex}`,
        sessionId: `${slug}-session-${workload.sessionsPerBot - 1}`,
        slug,
        status: "ready",
      })
      .onConflictDoNothing()
      .returning();
    if (!bot) {
      continue;
    }
    if (botIndex === 0) {
      await database.insert(codeTasks).values({
        baseBranch: "main",
        billing: "gateway",
        botId: bot.id,
        finishedAt: new Date(Date.UTC(2026, 0, 5)),
        goal: "Read the deterministic synthetic result without executing work.",
        id: fixtureTaskId,
        model: "model/fixture",
        repositoryFullName: "fixture/project",
        repositorySnapshotId: "fixture-snapshot",
        sourceCallId: "fixture-task-call",
        sourceSessionId: bot.sessionId ?? "fixture-session",
        status: "ready",
        summary: "The synthetic result is ready for review.",
        title: fixtureTaskTitle,
      });
    }
    for (let session = 0; session < workload.sessionsPerBot; session += 1) {
      const sessionId = `${slug}-session-${session}`;
      const turns = turnsForSession(workload, session);
      const rows: (typeof events.$inferInsert)[] = [];
      const deliveries: (typeof messages.$inferInsert)[] = [];
      for (let turn = 0; turn < turns; turn += 1) {
        const deliveryId = `${sessionId}-delivery-${turn}`;
        const text = `Review project ${turn} and explain the next steps.`;
        deliveries.push({
          botId: bot.id,
          deliveryId,
          id: randomUUID(),
          status: "accepted",
          text,
        });
        const facts = turnFacts(workload, botIndex, session, turn);
        for (const [index, fact] of facts.entries()) {
          rows.push({
            at: new Date(Date.UTC(2026, 0, session + 1, 0, turn, index)),
            botId: bot.id,
            data: fact,
            index: 0,
            line: turn * workload.factsPerTurn + index,
            sessionId,
            type: fact.type,
          });
        }
      }
      await insertBatches(deliveries, (batch) =>
        database.insert(messages).values(batch)
      );
      await insertBatches(rows, (batch) =>
        database.insert(events).values(batch)
      );
    }
  }
  if (process.env.PERF_SEED_VALIDATE === "1") {
    const [[{ eventCount }], [{ messageCount }]] = await Promise.all([
      database.select({ eventCount: sql<number>`count(*)::int` }).from(events),
      database
        .select({ messageCount: sql<number>`count(*)::int` })
        .from(messages),
    ]);
    const expectedMessages = Array.from({ length: workload.bots }, () =>
      Array.from({ length: workload.sessionsPerBot }, (_, session) =>
        turnsForSession(workload, session)
      ).reduce((total, turns) => total + turns, 0)
    ).reduce((total, messagesForBot) => total + messagesForBot, 0);
    const expectedEvents = expectedMessages * workload.factsPerTurn;
    if (
      Number(messageCount) !== expectedMessages ||
      Number(eventCount) !== expectedEvents
    ) {
      throw new Error(
        `Fixture count mismatch: messages=${messageCount}/${expectedMessages}, events=${eventCount}/${expectedEvents}`
      );
    }
    console.log(
      JSON.stringify({
        events: Number(eventCount),
        messages: Number(messageCount),
        sessions: workload.bots * workload.sessionsPerBot,
        workload: workload.name,
      })
    );
  }
} finally {
  await client.end();
}
