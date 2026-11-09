import { describe, expect, it } from "vitest";
import {
  createPairedPlan,
  expectedMetricSampleCount,
  guardrailMetricsForPlan,
  median,
  p95RatioPermutationPValue,
  percentile,
  summarizeBlockGuardrails,
  summarizeGuardrails,
  summarizePairedMetric,
  validateMetricCardinality,
} from "./paired-stats";

const toArms = (block: {
  controlMetrics?: { streamReadyMs?: number[] };
  treatmentMetrics?: { streamReadyMs?: number[] };
}) => ({
  control: block.controlMetrics?.streamReadyMs ?? [],
  treatment: block.treatmentMetrics?.streamReadyMs ?? [],
});

describe("paired performance plan", () => {
  it("is deterministic and balances treatment order", () => {
    const first = createPairedPlan({ blocks: 4, seed: 42 });
    const second = createPairedPlan({ blocks: 4, seed: 42 });
    expect(first).toEqual(second);
    expect(
      first.blocks.filter((block) => block.order === "control-first")
    ).toHaveLength(2);
    expect(
      first.blocks.filter((block) => block.order === "treatment-first")
    ).toHaveLength(2);
  });

  it("rejects underpowered or unbalanced plans", () => {
    expect(() => createPairedPlan({ blocks: 3 })).toThrow("even integer");
    expect(() => createPairedPlan({ samplesPerBlock: 5 })).toThrow(
      "at least 6"
    );
  });

  it("models the evaluator's cardinality for scale and mixed workloads", () => {
    expect(expectedMetricSampleCount("switchReadyMs", 8, "scale")).toBe(40);
    expect(expectedMetricSampleCount("coldSwitchReadyMs", 8, "scale")).toBe(16);
    expect(expectedMetricSampleCount("warmSwitchReadyMs", 8, "scale")).toBe(24);
    expect(expectedMetricSampleCount("typingReadyMs", 7, "scale")).toBe(4);
    expect(expectedMetricSampleCount("coldStreamReadyMs", 7, "scale")).toBe(3);
    expect(expectedMetricSampleCount("switchReadyMs", 8, "mixed")).toBe(0);
    expect(expectedMetricSampleCount("streamReadyMs", 8, "mixed")).toBe(8);
    expect(expectedMetricSampleCount("switchReadyMs", 8, "history-long")).toBe(
      0
    );
    expect(expectedMetricSampleCount("panelReadyMs", 8, "history-long")).toBe(
      24
    );
    expect(
      expectedMetricSampleCount("archiveFirstPageReadyMs", 8, "history-long")
    ).toBe(8);
    expect(
      expectedMetricSampleCount("archiveFirstPageReadyMs", 8, "scale")
    ).toBe(0);
  });

  it("validates an actual scale report card without dropping guardrails", () => {
    const samplesByMetric = {
      coldStreamReadyMs: [1, 2, 3, 4],
      coldSwitchReadyMs: Array.from({ length: 16 }, () => 1),
      domElements: Array.from({ length: 8 }, () => 1),
      enterChatRouteReadyMs: Array.from({ length: 8 }, () => 1),
      firstByteMs: Array.from({ length: 8 }, () => 1),
      javascriptBytes: Array.from({ length: 8 }, () => 1),
      layoutMs: Array.from({ length: 8 }, () => 1),
      leaveChatRouteReadyMs: Array.from({ length: 8 }, () => 1),
      loadEventMs: Array.from({ length: 8 }, () => 1),
      loadReadyMs: Array.from({ length: 8 }, () => 1),
      longTaskMs: Array.from({ length: 8 }, () => 1),
      panelReadyMs: Array.from({ length: 24 }, () => 1),
      responseEndMs: Array.from({ length: 8 }, () => 1),
      returnChatRouteReadyMs: Array.from({ length: 8 }, () => 1),
      scriptMs: Array.from({ length: 8 }, () => 1),
      settingsReadyMs: Array.from({ length: 24 }, () => 1),
      streamReadyMs: Array.from({ length: 8 }, () => 1),
      styleMs: Array.from({ length: 8 }, () => 1),
      switchReadyMs: Array.from({ length: 40 }, () => 1),
      taskMs: Array.from({ length: 8 }, () => 1),
      typingReadyMs: Array.from({ length: 4 }, () => 1),
      warmSwitchReadyMs: Array.from({ length: 24 }, () => 1),
    };
    expect(validateMetricCardinality(samplesByMetric, 8, "scale")).toEqual({
      invalid: [],
      missing: [],
      valid: true,
    });
    expect(
      validateMetricCardinality(
        {
          ...samplesByMetric,
          panelReadyMs: Array.from({ length: 8 }, () => 1),
        },
        8,
        "scale"
      ).valid
    ).toBe(false);
  });

  it("guards secondary primary metrics, including initial load and archive", () => {
    const archivePrimary = guardrailMetricsForPlan(
      "archiveFirstPageReadyMs",
      8,
      "history-long"
    );
    expect(archivePrimary).toContain("loadReadyMs");
    expect(archivePrimary).not.toContain("archiveFirstPageReadyMs");
    const loadPrimary = guardrailMetricsForPlan("loadReadyMs", 8, "scale");
    expect(loadPrimary).not.toContain("loadReadyMs");
    expect(loadPrimary).not.toContain("archiveFirstPageReadyMs");
  });
});

describe("paired performance statistics", () => {
  it("uses nearest-rank p50 and p95 values", () => {
    expect(median([1, 4, 2])).toBe(2);
    expect(percentile([1, 4, 2, 8], 0.95)).toBe(8);
  });

  it("reports a clear paired improvement with deterministic uncertainty", () => {
    const blocks = Array.from({ length: 8 }, (_, index) => ({
      control: [
        100 + index,
        101 + index,
        102 + index,
        103 + index,
        104 + index,
        105 + index,
      ],
      id: `block-${index}`,
      order:
        index % 2 === 0
          ? ("control-first" as const)
          : ("treatment-first" as const),
      treatment: [
        50 + index,
        51 + index,
        52 + index,
        53 + index,
        54 + index,
        55 + index,
      ],
    }));
    const summary = summarizePairedMetric(blocks, {
      bootstrapIterations: 500,
      seed: 7,
    });
    expect(summary.status).toBe("improved");
    expect(summary.improvementPercent).toBeGreaterThan(40);
    expect(summary.bootstrapCi95Percent[0]).toBeGreaterThan(0);
    expect(summary.pValue).toBeLessThanOrEqual(0.125);
  });

  it("keeps a four-block result inconclusive at alpha .05", () => {
    const blocks = Array.from({ length: 4 }, (_, index) => ({
      control: [100, 100],
      id: `block-${index}`,
      order: "control-first" as const,
      treatment: [50, 50],
    }));
    const summary = summarizePairedMetric(blocks, {
      bootstrapIterations: 500,
    });
    expect(summary.pValue).toBeGreaterThan(0.05);
    expect(summary.status).toBe("inconclusive");
  });

  it("requires both the relative and absolute practical effect thresholds", () => {
    const blocks = Array.from({ length: 8 }, (_, index) => ({
      control: [100 + index, 100 + index],
      id: `block-${index}`,
      order: "control-first" as const,
      treatment: [98 + index, 98 + index],
    }));
    const summary = summarizePairedMetric(blocks, {
      bootstrapIterations: 500,
    });
    expect(summary.pValue).toBeLessThanOrEqual(0.05);
    expect(summary.improvementPercent).toBeLessThan(10);
    expect(summary.absoluteDeltaMs).toBeLessThan(5);
    expect(summary.status).toBe("inconclusive");
  });

  it("keeps uncertain effects inconclusive", () => {
    const summary = summarizePairedMetric(
      [
        {
          control: [100, 100],
          id: "a",
          order: "control-first",
          treatment: [90, 90],
        },
        {
          control: [100, 100],
          id: "b",
          order: "treatment-first",
          treatment: [110, 110],
        },
      ],
      { bootstrapIterations: 500 }
    );
    expect(summary.status).toBe("inconclusive");
  });

  const blocksOf = (
    control: (block: number, sample: number) => number,
    treatment: (block: number, sample: number) => number,
    samples = 6
  ) =>
    Array.from({ length: 4 }, (__, block) => ({
      control: [1],
      controlMetrics: {
        streamReadyMs: Array.from({ length: samples }, (_, sample) =>
          control(block, sample)
        ),
      },
      id: `block-${block}`,
      order: "control-first" as const,
      treatment: [1],
      treatmentMetrics: {
        streamReadyMs: Array.from({ length: samples }, (_, sample) =>
          treatment(block, sample)
        ),
      },
    }));

  it("fails a p95 excess only when it is significant", () => {
    const [guardrail] = summarizeGuardrails(
      blocksOf(
        (b, i) => 100 + b + i,
        (b, i) => 150 + b + i
      ),
      ["streamReadyMs"],
      { iterations: 500 }
    );
    expect(guardrail).toMatchObject({
      adjustedAlpha: 0.05,
      exceedsLimit: true,
      metric: "streamReadyMs",
      pass: false,
    });
    expect(guardrail?.pValue).toBeLessThanOrEqual(0.05);
  });

  it("only warns about a p95 excess that sampling noise explains", () => {
    const [guardrail] = summarizeGuardrails(
      [
        {
          control: [100, 100],
          controlMetrics: { streamReadyMs: [100, 100] },
          id: "a",
          order: "control-first",
          treatment: [90, 90],
          treatmentMetrics: { streamReadyMs: [120, 120] },
        },
      ],
      ["streamReadyMs"],
      { iterations: 500 }
    );
    expect(guardrail).toMatchObject({
      controlP95: 100,
      exceedsLimit: true,
      pass: true,
      ratio: 1.2,
      treatmentP95: 120,
    });
    expect(guardrail?.pValue).toBeGreaterThan(0.05);
  });

  it("splits the family alpha across every declared guardrail metric", () => {
    const guardrails = summarizeGuardrails(
      blocksOf(
        (b, i) => 100 + b + i,
        (b, i) => 150 + b + i
      ),
      ["streamReadyMs", "typingReadyMs"],
      { iterations: 500 }
    );
    expect(guardrails[0]?.adjustedAlpha).toBe(0.025);
    expect(guardrails[1]).toMatchObject({ pass: null, pValue: null });
  });

  it("skips the test below the limit and is deterministic per seed", () => {
    const same = blocksOf(
      (b, i) => 100 + ((b * 7 + i * 3) % 11),
      (b, i) => 100 + ((b * 5 + i * 2) % 11)
    );
    expect(summarizeGuardrails(same, ["streamReadyMs"])[0]).toMatchObject({
      exceedsLimit: false,
      pass: true,
      pValue: null,
    });
    const noisy = blocksOf(
      (b, i) => 100 + ((b * 7 + i * 13) % 17),
      (b, i) => 104 + ((b * 5 + i * 11) % 19)
    );
    expect(p95RatioPermutationPValue(noisy.map(toArms), { seed: 7 })).toBe(
      p95RatioPermutationPValue(noisy.map(toArms), { seed: 7 })
    );
  });

  it("keeps the A/A false-positive rate near the family alpha", () => {
    // Identical distributions, 12 samples per arm like the CI canary's typing metric.
    let failures = 0;
    for (let run = 0; run < 40; run += 1) {
      const value = (b: number, i: number, arm: number) =>
        100 + ((run * 31 + b * 17 + i * 7 + arm * 13) % 37);
      const [guardrail] = summarizeGuardrails(
        blocksOf(
          (b, i) => value(b, i, 0),
          (b, i) => value(b, i, 1),
          3
        ),
        ["streamReadyMs"],
        { iterations: 200, seed: run }
      );
      failures += guardrail?.pass === false ? 1 : 0;
    }
    expect(failures).toBeLessThanOrEqual(4);
  });

  it("records per-block p95 ratios without changing aggregate guardrails", () => {
    expect(
      summarizeBlockGuardrails(
        [
          {
            control: [100, 100],
            controlMetrics: { streamReadyMs: [100, 100] },
            id: "block-01",
            order: "control-first",
            treatment: [90, 90],
            treatmentMetrics: { streamReadyMs: [120, 120] },
          },
        ],
        ["streamReadyMs"]
      )
    ).toEqual([
      {
        blockId: "block-01",
        controlP95: 100,
        metric: "streamReadyMs",
        pass: false,
        ratio: 1.2,
        treatmentP95: 120,
      },
    ]);
  });

  it("treats zero control latency as a real guardrail edge case", () => {
    expect(
      summarizeGuardrails(
        [
          {
            control: [0, 0],
            controlMetrics: { streamReadyMs: [0, 0] },
            id: "positive-treatment",
            order: "control-first",
            treatment: [1, 1],
            treatmentMetrics: { streamReadyMs: [1, 1] },
          },
        ],
        ["streamReadyMs"]
      )[0]
    ).toMatchObject({ exceedsLimit: true, ratio: Number.POSITIVE_INFINITY });
    expect(
      summarizeGuardrails(
        [
          {
            control: [0, 0],
            controlMetrics: { streamReadyMs: [0, 0] },
            id: "both-zero",
            order: "control-first",
            treatment: [0, 0],
            treatmentMetrics: { streamReadyMs: [0, 0] },
          },
        ],
        ["streamReadyMs"]
      )[0]
    ).toMatchObject({ pass: true, ratio: 1 });
  });
});

describe("p50RatioPermutationPValue", () => {
  it("is small for a consistent slowdown and large for none", async () => {
    const { p50RatioPermutationPValue } = await import("./paired-stats");
    const block = (shift: number) => ({
      control: [700, 710, 690, 705, 695, 702],
      treatment: [700, 710, 690, 705, 695, 702].map((v) => v + shift),
    });
    const slower = [block(120), block(110), block(130), block(115)];
    expect(p50RatioPermutationPValue(slower, { seed: 1 })).toBeLessThan(0.01);
    const same = [block(0), block(0), block(0), block(0)];
    expect(p50RatioPermutationPValue(same, { seed: 1 })).toBeGreaterThan(0.3);
  });
});
