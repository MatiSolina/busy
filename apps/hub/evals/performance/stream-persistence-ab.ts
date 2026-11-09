// biome-ignore-all lint/performance/noAwaitInLoops: The benchmark deliberately serializes paired runs.
// biome-ignore-all lint/suspicious/noBitwiseOperators: The seeded PRNG is part of the fixed experiment protocol.
// biome-ignore-all lint/style/noNestedTernary: The plan uses compact fixed scenario selectors.
// biome-ignore-all lint/style/noNonNullAssertion: Valid paired rows are filtered before analysis.
// biome-ignore-all lint/suspicious/useAwait: Process wrappers deliberately return native promises.

import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { cpus, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const candidateRoot = resolve(process.env.STREAM_AB_CANDIDATE_ROOT ?? root);
const configuredControlRoot = process.env.STREAM_AB_CONTROL_ROOT?.trim();
if (!configuredControlRoot) {
  throw new Error(
    "STREAM_AB_CONTROL_ROOT is required: select a local checkout of a distinct public baseline commit."
  );
}
const controlRoot = resolve(configuredControlRoot);
const controlCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: controlRoot,
  encoding: "utf8",
}).trim();
const candidateCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: candidateRoot,
  encoding: "utf8",
}).trim();
if (controlCommit === candidateCommit) {
  throw new Error("Control and candidate must be distinct commits");
}
const worker = resolve(
  candidateRoot,
  "apps/hub/evals/performance/stream-persistence-ab-worker.ts"
);
const outputDirectory = resolve(
  process.env.STREAM_AB_OUTPUT ?? resolve(candidateRoot, ".performance")
);
const outputPath = resolve(
  outputDirectory,
  "stream-persistence-ab-result.json"
);
const planPath = resolve(outputDirectory, "stream-persistence-ab-plan.json");
const pairs = Number(process.env.STREAM_AB_PAIRS ?? 40);
const guardPairs = Number(process.env.STREAM_AB_GUARD_PAIRS ?? 4);
if (!(Number.isInteger(pairs) && pairs >= 2)) {
  throw new Error("STREAM_AB_PAIRS must be an integer >= 2");
}

const botId = "11111111-1111-4111-8111-111111111111";
const peerOneId = "22222222-2222-4222-8222-222222222222";
const peerTwoId = "33333333-3333-4333-8333-333333333333";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No loopback port available");
  }
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done()))
  );
  return address.port;
}

function shuffle<T>(items: T[], seed: number): T[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function median(values: number[]): number {
  const ordered = values.toSorted((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)] ?? Number.NaN;
}

function bootstrapInterval(
  values: number[],
  seed: number
): [number, number] | null {
  if (!values.length) {
    return null;
  }
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  const estimates: number[] = [];
  for (let round = 0; round < 2000; round += 1) {
    const sample = Array.from(
      { length: values.length },
      () => values[Math.floor(next() * values.length)] ?? 0
    );
    estimates.push(median(sample));
  }
  const ordered = estimates.toSorted((a, b) => a - b);
  return [
    ordered[Math.floor(ordered.length * 0.025)] ?? 0,
    ordered[Math.floor(ordered.length * 0.975)] ?? 0,
  ];
}

async function runCommand(
  name: string,
  args: string[],
  env: NodeJS.ProcessEnv
) {
  return exec(name, args, {
    env,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function createFixture(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  await sql.unsafe(`
    CREATE TABLE bots (
      id uuid PRIMARY KEY,
      status text NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE events (
      at timestamptz NOT NULL,
      bot_id uuid NOT NULL,
      data jsonb NOT NULL,
      "index" integer NOT NULL,
      line integer NOT NULL,
      session_id text NOT NULL,
      type text NOT NULL,
      PRIMARY KEY (session_id, line, "index")
    );
    CREATE TABLE cursors (
      bot_id uuid NOT NULL,
      next_line integer NOT NULL DEFAULT 0,
      session_id text PRIMARY KEY
    );
    CREATE TABLE consultations (
      call_id text UNIQUE NOT NULL,
      child_session_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      from_bot_id uuid NOT NULL,
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      parent_session_id text NOT NULL,
      status text NOT NULL DEFAULT 'open',
      to_bot_id uuid
    );
  `);
  await sql.end({ timeout: 1 });
}

async function resetFixture(databaseUrl: string, scenario: string) {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  await sql`TRUNCATE events, cursors, consultations, bots`;
  await sql`
    INSERT INTO bots (id, status, created_at)
    VALUES (${botId}, 'ready', '2026-11-04T18:00:00Z')
  `;
  if (scenario === "peer") {
    await sql`
      INSERT INTO bots (id, status, created_at)
      VALUES (${peerOneId}, 'ready', '2026-11-04T18:01:00Z'),
             (${peerTwoId}, 'ready', '2026-11-04T18:02:00Z')
    `;
  }
  await sql.end({ timeout: 1 });
}

async function databaseStats(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  const [row] = await sql<
    { xact_commit: number; tup_inserted: number; tup_updated: number }[]
  >`
    SELECT xact_commit, tup_inserted, tup_updated
    FROM pg_stat_database WHERE datname = 'busy_eval'
  `;
  await sql.end({ timeout: 1 });
  return row ?? { tup_inserted: 0, tup_updated: 0, xact_commit: 0 };
}

async function invokeWorker(
  databaseUrl: string,
  scenario: string,
  sourceRoot: string,
  env: NodeJS.ProcessEnv,
  warmup: boolean
) {
  let output = "";
  let failedProcess = false;
  try {
    const result = await runCommand(
      "pnpm",
      ["-C", resolve(candidateRoot, "apps/hub"), "exec", "tsx", worker],
      {
        ...env,
        DATABASE_URL: databaseUrl,
        STREAM_AB_SCENARIO: scenario,
        STREAM_AB_VARIANT_ROOT: sourceRoot,
        STREAM_AB_WARMUP: warmup ? "1" : "0",
      }
    );
    output = result.stdout;
  } catch (error) {
    failedProcess = true;
    output =
      error && typeof error === "object" && "stdout" in error
        ? String((error as { stdout?: unknown }).stdout ?? "")
        : "";
  }
  const parsedLine = output.trim().split("\n").at(-1) ?? "";
  let result: Record<string, unknown> = {};
  try {
    result = JSON.parse(parsedLine) as Record<string, unknown>;
  } catch {
    result = { errorCode: "worker_output_invalid" };
  }
  return { failedProcess, result };
}

async function runVariant(
  databaseUrl: string,
  variant: "control" | "candidate",
  scenario: string,
  pair: number,
  sourceRoot: string,
  env: NodeJS.ProcessEnv
) {
  await resetFixture(databaseUrl, scenario);
  const before = await databaseStats(databaseUrl);
  const invocation = await invokeWorker(
    databaseUrl,
    scenario,
    sourceRoot,
    env,
    true
  );
  const after = await databaseStats(databaseUrl);
  return {
    ...invocation.result,
    dbTransactions: Number(after.xact_commit) - Number(before.xact_commit),
    dbTuplesInserted: Number(after.tup_inserted) - Number(before.tup_inserted),
    dbTuplesUpdated: Number(after.tup_updated) - Number(before.tup_updated),
    failedProcess: invocation.failedProcess,
    ledgerStatus:
      invocation.failedProcess || invocation.result.failed
        ? "failed"
        : "observed",
    pair,
    variant,
  };
}

function sourceIdentity(sourceRoot: string) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();
  const files = ["apps/hub/lib/chat/sse.ts", "apps/hub/lib/chat/store.ts"];
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(readFileSync(resolve(sourceRoot, file)));
  }
  return { commit, files, hash: hash.digest("hex") };
}

function analyze(ledger: Record<string, unknown>[], scenario: string) {
  const rows = ledger.filter((row) => row.scenario === scenario);
  const byPair = new Map<number, Record<string, unknown>[]>();
  for (const row of rows) {
    const pair = Number(row.pair);
    byPair.set(pair, [...(byPair.get(pair) ?? []), row]);
  }
  const paired = [...byPair.values()].filter(
    (pair) =>
      pair.some((row) => row.variant === "control") &&
      pair.some((row) => row.variant === "candidate")
  );
  const valid = paired.filter((pair) => {
    const control = pair.find((row) => row.variant === "control");
    const candidate = pair.find((row) => row.variant === "candidate");
    return Boolean(
      control &&
        candidate &&
        !control.failedProcess &&
        !candidate.failedProcess &&
        !control.failed &&
        !candidate.failed &&
        control.rows === candidate.rows &&
        control.cursor === candidate.cursor &&
        control.eventsHash === candidate.eventsHash
    );
  });
  const savings = valid.map((pair) => {
    const control = pair.find((row) => row.variant === "control")!;
    const candidate = pair.find((row) => row.variant === "candidate")!;
    return (
      Number(control.durableCompletionMs) -
      Number(candidate.durableCompletionMs)
    );
  });
  const relativeSavings = valid.map((pair) => {
    const control = pair.find((row) => row.variant === "control")!;
    const candidate = pair.find((row) => row.variant === "candidate")!;
    return (
      (Number(control.durableCompletionMs) -
        Number(candidate.durableCompletionMs)) /
      Number(control.durableCompletionMs)
    );
  });
  const firstForwardViolations = valid.filter((pair) => {
    const control = pair.find((row) => row.variant === "control")!;
    const candidate = pair.find((row) => row.variant === "candidate")!;
    const delta = Math.abs(
      Number(candidate.firstForwardMs) - Number(control.firstForwardMs)
    );
    const ratio =
      Number(candidate.firstForwardMs) /
      Math.max(Number(control.firstForwardMs), 0.001);
    return ratio > 1.1 && delta > 5;
  }).length;
  const parityGate = valid.length === paired.length;
  const firstForwardGate = firstForwardViolations === 0;
  const performanceGate =
    scenario === "burst"
      ? parityGate &&
        (bootstrapInterval(savings, 1104)?.[0] ?? Number.NEGATIVE_INFINITY) >=
          5 &&
        (bootstrapInterval(relativeSavings, 1105)?.[0] ??
          Number.NEGATIVE_INFINITY) >= 0.1 &&
        firstForwardGate
      : null;
  return {
    bootstrap95RelativeSavings: bootstrapInterval(relativeSavings, 1105),
    bootstrap95SavingsMs: bootstrapInterval(savings, 1104),
    failedAttempts: rows.filter((row) => row.ledgerStatus === "failed").length,
    failedPairs: paired.length - valid.length,
    firstForwardGate,
    firstForwardViolations,
    medianCandidateMs: median(
      valid.map((pair) =>
        Number(
          pair.find((row) => row.variant === "candidate")?.durableCompletionMs
        )
      )
    ),
    medianControlMs: median(
      valid.map((pair) =>
        Number(
          pair.find((row) => row.variant === "control")?.durableCompletionMs
        )
      )
    ),
    medianRelativeSavings: median(relativeSavings),
    medianSavingsMs: median(savings),
    neutralPairs: paired.length - valid.length,
    pairs: paired.length,
    parityGate,
    performanceGate,
    validPairs: valid.length,
  };
}

async function reconnectReplay(
  databaseUrl: string,
  sourceRoot: string,
  env: NodeJS.ProcessEnv
) {
  await resetFixture(databaseUrl, "burst");
  const first = await invokeWorker(databaseUrl, "burst", sourceRoot, env, true);
  const second = await invokeWorker(
    databaseUrl,
    "burst",
    sourceRoot,
    env,
    false
  );
  const firstResult = first.result;
  const secondResult = second.result;
  return {
    first: firstResult,
    firstFailedProcess: first.failedProcess,
    replayDeduplicated:
      !(first.failedProcess || second.failedProcess) &&
      firstResult.eventsHash === secondResult.eventsHash &&
      firstResult.rows === secondResult.rows &&
      firstResult.cursor === secondResult.cursor,
    second: secondResult,
    secondFailedProcess: second.failedProcess,
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The orchestrator is a fixed, auditable benchmark protocol.
async function main() {
  if (
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: controlRoot,
      encoding: "utf8",
    }).trim() !== controlCommit
  ) {
    throw new Error(
      "Control worktree changed after the baseline commit was selected"
    );
  }
  const plan = {
    candidate: sourceIdentity(candidateRoot),
    candidateCommit,
    content:
      "synthetic metadata-only fixtures; no provider, model, network or production calls",
    control: sourceIdentity(controlRoot),
    createdAt: new Date().toISOString(),
    database:
      "isolated local PostgreSQL SCRAM; same DB reset/settings per variant",
    firstForwardGuard: { maxAbsoluteNoiseMs: 5, maxRelativeRegression: 0.1 },
    guardPairs,
    order:
      "seeded balanced AB/BA; 20 control-first and 20 candidate-first when pairs=40",
    practicalGate: { minAbsoluteSavingMs: 5, minRelativeSaving: 0.1 },
    primaryMetric: "durableCompletionMs",
    primaryPairs: pairs,
    queueBudget: {
      maxBytes: 4 * 1024 * 1024,
      maxRows: 4096,
      oversizedAtomicRecord:
        "A single record may exceed the byte budget; it is admitted alone and awaited, never dropped or split.",
    },
    runtime: {
      cpu: cpus()[0]?.model,
      node: process.version,
      platform: process.platform,
    },
    scenarios: {
      burst: { factsPerRecord: 2, intervalMs: 0, records: 200 },
      large: {
        factsPerRecord: 1,
        payloadBytes: 4 * 1024 * 1024 + 1024,
        records: 1,
      },
      paced: { factsPerRecord: 1, intervalMs: 10, records: 50 },
      peer: { factsPerRecord: 1, intervalMs: 0, records: 40 },
    },
    schemaVersion: 1,
    stoppingRule:
      "No unplanned stopping; failed/neutral samples remain in ledger.",
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  const temporary = await mkdtemp(resolve(tmpdir(), "busy-stream-ab-"));
  const dataDirectory = resolve(temporary, "data");
  const passwordFile = resolve(temporary, "password");
  const password = randomUUID();
  const port = await freePort();
  const databaseUrl = `postgresql://busy_eval:${password}@127.0.0.1:${port}/busy_eval`;
  const commonEnv = { ...process.env };
  let started = false;
  const ledger: Record<string, unknown>[] = [];
  try {
    await writeFile(passwordFile, password, { mode: 0o600 });
    await runCommand(
      "initdb",
      [
        "-D",
        dataDirectory,
        "--auth=scram-sha-256",
        `--pwfile=${passwordFile}`,
        "--username=busy_eval",
      ],
      commonEnv
    );
    await rm(passwordFile, { force: true });
    await runCommand(
      "pg_ctl",
      [
        "-D",
        dataDirectory,
        "-l",
        resolve(temporary, "postgres.log"),
        "-o",
        `-h 127.0.0.1 -p ${port}`,
        "start",
      ],
      commonEnv
    );
    started = true;
    await runCommand(
      "createdb",
      ["-h", "127.0.0.1", "-p", String(port), "-U", "busy_eval", "busy_eval"],
      { ...commonEnv, PGPASSWORD: password }
    );
    await createFixture(databaseUrl);
    const orders = shuffle(
      [
        ...Array.from(
          { length: Math.ceil(pairs / 2) },
          () => ["control", "candidate"] as const
        ),
        ...Array.from(
          { length: Math.floor(pairs / 2) },
          () => ["candidate", "control"] as const
        ),
      ],
      1104
    );
    for (let pair = 0; pair < pairs; pair += 1) {
      for (const variant of orders[pair] ?? []) {
        const row = await runVariant(
          databaseUrl,
          variant,
          "burst",
          pair,
          variant === "control" ? controlRoot : candidateRoot,
          commonEnv
        );
        ledger.push({ ...row, scenario: "burst" });
        await writeFile(
          outputPath,
          `${JSON.stringify({ ledger, plan }, null, 2)}\n`
        );
      }
    }
    for (const scenario of ["paced", "peer", "large"]) {
      const guardOrders = shuffle(
        [
          ...Array.from(
            { length: Math.ceil(guardPairs / 2) },
            () => ["control", "candidate"] as const
          ),
          ...Array.from(
            { length: Math.floor(guardPairs / 2) },
            () => ["candidate", "control"] as const
          ),
        ],
        1104 + scenario.length
      );
      for (let pair = 0; pair < guardPairs; pair += 1) {
        for (const variant of guardOrders[pair] ?? []) {
          const row = await runVariant(
            databaseUrl,
            variant,
            scenario,
            pair,
            variant === "control" ? controlRoot : candidateRoot,
            commonEnv
          );
          ledger.push({ ...row, scenario });
          await writeFile(
            outputPath,
            `${JSON.stringify({ ledger, plan }, null, 2)}\n`
          );
        }
      }
    }
    const reconnect = await reconnectReplay(
      databaseUrl,
      candidateRoot,
      commonEnv
    );
    const result = {
      analysis: Object.fromEntries(
        ["burst", "paced", "peer", "large"].map((scenario) => [
          scenario,
          analyze(ledger, scenario),
        ])
      ),
      completedAt: new Date().toISOString(),
      ledger,
      plan,
      reconnectReplay: reconnect,
    };
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result.analysis, null, 2));
  } finally {
    if (started) {
      await runCommand(
        "pg_ctl",
        ["-D", dataDirectory, "-m", "fast", "stop"],
        commonEnv
      ).catch(() => undefined);
    }
    await rm(temporary, { force: true, recursive: true });
  }
}

main();
