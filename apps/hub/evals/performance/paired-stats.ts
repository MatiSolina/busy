export const PERFORMANCE_METRICS = [
  "archiveFirstPageReadyMs",
  "loadReadyMs",
  "switchReadyMs",
  "coldSwitchReadyMs",
  "warmSwitchReadyMs",
  "typingReadyMs",
  "coldStreamReadyMs",
  "streamReadyMs",
  "panelReadyMs",
  "settingsReadyMs",
  "enterChatRouteReadyMs",
  "leaveChatRouteReadyMs",
  "returnChatRouteReadyMs",
] as const;

export type PerformanceMetric = (typeof PERFORMANCE_METRICS)[number];
export type PerformanceWorkload = "history-long" | "mixed" | "scale";
export type HistoryExperiment =
  | "bulk-manual"
  | "paged-manual"
  | "paged-scroller"
  | "unassigned";

export const INTERACTION_GUARDRAILS = PERFORMANCE_METRICS.filter(
  (metric) => metric !== "archiveFirstPageReadyMs" && metric !== "loadReadyMs"
);

export type BlockOrder = "control-first" | "treatment-first";

export interface PairedBlockPlan {
  id: string;
  order: BlockOrder;
}

export interface PairedPlan {
  alpha: number;
  blocks: PairedBlockPlan[];
  controlHistoryExperiment: HistoryExperiment;
  metric: PerformanceMetric;
  minimumImprovementMs: number;
  minimumImprovementPercent: number;
  runtime: "chromium" | "electron";
  samplesPerBlock: number;
  seed: number;
  treatmentHistoryExperiment: HistoryExperiment;
  workload: PerformanceWorkload;
}

export interface PairedBlockValues {
  control: number[];
  controlMetrics?: Partial<Record<PerformanceMetric, number[]>>;
  id: string;
  order: BlockOrder;
  treatment: number[];
  treatmentMetrics?: Partial<Record<PerformanceMetric, number[]>>;
}

export interface PairedMetricSummary {
  absoluteDeltaMs: number;
  alpha: number;
  blockImprovementsPercent: number[];
  bootstrapCi95Percent: [number, number];
  control: {
    p50: number;
    p95: number;
    samples: number;
  };
  improvementPercent: number;
  minimumImprovementMs: number;
  minimumImprovementPercent: number;
  pValue: number;
  status: "inconclusive" | "improved" | "regressed";
  treatment: {
    p50: number;
    p95: number;
    samples: number;
  };
}

export interface GuardrailSummary {
  controlP95: number | null;
  metric: PerformanceMetric;
  pass: boolean | null;
  ratio: number | null;
  treatmentP95: number | null;
}

/** Aggregate guardrail with its significance test (docs/performance-ab.md#guardrails). */
export interface TestedGuardrailSummary extends GuardrailSummary {
  /** Per-metric level after Bonferroni over the declared guardrail metrics. */
  adjustedAlpha: number;
  /** The point estimate is above the limit; with pass=true it is a warning, not a failure. */
  exceedsLimit: boolean | null;
  /** One-sided within-block label permutation p-value of the pooled p95 ratio. */
  pValue: number | null;
}

export const P95_GUARDRAIL_LIMIT = 1.1;
export const GUARDRAIL_FAMILY_ALPHA = 0.05;
export const GUARDRAIL_PERMUTATIONS = 2000;

export interface BlockGuardrailSummary extends GuardrailSummary {
  blockId: string;
}

function assertFiniteValues(values: number[], name: string): void {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`${name} must contain finite values`);
  }
}

function assertNonNegativeValues(values: number[], name: string): void {
  assertFiniteValues(values, name);
  if (values.some((value) => value < 0)) {
    throw new Error(`${name} must contain non-negative values`);
  }
}

export function median(values: number[]): number {
  assertFiniteValues(values, "values");
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.5) - 1] ?? 0;
}

export function percentile(values: number[], percentileValue: number): number {
  assertFiniteValues(values, "values");
  if (!(percentileValue > 0 && percentileValue <= 1)) {
    throw new Error("percentile must be greater than 0 and at most 1");
  }
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * percentileValue) - 1] ?? 0;
}

function randomGenerator(seed: number): () => number {
  let state = seed % 4_294_967_296;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function shuffled<T>(values: T[], seed: number): T[] {
  const random = randomGenerator(seed);
  const output = [...values];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [output[index], output[swap]] = [output[swap], output[index]];
  }
  return output;
}

interface PlanOptions {
  alpha: number;
  blocks: number;
  controlHistoryExperiment: HistoryExperiment;
  metric: PerformanceMetric;
  minimumImprovementMs: number;
  minimumImprovementPercent: number;
  runtime: "chromium" | "electron";
  samplesPerBlock: number;
  seed: number;
  treatmentHistoryExperiment: HistoryExperiment;
  workload: PerformanceWorkload;
}

interface CreatePlanOptions {
  alpha?: number;
  blocks?: number;
  controlHistoryExperiment?: HistoryExperiment;
  metric?: PerformanceMetric;
  minimumImprovementMs?: number;
  minimumImprovementPercent?: number;
  runtime?: "chromium" | "electron";
  samplesPerBlock?: number;
  seed?: number;
  treatmentHistoryExperiment?: HistoryExperiment;
  workload?: PerformanceWorkload;
}

function normalizeBlockOptions(options: CreatePlanOptions) {
  const blocks = options.blocks ?? 8;
  const samplesPerBlock = options.samplesPerBlock ?? 6;
  if (
    !Number.isInteger(blocks) ||
    blocks < 2 ||
    blocks > 16 ||
    blocks % 2 !== 0
  ) {
    throw new Error("blocks must be an even integer from 2 through 16");
  }
  if (!Number.isInteger(samplesPerBlock) || samplesPerBlock < 6) {
    throw new Error("samplesPerBlock must be an integer of at least 6");
  }
  return { blocks, samplesPerBlock };
}

function normalizeAnalysisOptions(options: CreatePlanOptions) {
  const seed = options.seed ?? 1104;
  if (!Number.isInteger(seed) || seed < 0) {
    throw new Error("seed must be a non-negative integer");
  }
  const metric = options.metric ?? "loadReadyMs";
  if (!PERFORMANCE_METRICS.includes(metric)) {
    throw new Error(`Unsupported performance metric: ${metric}`);
  }
  const alpha = options.alpha ?? 0.05;
  if (!(alpha > 0 && alpha < 1)) {
    throw new Error("alpha must be greater than 0 and less than 1");
  }
  const minimumImprovementPercent = options.minimumImprovementPercent ?? 10;
  const minimumImprovementMs = options.minimumImprovementMs ?? 5;
  if (minimumImprovementPercent < 0 || minimumImprovementMs < 0) {
    throw new Error("minimum improvement thresholds must be non-negative");
  }
  return {
    alpha,
    controlHistoryExperiment: options.controlHistoryExperiment ?? "unassigned",
    metric,
    minimumImprovementMs,
    minimumImprovementPercent,
    runtime: options.runtime ?? "chromium",
    seed,
    treatmentHistoryExperiment:
      options.treatmentHistoryExperiment ?? "unassigned",
    workload: options.workload ?? "scale",
  };
}

function normalizePlanOptions(options: CreatePlanOptions): PlanOptions {
  return {
    ...normalizeBlockOptions(options),
    ...normalizeAnalysisOptions(options),
  };
}

export function createPairedPlan(options: CreatePlanOptions = {}): PairedPlan {
  const normalized = normalizePlanOptions(options);
  const orders = shuffled(
    [
      ...Array.from(
        { length: normalized.blocks / 2 },
        () => "control-first" as const
      ),
      ...Array.from(
        { length: normalized.blocks / 2 },
        () => "treatment-first" as const
      ),
    ],
    normalized.seed
  );
  return {
    alpha: normalized.alpha,
    blocks: orders.map((order, index) => ({
      id: `block-${String(index + 1).padStart(2, "0")}`,
      order,
    })),
    controlHistoryExperiment: normalized.controlHistoryExperiment,
    metric: normalized.metric,
    minimumImprovementMs: normalized.minimumImprovementMs,
    minimumImprovementPercent: normalized.minimumImprovementPercent,
    runtime: normalized.runtime,
    samplesPerBlock: normalized.samplesPerBlock,
    seed: normalized.seed,
    treatmentHistoryExperiment: normalized.treatmentHistoryExperiment,
    workload: normalized.workload,
  };
}

function relativeImprovement(control: number, treatment: number): number {
  return control === 0 ? 0 : ((control - treatment) / control) * 100;
}

function exactPermutationPValue(improvements: number[]): number {
  const absolute = improvements.map((value) => Math.abs(value));
  const observed = Math.abs(
    improvements.reduce((total, value) => total + value, 0)
  );
  const combinations = 2 ** improvements.length;
  let atLeastAsExtreme = 0;
  for (let mask = 0; mask < combinations; mask += 1) {
    const signed = absolute.map((value, index) =>
      Math.floor(mask / 2 ** index) % 2 === 1 ? value : -value
    );
    if (
      Math.abs(signed.reduce((total, value) => total + value, 0)) >= observed
    ) {
      atLeastAsExtreme += 1;
    }
  }
  return atLeastAsExtreme / combinations;
}

export function summarizePairedMetric(
  blocks: PairedBlockValues[],
  options: {
    alpha?: number;
    bootstrapIterations?: number;
    minimumImprovementMs?: number;
    minimumImprovementPercent?: number;
    seed?: number;
  } = {}
): PairedMetricSummary {
  if (blocks.length === 0) {
    throw new Error("at least one paired block is required");
  }
  for (const block of blocks) {
    assertNonNegativeValues(block.control, `${block.id}.control`);
    assertNonNegativeValues(block.treatment, `${block.id}.treatment`);
    if (block.control.length !== block.treatment.length) {
      throw new Error(
        `${block.id} must have equal control and treatment samples`
      );
    }
  }
  const control = blocks.flatMap((block) => block.control);
  const treatment = blocks.flatMap((block) => block.treatment);
  const blockImprovementsPercent = blocks.map((block) =>
    relativeImprovement(median(block.control), median(block.treatment))
  );
  const improvementPercent = median(blockImprovementsPercent);
  const iterations = options.bootstrapIterations ?? 2000;
  if (!Number.isInteger(iterations) || iterations < 100) {
    throw new Error("bootstrapIterations must be an integer of at least 100");
  }
  const random = randomGenerator(options.seed ?? 1104);
  const bootstrap = Array.from({ length: iterations }, () => {
    const resampled = Array.from(
      { length: blocks.length },
      () => blocks[Math.floor(random() * blocks.length)]
    );
    return median(
      resampled.map((block) =>
        relativeImprovement(median(block.control), median(block.treatment))
      )
    );
  });
  const bootstrapCi95Percent: [number, number] = [
    percentile(bootstrap, 0.025),
    percentile(bootstrap, 0.975),
  ];
  const alpha = options.alpha ?? 0.05;
  if (!(alpha > 0 && alpha < 1)) {
    throw new Error("alpha must be greater than 0 and less than 1");
  }
  const pValue = exactPermutationPValue(blockImprovementsPercent);
  const minimumImprovementPercent = options.minimumImprovementPercent ?? 10;
  const minimumImprovementMs = options.minimumImprovementMs ?? 5;
  if (minimumImprovementPercent < 0 || minimumImprovementMs < 0) {
    throw new Error("minimum improvement thresholds must be non-negative");
  }
  const absoluteDeltaMs = median(control) - median(treatment);
  let status: PairedMetricSummary["status"] = "inconclusive";
  if (
    pValue <= alpha &&
    bootstrapCi95Percent[0] >= minimumImprovementPercent &&
    absoluteDeltaMs >= minimumImprovementMs
  ) {
    status = "improved";
  } else if (pValue <= alpha && bootstrapCi95Percent[1] < 0) {
    status = "regressed";
  }
  return {
    absoluteDeltaMs,
    alpha,
    blockImprovementsPercent,
    bootstrapCi95Percent,
    control: {
      p50: median(control),
      p95: percentile(control, 0.95),
      samples: control.length,
    },
    improvementPercent,
    minimumImprovementMs,
    minimumImprovementPercent,
    pValue,
    status,
    treatment: {
      p50: median(treatment),
      p95: percentile(treatment, 0.95),
      samples: treatment.length,
    },
  };
}

export function expectedMetricSampleCount(
  metric: PerformanceMetric,
  samples: number,
  workload: PerformanceWorkload
): number {
  if (!Number.isInteger(samples) || samples < 1) {
    throw new Error("samples must be a positive integer");
  }
  if (
    workload !== "scale" &&
    (metric === "switchReadyMs" ||
      metric === "coldSwitchReadyMs" ||
      metric === "warmSwitchReadyMs")
  ) {
    return 0;
  }
  if (metric === "switchReadyMs") {
    return samples * 5;
  }
  if (metric === "coldSwitchReadyMs") {
    return samples * 2;
  }
  if (metric === "warmSwitchReadyMs") {
    return samples * 3;
  }
  if (metric === "panelReadyMs") {
    return samples * 3;
  }
  if (metric === "settingsReadyMs") {
    return samples * 3;
  }
  if (metric === "archiveFirstPageReadyMs") {
    return workload === "history-long" ? samples : 0;
  }
  if (metric === "typingReadyMs") {
    return Math.ceil(samples / 2);
  }
  if (metric === "coldStreamReadyMs") {
    return Math.floor(samples / 2);
  }
  return samples;
}

export function requiredMetricsForWorkload(
  samples: number,
  workload: PerformanceWorkload
): PerformanceMetric[] {
  return PERFORMANCE_METRICS.filter(
    (metric) => expectedMetricSampleCount(metric, samples, workload) > 0
  );
}

/** Guard every produced secondary metric; the declared primary is excluded. */
export function guardrailMetricsForPlan(
  primaryMetric: PerformanceMetric,
  samples: number,
  workload: PerformanceWorkload
): PerformanceMetric[] {
  return PERFORMANCE_METRICS.filter(
    (metric) =>
      metric !== primaryMetric &&
      expectedMetricSampleCount(metric, samples, workload) > 0
  );
}

export function validateMetricCardinality(
  samplesByMetric: Partial<Record<PerformanceMetric, unknown[]>>,
  samples: number,
  workload: PerformanceWorkload
): {
  invalid: PerformanceMetric[];
  missing: PerformanceMetric[];
  valid: boolean;
} {
  const invalid: PerformanceMetric[] = [];
  const missing: PerformanceMetric[] = [];
  for (const metric of PERFORMANCE_METRICS) {
    const expected = expectedMetricSampleCount(metric, samples, workload);
    const values = samplesByMetric[metric];
    if (expected === 0) {
      if (values && values.length > 0) {
        invalid.push(metric);
      }
      continue;
    }
    if (
      !values ||
      values.length !== expected ||
      values.some(
        (value) =>
          typeof value !== "number" || !Number.isFinite(value) || value < 0
      )
    ) {
      missing.push(metric);
    }
  }
  return {
    invalid,
    missing,
    valid: invalid.length === 0 && missing.length === 0,
  };
}

function p95Ratio(control: number[], treatment: number[]): number {
  const controlP95 = percentile(control, 0.95);
  const treatmentP95 = percentile(treatment, 0.95);
  if (controlP95 === 0) {
    return treatmentP95 === 0 ? 1 : Number.POSITIVE_INFINITY;
  }
  return treatmentP95 / controlP95;
}

/**
 * Under "no effect" the control/treatment labels inside a randomized block are
 * exchangeable, so shuffling them gives the null distribution of the pooled p95
 * ratio for exactly these samples (no normality, no pooling across blocks).
 */
export function p95RatioPermutationPValue(
  blocks: readonly { control: number[]; treatment: number[] }[],
  options: { iterations?: number; seed?: number } = {}
): number {
  return ratioPermutationPValue(blocks, p95Ratio, options);
}

function p50Ratio(control: number[], treatment: number[]): number {
  const controlP50 = median(control);
  const treatmentP50 = median(treatment);
  if (controlP50 === 0) {
    return treatmentP50 === 0 ? 1 : Number.POSITIVE_INFINITY;
  }
  return treatmentP50 / controlP50;
}

/**
 * The startup gate's significance: one-sided within-block permutation p-value that the treatment's
 * pooled p50 is slower than the control's (same null model as the p95 guardrails).
 */
export function p50RatioPermutationPValue(
  blocks: readonly { control: number[]; treatment: number[] }[],
  options: { iterations?: number; seed?: number } = {}
): number {
  return ratioPermutationPValue(blocks, p50Ratio, options);
}

function ratioPermutationPValue(
  blocks: readonly { control: number[]; treatment: number[] }[],
  ratio: (control: number[], treatment: number[]) => number,
  options: { iterations?: number; seed?: number } = {}
): number {
  const iterations = options.iterations ?? GUARDRAIL_PERMUTATIONS;
  if (!Number.isInteger(iterations) || iterations < 100) {
    throw new Error(
      "permutation iterations must be an integer of at least 100"
    );
  }
  const observed = ratio(
    blocks.flatMap((block) => block.control),
    blocks.flatMap((block) => block.treatment)
  );
  const random = randomGenerator(options.seed ?? 1104);
  let atLeastAsExtreme = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const control: number[] = [];
    const treatment: number[] = [];
    for (const block of blocks) {
      const pooled = [...block.control, ...block.treatment];
      for (let index = pooled.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        [pooled[index], pooled[swap]] = [pooled[swap], pooled[index]];
      }
      control.push(...pooled.slice(0, block.control.length));
      treatment.push(...pooled.slice(block.control.length));
    }
    if (ratio(control, treatment) >= observed) {
      atLeastAsExtreme += 1;
    }
  }
  return (atLeastAsExtreme + 1) / (iterations + 1);
}

/**
 * A metric fails only when its pooled p95 ratio is above the limit AND that
 * excess is significant after Bonferroni over every declared guardrail metric.
 * The old point-estimate rule failed ~92% of A/A runs (docs/performance-ab.md).
 */
export function summarizeGuardrails(
  blocks: PairedBlockValues[],
  metrics: PerformanceMetric[] = [...INTERACTION_GUARDRAILS],
  options: {
    familyAlpha?: number;
    iterations?: number;
    limit?: number;
    seed?: number;
  } = {}
): TestedGuardrailSummary[] {
  const familyAlpha = options.familyAlpha ?? GUARDRAIL_FAMILY_ALPHA;
  if (!(familyAlpha > 0 && familyAlpha < 1)) {
    throw new Error("familyAlpha must be greater than 0 and less than 1");
  }
  const limit = options.limit ?? P95_GUARDRAIL_LIMIT;
  const adjustedAlpha = familyAlpha / Math.max(1, metrics.length);
  return metrics.map((metric, index) => {
    const paired = blocks
      .map((block) => ({
        control: block.controlMetrics?.[metric] ?? [],
        treatment: block.treatmentMetrics?.[metric] ?? [],
      }))
      .filter(
        (block) => block.control.length > 0 && block.treatment.length > 0
      );
    const control = paired.flatMap((block) => block.control);
    const treatment = paired.flatMap((block) => block.treatment);
    if (control.length === 0 || treatment.length === 0) {
      return {
        adjustedAlpha,
        controlP95: null,
        exceedsLimit: null,
        metric,
        pass: null,
        pValue: null,
        ratio: null,
        treatmentP95: null,
      };
    }
    const ratio = p95Ratio(control, treatment);
    const exceedsLimit = ratio > limit;
    // The test only matters above the limit; skip its cost otherwise.
    const pValue = exceedsLimit
      ? p95RatioPermutationPValue(paired, {
          iterations: options.iterations,
          seed: (options.seed ?? 1104) + index,
        })
      : null;
    return {
      adjustedAlpha,
      controlP95: percentile(control, 0.95),
      exceedsLimit,
      metric,
      pass: !(exceedsLimit && pValue !== null && pValue <= adjustedAlpha),
      pValue,
      ratio,
      treatmentP95: percentile(treatment, 0.95),
    };
  });
}

/** Per-block diagnostics for review; the paired gate uses summarizeGuardrails. */
export function summarizeBlockGuardrails(
  blocks: PairedBlockValues[],
  metrics: PerformanceMetric[] = [...INTERACTION_GUARDRAILS]
): BlockGuardrailSummary[] {
  return blocks.flatMap((block) =>
    metrics.map((metric) => {
      const control = block.controlMetrics?.[metric] ?? [];
      const treatment = block.treatmentMetrics?.[metric] ?? [];
      if (control.length === 0 || treatment.length === 0) {
        return {
          blockId: block.id,
          controlP95: null,
          metric,
          pass: null,
          ratio: null,
          treatmentP95: null,
        };
      }
      const controlP95 = percentile(control, 0.95);
      const treatmentP95 = percentile(treatment, 0.95);
      let ratio: number;
      if (controlP95 === 0) {
        ratio = treatmentP95 === 0 ? 1 : Number.POSITIVE_INFINITY;
      } else {
        ratio = treatmentP95 / controlP95;
      }
      return {
        blockId: block.id,
        controlP95,
        metric,
        pass: ratio <= P95_GUARDRAIL_LIMIT,
        ratio,
        treatmentP95,
      };
    })
  );
}
