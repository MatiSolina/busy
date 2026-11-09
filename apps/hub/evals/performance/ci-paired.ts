// biome-ignore-all lint/performance/noAwaitInLoops: The fixed paired horizon intentionally serializes browser profiles.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type CiReportEnvironment,
  ciHistoryConfig,
  type ExpectedCiReportIdentity,
  evaluateGuardOnly,
  validateCiReport,
} from "./ci-paired-core";
import {
  DRIVER_ROOT,
  hashEvaluatorFiles,
  hashFixtureFiles,
} from "./evaluator-identity";
import { stopProcessGroup } from "./paired-process";
import {
  createPairedPlan,
  GUARDRAIL_FAMILY_ALPHA,
  GUARDRAIL_PERMUTATIONS,
  guardrailMetricsForPlan,
  P95_GUARDRAIL_LIMIT,
  type PairedBlockValues,
  type PerformanceMetric,
  type PerformanceWorkload,
  p50RatioPermutationPValue,
  requiredMetricsForWorkload,
  summarizeBlockGuardrails,
  summarizeGuardrails,
  summarizePairedMetric,
} from "./paired-stats";
import { getWorkload } from "./workload";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SOURCE_IDENTITY_PATHS = [
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
] as const;
const BLOCKS = 4;
const SAMPLES_PER_BLOCK = 6;
const SCHEMA_VERSION = 11;

interface SourceIdentity {
  patchHash: string;
  path: string;
  ref: string;
}

interface RunOutcome {
  blockId: string;
  environment: CiReportEnvironment | null;
  errors: string[];
  exitCode: number;
  logPath: string;
  metricSamples: Partial<Record<PerformanceMetric, number[]>>;
  reportPath: string;
  status: "failed" | "passed";
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

async function gitValue(source: string, args: string[]): Promise<string> {
  const result = await exec("git", args, {
    cwd: source,
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function sourcePatchHash(source: string): Promise<string> {
  const result = await exec(
    "git",
    ["diff", "--binary", "HEAD", "--", ...SOURCE_IDENTITY_PATHS],
    {
      cwd: source,
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  return createHash("sha256").update(result.stdout).digest("hex");
}

async function identifySource(sourcePath: string): Promise<SourceIdentity> {
  const path = resolve(sourcePath);
  const status = await gitValue(path, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (status.length > 0) {
    throw new Error(`Performance source checkout must be clean: ${path}`);
  }
  return {
    patchHash: await sourcePatchHash(path),
    path,
    ref: await gitValue(path, ["rev-parse", "HEAD"]),
  };
}

function assertExpectedSourceRef(name: string, actual: string): string {
  const expected = process.env[name];
  if (expected && expected !== actual) {
    throw new Error(
      `${name} mismatch: expected ${expected}, observed ${actual}`
    );
  }
  return expected ?? actual;
}

function appendOutput(target: Buffer[], chunk: Buffer): void {
  const current = target.reduce((total, value) => total + value.length, 0);
  if (current < 4 * 1024 * 1024) {
    target.push(chunk.subarray(0, 4 * 1024 * 1024 - current));
  }
}

async function runEvaluator(
  source: SourceIdentity,
  url: string,
  outputPath: string,
  logPath: string,
  workloadName: PerformanceWorkload,
  runtimeName: "chromium" | "electron",
  historyExperimentName: string,
  historyPrimary: "0" | "1",
  expectedArchiveSessions: string
): Promise<{ exitCode: number; timedOut: boolean }> {
  const child = spawn("pnpm", ["exec", "tsx", "evals/performance/run.ts"], {
    cwd: resolve(DRIVER_ROOT, "apps/hub"),
    detached: true,
    env: {
      ...process.env,
      PERF_BASELINE: "",
      PERF_EXPECT_MARKDOWN_WORKER: "1",
      PERF_EXPECT_STREAM_CLEANUP: "1",
      PERF_HISTORY_EXPECT_ARCHIVE_SESSIONS: expectedArchiveSessions,
      PERF_HISTORY_EXPERIMENT: historyExperimentName,
      PERF_HISTORY_PRIMARY: historyPrimary,
      PERF_OUTPUT: outputPath,
      PERF_RECORD_BASELINE: "",
      PERF_RUNTIME: runtimeName,
      PERF_SAMPLES: String(SAMPLES_PER_BLOCK),
      PERF_SOURCE_DIR: source.path,
      PERF_URL: url,
      PERF_VERIFY: "1",
      PERF_WORKLOAD: workloadName,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => appendOutput(stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer) => appendOutput(stderr, chunk));
  const timeoutMs = envNumber("PERF_CI_RUN_TIMEOUT_MS", 180_000);
  let timedOut = false;
  const exitCode = await new Promise<number>((resolvePromise) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      stopProcessGroup(child, 1000)
        .then(() => resolvePromise(124))
        .catch(() => resolvePromise(124));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      stderr.push(Buffer.from(String(error)));
      resolvePromise(127);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise(code ?? (signal ? 128 : 1));
    });
  });
  await writeFile(
    logPath,
    [
      `[exitCode=${exitCode}${timedOut ? ", timedOut=true" : ""}]`,
      "[stdout]",
      Buffer.concat(stdout).toString("utf8"),
      "[stderr]",
      Buffer.concat(stderr).toString("utf8"),
    ].join("\n")
  );
  return { exitCode, timedOut };
}

async function loadReport(
  reportPath: string,
  identity: ExpectedCiReportIdentity,
  workloadName: PerformanceWorkload,
  blockId: string,
  exitCode: number
): Promise<RunOutcome> {
  try {
    const report = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
    const validation = validateCiReport(report, identity, workloadName);
    return {
      blockId,
      environment: validation.identity?.environment ?? null,
      errors: [
        ...validation.errors,
        ...(exitCode === 0 ? [] : [`evaluator exited with code ${exitCode}`]),
      ],
      exitCode,
      logPath: "",
      metricSamples: validation.metricSamples,
      reportPath,
      status: validation.valid && exitCode === 0 ? "passed" : "failed",
    };
  } catch (error) {
    return {
      blockId,
      environment: null,
      errors: [
        `unable to read report: ${error instanceof Error ? error.message : String(error)}`,
        ...(exitCode === 0 ? [] : [`evaluator exited with code ${exitCode}`]),
      ],
      exitCode,
      logPath: "",
      metricSamples: {},
      reportPath,
      status: "failed",
    };
  }
}

function originalGuardrailMetrics(
  selectedWorkload: ReturnType<typeof getWorkload>
): PerformanceMetric[] {
  const metrics: PerformanceMetric[] = ["coldStreamReadyMs"];
  if (selectedWorkload.bots > 1) {
    metrics.push("switchReadyMs");
  }
  metrics.push(
    "panelReadyMs",
    "typingReadyMs",
    "streamReadyMs",
    "enterChatRouteReadyMs",
    "leaveChatRouteReadyMs",
    "returnChatRouteReadyMs"
  );
  return metrics;
}

const requestedWorkloadName = (process.env.PERF_WORKLOAD ??
  "scale") as PerformanceWorkload;
const activeWorkload = getWorkload(requestedWorkloadName);
const ciHistory = ciHistoryConfig(requestedWorkloadName);
const runtimeValue = process.env.PERF_RUNTIME ?? "chromium";
if (runtimeValue !== "chromium" && runtimeValue !== "electron") {
  throw new Error("PERF_RUNTIME must be chromium or electron");
}
const activeRuntime = runtimeValue;
const targetSpeedup = Number(process.env.PERF_TARGET_SPEEDUP ?? 0.91);
if (!Number.isFinite(targetSpeedup) || targetSpeedup <= 0) {
  throw new Error("PERF_TARGET_SPEEDUP must be a positive number");
}
const controlUrl = process.env.PERF_CONTROL_URL;
const treatmentUrl = process.env.PERF_TREATMENT_URL;
const controlSourcePath = process.env.PERF_CONTROL_SOURCE_DIR;
const treatmentSourcePath = process.env.PERF_TREATMENT_SOURCE_DIR;
if (!(controlUrl && treatmentUrl && controlSourcePath && treatmentSourcePath)) {
  throw new Error(
    "PERF_CONTROL_URL, PERF_TREATMENT_URL and both source directories are required"
  );
}
const requestedHistoryExperiment = process.env.PERF_HISTORY_EXPERIMENT;
if (
  requestedHistoryExperiment &&
  requestedHistoryExperiment !== ciHistory.experiment
) {
  throw new Error(
    "CI paired UI canary requires paged-manual; use paired.ts with explicit PERF_AB_*_HISTORY_EXPERIMENT values for bulk-vs-paged local comparisons"
  );
}
const activeHistoryExperiment = ciHistory.experiment;
const seed = envNumber("PERF_CI_PAIR_SEED", 1104);
const outputDirectory = resolve(
  process.env.PERF_CI_OUTPUT_DIR ??
    resolve(root, ".performance", "ci-paired", activeWorkload.name)
);
await mkdir(outputDirectory, { recursive: true });
if ((await readdir(outputDirectory)).length > 0) {
  throw new Error(`PERF_CI_OUTPUT_DIR must be empty: ${outputDirectory}`);
}

const control = await identifySource(controlSourcePath);
const treatment = await identifySource(treatmentSourcePath);
const expectedControlRef = assertExpectedSourceRef(
  "PERF_EXPECTED_CONTROL_REF",
  control.ref
);
const expectedTreatmentRef = assertExpectedSourceRef(
  "PERF_EXPECTED_TREATMENT_REF",
  treatment.ref
);
const declaredBaseRef = process.env.PERF_DECLARED_BASE_REF || null;
const baseRefStale = process.env.PERF_BASE_REF_STALE === "true";
if (baseRefStale && !declaredBaseRef) {
  throw new Error("A stale base flag requires the declared base ref");
}
const evaluatorHash = await hashEvaluatorFiles(DRIVER_ROOT);
const fixtureHash = await hashFixtureFiles(DRIVER_ROOT);
const plan = createPairedPlan({
  alpha: 0.05,
  blocks: BLOCKS,
  controlHistoryExperiment: activeHistoryExperiment,
  metric: "loadReadyMs",
  runtime: activeRuntime,
  samplesPerBlock: SAMPLES_PER_BLOCK,
  seed,
  treatmentHistoryExperiment: activeHistoryExperiment,
  workload: activeWorkload.name,
});
const requiredMetrics = requiredMetricsForWorkload(
  SAMPLES_PER_BLOCK,
  activeWorkload.name
);
const commonIdentity = {
  evaluatorHash,
  fixture: activeWorkload,
  fixtureHash,
  historyExperiment: activeHistoryExperiment,
  runtime: activeRuntime,
  samples: SAMPLES_PER_BLOCK,
  schemaVersion: SCHEMA_VERSION,
};
const controlExpected: ExpectedCiReportIdentity = {
  ...commonIdentity,
  sourcePatchHash: control.patchHash,
  sourceRef: expectedControlRef,
};
const treatmentExpected: ExpectedCiReportIdentity = {
  ...commonIdentity,
  sourcePatchHash: treatment.patchHash,
  sourceRef: expectedTreatmentRef,
};

await writeFile(
  resolve(outputDirectory, "plan.json"),
  `${JSON.stringify(
    {
      blocks: plan.blocks,
      control: controlExpected,
      decision: "guard_only",
      driverRoot: DRIVER_ROOT,
      eventBaseStale: baseRefStale,
      fixedHorizon: true,
      // Predeclared with the plan, before any sample exists.
      guardrailTest: {
        familyAlpha: GUARDRAIL_FAMILY_ALPHA,
        method: "within-block label permutation, Bonferroni",
        permutations: GUARDRAIL_PERMUTATIONS,
      },
      mergeParentBaseSha: expectedControlRef,
      p95GuardrailLimit: P95_GUARDRAIL_LIMIT,
      payloadBaseSha: declaredBaseRef,
      requiredMetrics,
      samplesPerBlock: SAMPLES_PER_BLOCK,
      targetSpeedup,
      totalProfiles: BLOCKS * 2 * SAMPLES_PER_BLOCK,
      treatment: treatmentExpected,
      workload: activeWorkload.name,
    },
    null
  )}\n`
);

// Unscored warmup, one per arm. Without it the job's first evaluator run
// (always block-01 control under the fixed seed) pays the runner's cold
// start: its first coldStreamReadyMs sample had median 159 ms vs ~130 ms
// elsewhere (p90 330 ms) across 34 A/A runs, skewing the control p95.
const startedAt = Date.now();
for (const variant of ["control", "treatment"] as const) {
  await runEvaluator(
    variant === "control" ? control : treatment,
    variant === "control" ? controlUrl : treatmentUrl,
    resolve(outputDirectory, `warmup-${variant}.json`),
    resolve(outputDirectory, `warmup-${variant}.log`),
    activeWorkload.name,
    activeRuntime,
    activeHistoryExperiment,
    ciHistory.primary,
    ciHistory.expectedArchiveSessions
  );
}

let observedEnvironment: CiReportEnvironment | undefined;
const outcomes: Record<"control" | "treatment", RunOutcome>[] = [];
for (const block of plan.blocks) {
  const first = block.order === "control-first" ? "control" : "treatment";
  const second = first === "control" ? "treatment" : "control";
  const blockOutcomes = {} as Record<"control" | "treatment", RunOutcome>;
  for (const variant of [first, second] as const) {
    const source = variant === "control" ? control : treatment;
    const url = variant === "control" ? controlUrl : treatmentUrl;
    const expected =
      variant === "control" ? controlExpected : treatmentExpected;
    const reportPath = resolve(outputDirectory, `${block.id}-${variant}.json`);
    const logPath = resolve(outputDirectory, `${block.id}-${variant}.log`);
    const processResult = await runEvaluator(
      source,
      url,
      reportPath,
      logPath,
      activeWorkload.name,
      activeRuntime,
      activeHistoryExperiment,
      ciHistory.primary,
      ciHistory.expectedArchiveSessions
    );
    const outcome = await loadReport(
      reportPath,
      {
        ...expected,
        ...(observedEnvironment ? { environment: observedEnvironment } : {}),
      },
      activeWorkload.name,
      block.id,
      processResult.exitCode
    );
    outcome.logPath = logPath;
    if (!observedEnvironment && outcome.environment) {
      observedEnvironment = outcome.environment;
    }
    blockOutcomes[variant] = outcome;
  }
  outcomes.push(blockOutcomes);
}

const pairedBlocks: PairedBlockValues[] = outcomes
  .filter(
    (block) =>
      block.control.status === "passed" && block.treatment.status === "passed"
  )
  .map((block) => {
    const planBlock = plan.blocks.find(
      ({ id }) => id === block.control.blockId
    );
    return {
      control: block.control.metricSamples.loadReadyMs ?? [],
      controlMetrics: block.control.metricSamples,
      id: planBlock?.id ?? block.control.blockId,
      order: planBlock?.order ?? "control-first",
      treatment: block.treatment.metricSamples.loadReadyMs ?? [],
      treatmentMetrics: block.treatment.metricSamples,
    };
  });
const allRunsValid =
  outcomes.length === BLOCKS &&
  outcomes.every(
    (block) =>
      block.control.status === "passed" && block.treatment.status === "passed"
  ) &&
  pairedBlocks.length === BLOCKS;
const primary =
  pairedBlocks.length === BLOCKS
    ? summarizePairedMetric(pairedBlocks, {
        alpha: 0.05,
        seed,
      })
    : null;
const guardrailMetrics = guardrailMetricsForPlan(
  "loadReadyMs",
  SAMPLES_PER_BLOCK,
  activeWorkload.name
).filter((metric) => originalGuardrailMetrics(activeWorkload).includes(metric));
const guardrails = summarizeGuardrails(pairedBlocks, guardrailMetrics, {
  seed,
});
const blockGuardrails = summarizeBlockGuardrails(
  pairedBlocks,
  guardrailMetrics
);
const evaluation = evaluateGuardOnly({
  controlP50: primary?.control.p50 ?? null,
  guardrails,
  startupPValue:
    pairedBlocks.length === BLOCKS
      ? p50RatioPermutationPValue(pairedBlocks, { seed })
      : null,
  targetSpeedup,
  treatmentP50: primary?.treatment.p50 ?? null,
  valid: allRunsValid,
});
const result = {
  attemptedRuns: outcomes.length * 2 * SAMPLES_PER_BLOCK,
  blockGuardrails,
  blocks: outcomes,
  decision: evaluation.decision,
  durationMs: Date.now() - startedAt,
  eventBaseStale: baseRefStale,
  failures: [
    ...evaluation.failures,
    ...outcomes.flatMap((block) =>
      [block.control, block.treatment].flatMap((run) =>
        run.errors.map((error) => `${run.blockId}: ${error}`)
      )
    ),
  ],
  guardrails,
  mergeParentBaseSha: expectedControlRef,
  p95GuardrailLimit: P95_GUARDRAIL_LIMIT,
  payloadBaseSha: declaredBaseRef,
  primary,
  releaseEligible: false,
  runtime: activeRuntime,
  samplesPerBlock: SAMPLES_PER_BLOCK,
  sourceRefs: {
    control: expectedControlRef,
    treatment: expectedTreatmentRef,
  },
  startupPass: evaluation.startupPass,
  startupSpeedup: evaluation.startupSpeedup,
  targetSpeedup,
  totalProfiles: BLOCKS * 2 * SAMPLES_PER_BLOCK,
  warnings: evaluation.warnings,
  workload: activeWorkload.name,
};
await writeFile(
  resolve(outputDirectory, "result.json"),
  `${JSON.stringify(result, null, 2)}\n`
);
console.log(
  JSON.stringify({
    decision: evaluation.decision,
    durationMs: result.durationMs,
    outputDirectory,
    startupSpeedup: evaluation.startupSpeedup,
    targetSpeedup,
    warnings: evaluation.warnings,
    workload: activeWorkload.name,
  })
);
if (evaluation.decision !== "neutral") {
  process.exitCode = 1;
}
