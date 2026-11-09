// biome-ignore-all lint/performance/noAwaitInLoops: Guard workloads intentionally pace or consume streams sequentially.
// biome-ignore-all lint/performance/useTopLevelRegex: The benchmark uses a bounded SQLSTATE parser.
// biome-ignore-all lint/style/noNestedTernary: Scenario fixture selection is fixed and documented in the plan.
// biome-ignore-all lint/style/useConsistentTypeDefinitions: Fixture protocol types stay local to this worker.
// biome-ignore-all lint/style/useDestructuring: Metadata extraction is intentionally explicit.

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

const variantRoot = process.env.STREAM_AB_VARIANT_ROOT;
const scenario = process.env.STREAM_AB_SCENARIO;
const warmup = process.env.STREAM_AB_WARMUP === "1";
const databaseUrl = process.env.DATABASE_URL;
if (!(variantRoot && scenario && databaseUrl)) {
  throw new Error(
    "STREAM_AB_VARIANT_ROOT, STREAM_AB_SCENARIO and DATABASE_URL are required"
  );
}
const benchmarkVariantRoot = variantRoot;
const benchmarkScenario = scenario;
const benchmarkDatabaseUrl = databaseUrl;

const botId = "11111111-1111-4111-8111-111111111111";
const sessionId = "stream-ab-session";
const SQLSTATE = /^[0-9A-Z]{5}$/u;
const source = (file: string) =>
  import(pathToFileURL(`${benchmarkVariantRoot}/apps/hub/${file}`).href);

type RelayModule = typeof import("../../lib/chat/sse");
type StoreModule = typeof import("../../lib/chat/store");
interface Fact {
  data: Record<string, unknown>;
  type: string;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error as { code?: unknown };
    if (typeof code === "string" && SQLSTATE.test(code)) {
      return code;
    }
  }
  return error instanceof Error ? error.name : "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function factFor(scenarioName: string, line: number, index: number): Fact {
  if (scenarioName === "peer") {
    if (line <= 20) {
      return {
        data: {
          name: line % 2 === 0 ? "peer-2" : "peer-1",
          owner: { callId: `peer-${line}` },
          sessionId: `child-${line}`,
        },
        type: "child.opened",
      };
    }
    return {
      data: { callId: `peer-${line - 20}` },
      type: "call.settled",
    };
  }
  if (scenarioName === "large") {
    return {
      data: {
        kind: "text",
        phase: "reply",
        value: "x".repeat(4 * 1024 * 1024 + 1024),
      },
      type: "content.completed",
    };
  }
  return {
    data: { value: `${scenarioName}-${line}-${index}` },
    type: index === 0 ? "content.completed" : "call.settled",
  };
}

async function* records(name: string): AsyncGenerator<{
  line: number;
  record: { facts: Fact[] };
}> {
  let count = 1;
  if (name === "burst") {
    count = 200;
  } else if (name === "paced") {
    count = 50;
  } else if (name === "peer") {
    count = 40;
  }
  const factsPerRecord = name === "burst" ? 2 : 1;
  for (let line = 1; line <= count; line += 1) {
    if (name === "paced") {
      await sleep(10);
    }
    yield {
      line,
      record: {
        facts: Array.from({ length: factsPerRecord }, (_, index) =>
          factFor(name, line, index)
        ),
      },
    };
  }
}

async function clearWarmup(sql: postgres.Sql): Promise<void> {
  await sql`TRUNCATE events, cursors, consultations`;
}

async function main() {
  const [{ relay }, { saver }] = (await Promise.all([
    source("lib/chat/sse.ts"),
    source("lib/chat/store.ts"),
  ])) as [RelayModule, StoreModule];
  const sql = postgres(benchmarkDatabaseUrl, { max: 1, prepare: false });
  const observationLogs: Record<string, unknown>[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg !== "string") {
        continue;
      }
      try {
        const parsed = JSON.parse(arg) as Record<string, unknown>;
        if (parsed.source === "busy.chat") {
          observationLogs.push(parsed);
        }
      } catch {
        // Ignore non-JSON runtime output; it is not part of the benchmark ledger.
      }
    }
  };
  try {
    const bot = {
      billing: "gateway",
      id: botId,
      slug: "stream-ab-bot",
    } as Parameters<typeof saver>[0];
    const trackConsultations = benchmarkScenario === "peer";
    const save = saver(bot, sessionId, trackConsultations, "gateway");
    if (warmup) {
      await relay(
        records("paced"),
        save,
        () => undefined,
        () => false,
        "gateway"
      );
      await clearWarmup(sql);
      observationLogs.length = 0;
    }
    const encoder = new TextEncoder();
    let outputBytes = 0;
    let firstForwardMs: number | null = null;
    const startedAt = performance.now();
    let outputController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        outputController = controller;
      },
    });
    const consumer = (async () => {
      const reader = output.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        outputBytes += value.byteLength;
      }
    })();
    const send = (event: string, data: unknown, id?: number) => {
      firstForwardMs ??= performance.now() - startedAt;
      const payload = `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      outputController?.enqueue(encoder.encode(payload));
    };
    const relayOk = await relay(
      records(benchmarkScenario),
      save,
      send,
      () => false,
      "gateway",
      { botSlug: bot.slug, sessionId }
    );
    outputController?.close();
    await consumer;
    const rows = await sql<
      { line: number; index: number; type: string; data: string }[]
    >`
      SELECT line, index, type, data::text AS data
      FROM events WHERE session_id = ${sessionId}
      ORDER BY line, index
    `;
    const cursorRows = await sql<{ next_line: number }[]>`
      SELECT next_line FROM cursors WHERE session_id = ${sessionId}
    `;
    const eventsHash = createHash("sha256")
      .update(
        rows
          .map((row) => `${row.line}\t${row.index}\t${row.type}\t${row.data}`)
          .join("\n")
      )
      .digest("hex");
    const summary = observationLogs.find(
      (entry) => entry.event === "chat.stream"
    );
    let expectedRows = 50;
    if (benchmarkScenario === "burst") {
      expectedRows = 400;
    } else if (benchmarkScenario === "large") {
      expectedRows = 1;
    } else if (benchmarkScenario === "peer") {
      expectedRows = 40;
    }
    return {
      cursor: cursorRows[0]?.next_line ?? null,
      durableCompletionMs: performance.now() - startedAt,
      errorCode: null,
      eventsHash,
      expectedRows,
      failed: !relayOk,
      firstForwardMs,
      maxQueuedBytes: summary?.maxQueuedBytes ?? null,
      maxQueuedRows: summary?.maxQueuedRows ?? null,
      outputBytes,
      oversizedRecordBytes: summary?.oversizedRecordBytes ?? null,
      oversizedRecordCount: summary?.oversizedRecordCount ?? null,
      pressureWaits: summary?.pressureWaits ?? null,
      recordsSeen: summary?.recordsSeen ?? null,
      rows: rows.length,
      saveCalls: summary?.saveCalls ?? null,
      scenario: benchmarkScenario,
      streamOutcome: summary?.outcome ?? null,
    };
  } catch (error) {
    return {
      cursor: null,
      durableCompletionMs: null,
      errorCode: errorCode(error),
      eventsHash: null,
      expectedRows: null,
      failed: true,
      firstForwardMs: null,
      maxQueuedBytes: null,
      maxQueuedRows: null,
      outputBytes: 0,
      oversizedRecordBytes: null,
      oversizedRecordCount: null,
      pressureWaits: null,
      recordsSeen: null,
      rows: null,
      saveCalls: null,
      scenario: benchmarkScenario,
      streamOutcome: "failed",
    };
  } finally {
    console.info = originalInfo;
    await sql.end({ timeout: 1 });
  }
}

main().then((result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
});
