import { isDeepStrictEqual } from "node:util";
import {
  type PerformanceMetric,
  type PerformanceWorkload,
  validateMetricCardinality,
} from "./paired-stats";

export interface CiReportEnvironment {
  arch?: unknown;
  browser?: unknown;
  cpu?: unknown;
  node?: unknown;
  platform?: unknown;
  [key: string]: unknown;
}

export interface CiPerformanceReport {
  environment?: CiReportEnvironment;
  evaluatorHash?: unknown;
  fixture?: unknown;
  fixtureHash?: unknown;
  historyExperiment?: unknown;
  metrics?: Record<string, { samples?: unknown } | undefined>;
  runtime?: unknown;
  samples?: unknown;
  schemaVersion?: unknown;
  sourcePatchHash?: unknown;
  sourceRef?: unknown;
}

export interface CiReportIdentity {
  environment: CiReportEnvironment | null;
  evaluatorHash: unknown;
  fixture: unknown;
  fixtureHash: unknown;
  historyExperiment: unknown;
  runtime: unknown;
  samples: unknown;
  schemaVersion: unknown;
  sourcePatchHash: unknown;
  sourceRef: unknown;
}

export interface ExpectedCiReportIdentity {
  environment?: CiReportEnvironment;
  evaluatorHash: string;
  fixture: unknown;
  fixtureHash: string;
  historyExperiment: string;
  runtime: string;
  samples: number;
  schemaVersion: number;
  sourcePatchHash: string;
  sourceRef: string;
}

export interface CiReportValidation {
  errors: string[];
  identity: CiReportIdentity | null;
  metricSamples: Partial<Record<PerformanceMetric, number[]>>;
  valid: boolean;
}

export type GuardOnlyDecision = "neutral" | "regressed" | "invalid";

export interface GuardOnlyEvaluation {
  decision: GuardOnlyDecision;
  failures: string[];
  startupPass: boolean;
  startupSpeedup: number | null;
  /** Above the p95 limit but not significant: shown, never blocking. */
  warnings: string[];
}

export interface GuardOnlyInput {
  controlP50: number | null;
  guardrails: readonly {
    adjustedAlpha?: number;
    exceedsLimit?: boolean | null;
    metric: string;
    pass: boolean | null;
    pValue?: number | null;
    ratio?: number | null;
  }[];
  /** Significance of a startup slowdown (p50 permutation); without it the point estimate decides. */
  startupAlpha?: number;
  startupPValue?: number | null;
  targetSpeedup: number;
  treatmentP50: number | null;
  valid: boolean;
}

export function historyPrimaryEnv(workload: PerformanceWorkload): "0" | "1" {
  return workload === "history-long" ? "1" : "0";
}

export function ciHistoryConfig(workload: PerformanceWorkload): {
  expectedArchiveSessions: "1";
  experiment: "paged-manual";
  primary: "0" | "1";
} {
  return {
    expectedArchiveSessions: "1",
    experiment: "paged-manual",
    primary: historyPrimaryEnv(workload),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asReport(value: unknown): CiPerformanceReport | null {
  if (!isRecord(value)) {
    return null;
  }
  return value as CiPerformanceReport;
}

function reportIdentity(report: CiPerformanceReport): CiReportIdentity {
  return {
    environment: report.environment ?? null,
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
}

function requireEqual(
  errors: string[],
  name: keyof CiReportIdentity,
  actual: unknown,
  expected: unknown
): void {
  if (!isDeepStrictEqual(actual, expected)) {
    errors.push(`${String(name)} mismatch`);
  }
}

function validEnvironment(environment: CiReportEnvironment | null): boolean {
  if (!environment) {
    return false;
  }
  return ["arch", "browser", "cpu", "node", "platform"].every(
    (name) =>
      typeof environment[name] === "string" &&
      (environment[name] as string).length > 0
  );
}

/**
 * Validate one raw evaluator report without launching any external process.
 * The runner supplies a source-specific identity and the environment observed
 * by the first successful report, so control and treatment cannot silently be
 * compared across different drivers or runtimes.
 */
export function validateCiReport(
  value: unknown,
  expected: ExpectedCiReportIdentity,
  workload: PerformanceWorkload
): CiReportValidation {
  const report = asReport(value);
  if (!report) {
    return {
      errors: ["report must be an object"],
      identity: null,
      metricSamples: {},
      valid: false,
    };
  }
  const identity = reportIdentity(report);
  const errors: string[] = [];
  requireEqual(errors, "sourceRef", identity.sourceRef, expected.sourceRef);
  requireEqual(
    errors,
    "sourcePatchHash",
    identity.sourcePatchHash,
    expected.sourcePatchHash
  );
  requireEqual(
    errors,
    "evaluatorHash",
    identity.evaluatorHash,
    expected.evaluatorHash
  );
  requireEqual(
    errors,
    "fixtureHash",
    identity.fixtureHash,
    expected.fixtureHash
  );
  requireEqual(errors, "fixture", identity.fixture, expected.fixture);
  requireEqual(
    errors,
    "historyExperiment",
    identity.historyExperiment,
    expected.historyExperiment
  );
  requireEqual(errors, "runtime", identity.runtime, expected.runtime);
  requireEqual(errors, "samples", identity.samples, expected.samples);
  requireEqual(
    errors,
    "schemaVersion",
    identity.schemaVersion,
    expected.schemaVersion
  );
  if (!validEnvironment(identity.environment)) {
    errors.push("environment is incomplete");
  }
  if (
    expected.environment &&
    !isDeepStrictEqual(identity.environment, expected.environment)
  ) {
    errors.push("environment mismatch");
  }

  const rawMetricSamples: Partial<Record<PerformanceMetric, unknown[]>> = {};
  for (const [name, metric] of Object.entries(report.metrics ?? {})) {
    if (metric && Array.isArray(metric.samples)) {
      rawMetricSamples[name as PerformanceMetric] = metric.samples;
    }
  }
  const cardinality = validateMetricCardinality(
    rawMetricSamples,
    expected.samples,
    workload
  );
  if (cardinality.invalid.length > 0) {
    errors.push(`unexpected metric samples: ${cardinality.invalid.join(", ")}`);
  }
  if (cardinality.missing.length > 0) {
    errors.push(
      `invalid metric cardinality: ${cardinality.missing.join(", ")}`
    );
  }

  const metricSamples: Partial<Record<PerformanceMetric, number[]>> = {};
  if (cardinality.valid) {
    for (const [name, values] of Object.entries(rawMetricSamples)) {
      metricSamples[name as PerformanceMetric] = values as number[];
    }
  }
  return {
    errors,
    identity,
    metricSamples,
    valid: errors.length === 0 && cardinality.valid,
  };
}

/** Like the p95 guardrails: below the target fails only when the slowdown is significant. */
function startupDecision(
  speedup: number,
  input: GuardOnlyInput
): { failure?: string; pass: boolean; warning?: string } {
  const { startupPValue, targetSpeedup } = input;
  if (speedup >= targetSpeedup) {
    return { pass: true };
  }
  const alpha = input.startupAlpha ?? 0.05;
  const hasP = typeof startupPValue === "number";
  if (hasP && startupPValue > alpha) {
    return {
      pass: true,
      warning: `loadReadyMs p50 speedup ${speedup.toFixed(3)} below ${targetSpeedup} but not significant (permutation p=${startupPValue.toFixed(4)}, alpha ${alpha}); rerun if it reproduces`,
    };
  }
  const detail = hasP ? ` (permutation p=${startupPValue.toFixed(4)})` : "";
  return {
    failure: `loadReadyMs p50 speedup ${speedup} is below ${targetSpeedup}${detail}`,
    pass: false,
  };
}

/**
 * Evaluate the CI canary as a guard-only decision. `neutral` means that the
 * fixed-horizon guard passed; it deliberately does not claim a product winner.
 */
export function evaluateGuardOnly(input: GuardOnlyInput): GuardOnlyEvaluation {
  const finiteNonNegative = (value: number | null): value is number =>
    value !== null && Number.isFinite(value) && value >= 0;
  if (
    !(
      input.valid &&
      finiteNonNegative(input.controlP50) &&
      finiteNonNegative(input.treatmentP50) &&
      Number.isFinite(input.targetSpeedup)
    ) ||
    input.targetSpeedup <= 0
  ) {
    return {
      decision: "invalid",
      failures: ["missing or invalid paired canary data"],
      startupPass: false,
      startupSpeedup: null,
      warnings: [],
    };
  }

  let startupSpeedup = input.controlP50 / input.treatmentP50;
  if (input.controlP50 === 0) {
    startupSpeedup = input.treatmentP50 === 0 ? 1 : 0;
  }
  const startup = startupDecision(startupSpeedup, input);
  const startupPass = startup.pass;
  const failures = startup.failure ? [startup.failure] : [];
  const warnings: string[] = startup.warning ? [startup.warning] : [];
  for (const guardrail of input.guardrails) {
    const detail = `ratio ${guardrail.ratio?.toFixed(3)}, permutation p=${guardrail.pValue?.toFixed(4)}, threshold ${guardrail.adjustedAlpha?.toFixed(4)}`;
    if (guardrail.pass === false) {
      failures.push(
        `${guardrail.metric} p95 exceeded the 10% guardrail (${detail})`
      );
    } else if (guardrail.pass === null) {
      failures.push(`${guardrail.metric} p95 is missing`);
    } else if (guardrail.exceedsLimit) {
      warnings.push(
        `${guardrail.metric} p95 above 1.10 but not significant (${detail}); rerun if it reproduces`
      );
    }
  }
  return {
    decision: failures.length === 0 ? "neutral" : "regressed",
    failures,
    startupPass,
    startupSpeedup,
    warnings,
  };
}
