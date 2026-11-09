import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { cpus } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";
import {
  hashEvaluatorFiles,
  hashFixtureFiles,
  hashOrderedFiles,
  REPORT_SCHEMA_VERSION,
} from "./evaluator-identity";
import { stopProcessGroup } from "./paired-process";
import {
  createPairedPlan,
  guardrailMetricsForPlan,
  type HistoryExperiment,
  type PairedBlockValues,
  type PairedPlan,
  PERFORMANCE_METRICS,
  type PerformanceMetric,
  requiredMetricsForWorkload,
  summarizeBlockGuardrails,
  summarizeGuardrails,
  summarizePairedMetric,
  validateMetricCardinality,
} from "./paired-stats";
import { getWorkload } from "./workload";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const outputRoot = resolve(root, ".performance");
const schemaFiles = ["apps/hub/lib/db/schema.ts", "apps/hub/drizzle"];

interface SourceIdentity {
  clean: boolean;
  evaluatorHash: string;
  fixtureHash: string;
  lockfileHash: string;
  nextConfigHash: string;
  packageHash: string;
  patchHash: string;
  path: string;
  ref: string;
  schemaHash: string;
}

interface VariantResult {
  failureCode?: "evaluator_exit" | "invalid_report" | "identity_mismatch";
  identity: ReportIdentity | null;
  metricSamples: Partial<Record<PerformanceMetric, number[]>>;
  reportPath: string;
  status: "failed" | "passed";
}

interface ReportIdentity {
  environment?: {
    arch?: string;
    browser?: string;
    cpu?: string;
    node?: string;
    platform?: string;
  };
  evaluatorHash?: string;
  fixture?: unknown;
  fixtureHash?: string;
  historyExperiment?: string;
  runtime?: string;
  samples?: number;
  schemaVersion?: number;
  sourcePatchHash?: string;
  sourceRef?: string;
}

interface BlockResult {
  control: VariantResult;
  id: string;
  order: PairedPlan["blocks"][number]["order"];
  treatment: VariantResult;
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

async function command(
  name: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  maxBuffer = 32 * 1024 * 1024
): Promise<string> {
  const result = await exec(name, args, {
    cwd,
    env,
    maxBuffer,
  });
  return result.stdout;
}

async function gitValue(source: string, args: string[]): Promise<string> {
  return (await command("git", args, source, process.env)).trim();
}

async function hashFiles(source: string, paths: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of paths) {
    const absolute = resolve(source, path);
    // biome-ignore lint/performance/noAwaitInLoops: File hashing stays ordered for a stable identity.
    const info = await stat(absolute);
    if (info.isDirectory()) {
      const files = (await readdir(absolute, { recursive: true }))
        .filter((entry) => typeof entry === "string")
        .sort();
      for (const child of files) {
        const childPath = resolve(absolute, child);
        // biome-ignore lint/performance/noAwaitInLoops: File hashing stays ordered for a stable identity.
        if ((await stat(childPath)).isFile()) {
          hash.update(path);
          hash.update(child);
          hash.update(await readFile(childPath));
        }
      }
    } else {
      hash.update(path);
      hash.update(await readFile(absolute));
    }
  }
  return hash.digest("hex");
}

async function sourcePatchHash(source: string): Promise<string> {
  const diff = await command(
    "git",
    [
      "diff",
      "--binary",
      "HEAD",
      "--",
      ":/apps/hub",
      ":/apps/desktop",
      ":/templates",
      ":/images",
      ":/package.json",
      ":/pnpm-lock.yaml",
      ":/pnpm-workspace.yaml",
      ":/turbo.json",
      ":/patches",
      ":/.npmrc",
    ],
    source,
    process.env
  );
  return createHash("sha256").update(diff).digest("hex");
}

async function identifySource(source: string): Promise<SourceIdentity> {
  await access(source);
  const status = await gitValue(source, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  const identity = {
    clean: status.length === 0,
    evaluatorHash: await hashEvaluatorFiles(source),
    fixtureHash: await hashFixtureFiles(source),
    lockfileHash: await hashFiles(source, ["pnpm-lock.yaml"]),
    nextConfigHash: await hashFiles(source, ["apps/hub/next.config.ts"]),
    packageHash: await hashFiles(source, [
      "package.json",
      "apps/hub/package.json",
    ]),
    patchHash: await sourcePatchHash(source),
    path: source,
    ref: await gitValue(source, ["rev-parse", "HEAD"]),
    schemaHash: await hashFiles(source, schemaFiles),
  };
  if (!identity.clean) {
    throw new Error(`Source checkout must be clean: ${source}`);
  }
  return identity;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No loopback port was allocated");
  }
  const { port } = address;
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise()))
  );
  return port;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds)
  );
}

async function runChild(
  name: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  logPath: string
): Promise<number> {
  const child = spawn(name, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const append = (target: Buffer[], chunk: Buffer) => {
    const current = target.reduce((total, value) => total + value.length, 0);
    if (current < 2 * 1024 * 1024) {
      target.push(chunk.subarray(0, 2 * 1024 * 1024 - current));
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk));
  const code = await new Promise<number>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      resolvePromise(exitCode ?? (signal ? 128 : 1));
    });
  });
  await writeFile(
    logPath,
    [
      "[stdout]",
      Buffer.concat(stdout).toString("utf8"),
      "[stderr]",
      Buffer.concat(stderr).toString("utf8"),
    ].join("\n")
  );
  return code;
}

interface RunningServer {
  child: ChildProcess;
  url: string;
}

async function startServer(
  source: SourceIdentity,
  port: number,
  env: NodeJS.ProcessEnv,
  logPath: string
): Promise<RunningServer> {
  const child = spawn(
    "pnpm",
    [
      "exec",
      "next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: resolve(source.path, "apps/hub"),
      detached: true,
      env: { ...env, HUB_URL: `http://127.0.0.1:${port}` },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      break;
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Poll one local server until it is reachable.
      if ((await fetch(`${url}/login`)).ok) {
        await writeFile(
          logPath,
          [
            "[stdout]",
            Buffer.concat(stdout).toString("utf8"),
            "[stderr]",
            Buffer.concat(stderr).toString("utf8"),
          ].join("\n")
        );
        return { child, url };
      }
    } catch {
      // The production server is still booting.
    }
    await sleep(100);
  }
  await writeFile(
    logPath,
    [
      "[stdout]",
      Buffer.concat(stdout).toString("utf8"),
      "[stderr]",
      Buffer.concat(stderr).toString("utf8"),
    ].join("\n")
  );
  await stopProcessGroup(child, 500);
  throw new Error(`Server did not become ready: ${source.path}`);
}

async function stopServer(server: RunningServer | undefined): Promise<void> {
  if (!server?.child.pid) {
    return;
  }
  await stopProcessGroup(server.child);
}

async function parseVariantReport(
  reportPath: string,
  metricName: PerformanceMetric,
  expectedSamples: number,
  metricsToRequire: PerformanceMetric[],
  workloadName: "history-long" | "scale" | "mixed"
): Promise<VariantResult> {
  try {
    const report = JSON.parse(await readFile(reportPath, "utf8")) as {
      environment?: ReportIdentity["environment"];
      evaluatorHash?: string;
      fixture?: unknown;
      fixtureHash?: string;
      historyExperiment?: string;
      metrics?: Record<string, { samples?: unknown }>;
      runtime?: string;
      samples?: number;
      schemaVersion?: number;
      sourcePatchHash?: string;
      sourceRef?: string;
    };
    const identity: ReportIdentity = {
      environment: report.environment,
      evaluatorHash: report.evaluatorHash,
      fixture: report.fixture,
      fixtureHash: report.fixtureHash,
      historyExperiment: report.historyExperiment,
      runtime: report.runtime,
      samples: report.samples,
      schemaVersion: report.schemaVersion,
      sourcePatchHash: report.sourcePatchHash,
      sourceRef: report.sourceRef,
    };
    const rawMetricSamples: Partial<Record<PerformanceMetric, unknown[]>> = {};
    for (const name of PERFORMANCE_METRICS) {
      const values = report.metrics?.[name]?.samples;
      if (Array.isArray(values)) {
        rawMetricSamples[name] = values;
      }
    }
    const cardinality = validateMetricCardinality(
      rawMetricSamples,
      expectedSamples,
      workloadName
    );
    const metricSamples: Partial<Record<PerformanceMetric, number[]>> = {};
    for (const name of metricsToRequire) {
      const values = rawMetricSamples[name];
      if (values) {
        metricSamples[name] = values as number[];
      }
    }
    if (!(cardinality.valid && metricSamples[metricName])) {
      return {
        failureCode: "invalid_report",
        identity,
        metricSamples,
        reportPath,
        status: "failed",
      };
    }
    return { identity, metricSamples, reportPath, status: "passed" };
  } catch {
    return {
      failureCode: "invalid_report",
      identity: null,
      metricSamples: {},
      reportPath,
      status: "failed",
    };
  }
}

async function prepareDatabase(
  source: SourceIdentity,
  env: NodeJS.ProcessEnv,
  databaseTempDir: string,
  passwordPath: string,
  databasePath: string,
  port: number,
  onStarted: () => void
): Promise<void> {
  const databasePassword = env.PGPASSWORD;
  assert(databasePassword, "fixture database password is required");
  await writeFile(passwordPath, databasePassword, { mode: 0o600 });
  await command(
    "initdb",
    [
      "-D",
      databasePath,
      "--auth=scram-sha-256",
      `--pwfile=${passwordPath}`,
      "--username=busy_eval",
    ],
    source.path,
    env
  );
  await rm(passwordPath, { force: true });
  await command(
    "pg_ctl",
    [
      "-D",
      databasePath,
      "-l",
      resolve(databaseTempDir, "postgres.log"),
      "-o",
      `-h 127.0.0.1 -p ${port}`,
      "start",
    ],
    source.path,
    env
  );
  onStarted();
  await command(
    "createdb",
    ["-h", "127.0.0.1", "-p", String(port), "-U", "busy_eval", "busy_eval"],
    source.path,
    env
  );
  await verifyDatabaseAuthentication(env, port);
  await command(
    "pnpm",
    ["exec", "drizzle-kit", "push", "--force"],
    resolve(source.path, "apps/hub"),
    env
  );
  await command(
    "pnpm",
    ["exec", "tsx", "evals/performance/seed.ts"],
    resolve(source.path, "apps/hub"),
    env
  );
}

async function verifyDatabaseAuthentication(
  env: NodeJS.ProcessEnv,
  port: number
): Promise<void> {
  const url = URL.parse(env.DATABASE_URL ?? "");
  const password = env.PGPASSWORD;
  assert(url && password, "fixture database connection is required");
  const unauthorized = postgres({
    connect_timeout: 3,
    database: "busy_eval",
    host: "127.0.0.1",
    max: 1,
    password: `${password}-incorrect`,
    port,
    username: "busy_eval",
  });
  let rejected = false;
  try {
    await unauthorized`SELECT 1`;
  } catch (error) {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    if (code !== "28P01") {
      throw error;
    }
    rejected = true;
  } finally {
    await unauthorized.end({ timeout: 1 });
  }
  if (!rejected) {
    throw new Error("The fixture database accepted an incorrect password");
  }
}

function sourcePath(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required; provide two clean source checkouts`);
  }
  return resolve(value);
}

const controlPath = sourcePath("PERF_CONTROL_DIR");
const treatmentPath = sourcePath("PERF_TREATMENT_DIR");
if (controlPath === treatmentPath) {
  throw new Error("PERF_CONTROL_DIR and PERF_TREATMENT_DIR must differ");
}
const metric = (process.env.PERF_AB_METRIC ??
  "loadReadyMs") as PerformanceMetric;
if (!PERFORMANCE_METRICS.includes(metric)) {
  throw new Error(
    `PERF_AB_METRIC must be one of: ${PERFORMANCE_METRICS.join(", ")}`
  );
}
const runtimeValue = process.env.PERF_RUNTIME ?? "chromium";
if (runtimeValue !== "chromium" && runtimeValue !== "electron") {
  throw new Error("PERF_RUNTIME must be chromium or electron");
}
const runtime = runtimeValue;
const workloadValue = process.env.PERF_WORKLOAD ?? "scale";
if (
  workloadValue !== "mixed" &&
  workloadValue !== "scale" &&
  workloadValue !== "history-long"
) {
  throw new Error("PERF_WORKLOAD must be scale, mixed or history-long");
}
const workload = workloadValue;
const commonHistoryExperiment =
  process.env.PERF_HISTORY_EXPERIMENT ?? "unassigned";
const resolveHistoryExperiment = (value: string): HistoryExperiment => {
  if (
    !["bulk-manual", "paged-manual", "paged-scroller", "unassigned"].includes(
      value
    )
  ) {
    throw new Error(
      "History experiment labels must be bulk-manual, paged-manual, paged-scroller or unassigned"
    );
  }
  return value as HistoryExperiment;
};
const controlHistoryExperiment = resolveHistoryExperiment(
  process.env.PERF_AB_CONTROL_HISTORY_EXPERIMENT ?? commonHistoryExperiment
);
const treatmentHistoryExperiment = resolveHistoryExperiment(
  process.env.PERF_AB_TREATMENT_HISTORY_EXPERIMENT ?? commonHistoryExperiment
);
const alpha = Number(process.env.PERF_AB_ALPHA ?? 0.05);
if (!(alpha > 0 && alpha < 1)) {
  throw new Error("PERF_AB_ALPHA must be greater than 0 and less than 1");
}
const plan = createPairedPlan({
  alpha,
  blocks: numberEnv("PERF_AB_BLOCKS", 8),
  controlHistoryExperiment,
  metric,
  runtime,
  samplesPerBlock: numberEnv("PERF_AB_SAMPLES_PER_BLOCK", 6),
  seed: numberEnv("PERF_AB_SEED", 1104),
  treatmentHistoryExperiment,
  workload,
});
const requiredMetricNames = requiredMetricsForWorkload(
  plan.samplesPerBlock,
  workload
);
const control = await identifySource(controlPath);
const treatment = await identifySource(treatmentPath);
if (control.evaluatorHash !== treatment.evaluatorHash) {
  throw new Error("Control and treatment must use the same evaluator files");
}
if (control.fixtureHash !== treatment.fixtureHash) {
  throw new Error(
    "Control and treatment must use the same performance fixture"
  );
}
if (control.schemaHash !== treatment.schemaHash) {
  throw new Error("Control and treatment must use the same database schema");
}
let observedReportEnvironment: ReportIdentity["environment"] | null = null;

function reportIdentityMatches(
  identity: ReportIdentity | null,
  source: SourceIdentity,
  expectedExperiment: HistoryExperiment
): boolean {
  if (
    !identity ||
    identity.sourceRef !== source.ref ||
    identity.sourcePatchHash !== source.patchHash ||
    identity.evaluatorHash !== source.evaluatorHash ||
    identity.fixtureHash !== source.fixtureHash ||
    identity.historyExperiment !== expectedExperiment ||
    identity.schemaVersion !== REPORT_SCHEMA_VERSION ||
    identity.runtime !== runtime ||
    identity.samples !== plan.samplesPerBlock ||
    JSON.stringify(identity.fixture) !== JSON.stringify(getWorkload(workload))
  ) {
    return false;
  }
  const { environment } = identity;
  if (
    !environment ||
    environment.arch !== process.arch ||
    environment.node !== process.version ||
    environment.platform !== process.platform ||
    !environment.cpu ||
    !environment.browser
  ) {
    return false;
  }
  const serialized = JSON.stringify(environment);
  if (observedReportEnvironment === null) {
    observedReportEnvironment = environment;
    return true;
  }
  return JSON.stringify(observedReportEnvironment) === serialized;
}

const runId =
  process.env.PERF_AB_RUN_ID ??
  new Date().toISOString().replaceAll(/[^0-9A-Za-z]/gu, "");
const outputDirectory = resolve(
  process.env.PERF_AB_OUTPUT_DIR ?? resolve(outputRoot, `paired-${runId}`)
);
await mkdir(outputDirectory, { recursive: true });
const existing = await readdir(outputDirectory);
if (existing.length > 0) {
  throw new Error(`PERF_AB_OUTPUT_DIR must be empty: ${outputDirectory}`);
}
const orchestratorHash = await hashOrderedFiles(root, [
  "apps/hub/evals/performance/paired.ts",
  "apps/hub/evals/performance/paired-process.ts",
  "apps/hub/evals/performance/paired-stats.ts",
]);
const fixedPlan = {
  ...plan,
  aaCalibration:
    control.ref === treatment.ref &&
    plan.controlHistoryExperiment === plan.treatmentHistoryExperiment,
  control,
  environment: {
    arch: process.arch,
    cpu: cpus()[0]?.model ?? "unknown",
    node: process.version,
    platform: process.platform,
  },
  evaluatorHash: control.evaluatorHash,
  fixtureHash: control.fixtureHash,
  orchestratorHash,
  runId,
  treatment,
};
await writeFile(
  resolve(outputDirectory, "plan.json"),
  `${JSON.stringify(fixedPlan, null, 2)}\n`
);

const databasePassword = randomUUID();
const temporary = await mkdtemp(resolve("/tmp", "busy-performance-ab-"));
const passwordFile = resolve(temporary, "password");
const databaseDirectory = resolve(temporary, "data");
const databasePort = await freePort();
const serverPorts = [await freePort(), await freePort()];
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => name !== "PERF_HISTORY_EXPECT_ARCHIVE_SESSIONS"
  )
) as NodeJS.ProcessEnv;
const sharedEnv: NodeJS.ProcessEnv = {
  ...inheritedEnv,
  DATABASE_URL: `postgresql://busy_eval:${databasePassword}@127.0.0.1:${databasePort}/busy_eval`,
  DATABASE_URL_UNPOOLED: `postgresql://busy_eval:${databasePassword}@127.0.0.1:${databasePort}/busy_eval`,
  PGPASSWORD: databasePassword,
  SESSION_SECRET: randomUUID(),
};
let databaseStarted = false;
let controlServer: RunningServer | undefined;
let treatmentServer: RunningServer | undefined;
const blockResults: BlockResult[] = [];
let preflightAbort: {
  blockId: string;
  failureCode: NonNullable<VariantResult["failureCode"]>;
  reason: string;
} | null = null;

async function runVariant(
  variant: "control" | "treatment",
  source: SourceIdentity,
  server: RunningServer,
  blockId: string
): Promise<VariantResult> {
  const reportPath = resolve(outputDirectory, `${variant}-${blockId}.json`);
  const logPath = resolve(outputDirectory, `${variant}-${blockId}.log`);
  const experiment =
    variant === "control"
      ? plan.controlHistoryExperiment
      : plan.treatmentHistoryExperiment;
  let expectedArchiveSessions: string | undefined;
  if (workload === "history-long") {
    if (experiment === "bulk-manual") {
      expectedArchiveSessions = "64";
    } else if (
      experiment === "paged-manual" ||
      experiment === "paged-scroller"
    ) {
      expectedArchiveSessions = "1";
    }
  }
  const env: NodeJS.ProcessEnv = {
    ...sharedEnv,
    PERF_BASELINE: "",
    PERF_EXPECT_MARKDOWN_WORKER: "1",
    PERF_EXPECT_STREAM_CLEANUP: "1",
    PERF_HISTORY_DIAGNOSTICS: workload === "history-long" ? "1" : "",
    PERF_HISTORY_EXPERIMENT: experiment,
    PERF_HISTORY_PRIMARY: workload === "history-long" ? "1" : "0",
    PERF_OUTPUT: reportPath,
    PERF_RECORD_BASELINE: "",
    PERF_RUNTIME: runtime,
    PERF_SAMPLES: String(plan.samplesPerBlock),
    PERF_SOURCE_DIR: source.path,
    PERF_URL: server.url,
    PERF_VERIFY: "1",
    PERF_WORKLOAD: workload,
    ...(expectedArchiveSessions === undefined
      ? {}
      : { PERF_HISTORY_EXPECT_ARCHIVE_SESSIONS: expectedArchiveSessions }),
  };
  const exitCode = await runChild(
    "pnpm",
    ["exec", "tsx", "evals/performance/run.ts"],
    resolve(source.path, "apps/hub"),
    env,
    logPath
  );
  const parsed = await parseVariantReport(
    reportPath,
    metric,
    plan.samplesPerBlock,
    requiredMetricNames,
    workload
  );
  if (
    parsed.status === "passed" &&
    !reportIdentityMatches(parsed.identity, source, experiment)
  ) {
    return {
      ...parsed,
      failureCode: "identity_mismatch",
      status: "failed",
    };
  }
  if (exitCode !== 0) {
    return {
      ...parsed,
      failureCode: "evaluator_exit",
      status: "failed",
    };
  }
  return {
    ...parsed,
  };
}

try {
  await prepareDatabase(
    control,
    sharedEnv,
    temporary,
    passwordFile,
    databaseDirectory,
    databasePort,
    () => {
      databaseStarted = true;
    }
  );
  for (const source of [control, treatment]) {
    // biome-ignore lint/performance/noAwaitInLoops: Builds must run sequentially before timing.
    await command("pnpm", ["build"], resolve(source.path, "apps/hub"), {
      ...sharedEnv,
      HUB_URL: "http://127.0.0.1",
    });
  }
  controlServer = await startServer(
    control,
    serverPorts[0] ?? 0,
    sharedEnv,
    resolve(outputDirectory, "control-server.log")
  );
  treatmentServer = await startServer(
    treatment,
    serverPorts[1] ?? 0,
    sharedEnv,
    resolve(outputDirectory, "treatment-server.log")
  );
  for (const block of plan.blocks) {
    const first = block.order === "control-first" ? "control" : "treatment";
    const second = first === "control" ? "treatment" : "control";
    const variants = {
      control: { server: controlServer, source: control },
      treatment: { server: treatmentServer, source: treatment },
    } as const;
    // biome-ignore lint/performance/noAwaitInLoops: Paired samples run serially to avoid CPU interference.
    const firstResult = await runVariant(
      first,
      variants[first].source,
      variants[first].server,
      block.id
    );
    const secondResult = await runVariant(
      second,
      variants[second].source,
      variants[second].server,
      block.id
    );
    blockResults.push({
      control: first === "control" ? firstResult : secondResult,
      id: block.id,
      order: block.order,
      treatment: first === "treatment" ? firstResult : secondResult,
    });
    if (
      firstResult.status === "failed" &&
      secondResult.status === "failed" &&
      firstResult.failureCode &&
      firstResult.failureCode === secondResult.failureCode
    ) {
      preflightAbort = {
        blockId: block.id,
        failureCode: firstResult.failureCode,
        reason:
          "Both variants failed the first paired block with the same deterministic harness/setup failure; remaining blocks were not exposed.",
      };
      break;
    }
  }
} finally {
  await stopServer(controlServer);
  await stopServer(treatmentServer);
  if (databaseStarted) {
    await command(
      "pg_ctl",
      ["-D", databaseDirectory, "-m", "fast", "stop"],
      control.path,
      sharedEnv
    ).catch(() => undefined);
  }
  await rm(temporary, { force: true, recursive: true });
}

const pairedBlocks: PairedBlockValues[] = blockResults
  .filter(
    (block) =>
      block.control.status === "passed" && block.treatment.status === "passed"
  )
  .map((block) => ({
    control: block.control.metricSamples[metric] ?? [],
    controlMetrics: block.control.metricSamples,
    id: block.id,
    order: block.order,
    treatment: block.treatment.metricSamples[metric] ?? [],
    treatmentMetrics: block.treatment.metricSamples,
  }));
const failedRuns = blockResults.reduce(
  (count, block) =>
    count +
    Number(block.control.status !== "passed") +
    Number(block.treatment.status !== "passed"),
  0
);
const attemptedRuns = blockResults.length * 2;
const successfulRuns = attemptedRuns - failedRuns;
const primary =
  pairedBlocks.length > 0
    ? summarizePairedMetric(pairedBlocks, {
        alpha: plan.alpha,
        minimumImprovementMs: plan.minimumImprovementMs,
        minimumImprovementPercent: plan.minimumImprovementPercent,
        seed: plan.seed,
      })
    : null;
const guardrailMetrics = guardrailMetricsForPlan(
  plan.metric,
  plan.samplesPerBlock,
  workload
);
const guardrails = summarizeGuardrails(pairedBlocks, guardrailMetrics);
const blockGuardrails = summarizeBlockGuardrails(
  pairedBlocks,
  guardrailMetrics
);
const guardrailFailures = guardrails.filter(
  (guardrail) => guardrail.pass === false
);
const guardrailMissing = guardrails.filter(
  (guardrail) => guardrail.pass === null
);
const { aaCalibration } = fixedPlan;
const statisticalDecision =
  failedRuns > 0 ||
  pairedBlocks.length !== plan.blocks.length ||
  guardrailFailures.length > 0 ||
  guardrailMissing.length > 0
    ? "inconclusive"
    : (primary?.status ?? "inconclusive");
const decision = statisticalDecision;
const releaseEligible = !aaCalibration && statisticalDecision === "improved";
const report = {
  aaCalibration,
  attemptedRuns,
  blockGuardrails,
  decision,
  failedRuns,
  guardrailFailures: guardrailFailures.map((guardrail) => guardrail.metric),
  guardrailMissing: guardrailMissing.map((guardrail) => guardrail.metric),
  guardrails,
  metric,
  plan: fixedPlan,
  preflightAbort,
  primary,
  releaseEligible,
  results: blockResults.map((block) => ({
    control: block.control,
    id: block.id,
    order: block.order,
    treatment: block.treatment,
  })),
  runtime,
  statisticalDecision,
  successfulRuns,
  workload,
};
await writeFile(
  resolve(outputDirectory, "result.json"),
  `${JSON.stringify(report, null, 2)}\n`
);
console.log(
  JSON.stringify({
    aaCalibration,
    decision,
    failedRuns,
    outputDirectory,
    primary: primary
      ? {
          bootstrapCi95Percent: primary.bootstrapCi95Percent,
          improvementPercent: primary.improvementPercent,
          metric,
          pValue: primary.pValue,
          status: primary.status,
        }
      : null,
    releaseEligible,
  })
);
if (decision === "inconclusive") {
  process.exitCode = 2;
}
