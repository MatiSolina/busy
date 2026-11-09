import { describe, expect, it } from "vitest";
import {
  ciHistoryConfig,
  evaluateGuardOnly,
  historyPrimaryEnv,
  validateCiReport,
} from "./ci-paired-core";
import { createPairedPlan } from "./paired-stats";

const fixture = {
  bots: 1,
  factsPerTurn: 6,
  name: "mixed",
  sessionsPerBot: 3,
  turnsPerSession: 103,
};
const identity = {
  evaluatorHash: "evaluator",
  fixture,
  fixtureHash: "fixture",
  historyExperiment: "unassigned",
  runtime: "chromium",
  samples: 6,
  schemaVersion: 11,
  sourcePatchHash: "patch",
  sourceRef: "abc123",
};
const environment = {
  arch: "x64",
  browser: "chromium",
  cpu: "test cpu",
  node: "v22.0.0",
  platform: "linux",
};
const validMetrics = {
  coldStreamReadyMs: { samples: [1, 2, 3] },
  enterChatRouteReadyMs: { samples: [1, 2, 3, 4, 5, 6] },
  leaveChatRouteReadyMs: { samples: [1, 2, 3, 4, 5, 6] },
  loadReadyMs: { samples: [10, 11, 12, 13, 14, 15] },
  panelReadyMs: { samples: Array.from({ length: 18 }, () => 1) },
  returnChatRouteReadyMs: { samples: [1, 2, 3, 4, 5, 6] },
  settingsReadyMs: { samples: Array.from({ length: 18 }, () => 1) },
  streamReadyMs: { samples: [1, 2, 3, 4, 5, 6] },
  typingReadyMs: { samples: [1, 2, 3] },
};

function report(overrides: Record<string, unknown> = {}) {
  return {
    ...identity,
    environment,
    metrics: validMetrics,
    ...overrides,
  };
}

function expected(environmentOverride = environment) {
  return { ...identity, environment: environmentOverride };
}

describe("CI paired canary contract", () => {
  it("enables archive primary measurement only for history-long", () => {
    expect(historyPrimaryEnv("history-long")).toBe("1");
    expect(historyPrimaryEnv("scale")).toBe("0");
    expect(historyPrimaryEnv("mixed")).toBe("0");
  });

  it("uses the paged first-page contract for both normal CI arms", () => {
    expect(ciHistoryConfig("scale")).toEqual({
      expectedArchiveSessions: "1",
      experiment: "paged-manual",
      primary: "0",
    });
    expect(ciHistoryConfig("mixed")).toEqual({
      expectedArchiveSessions: "1",
      experiment: "paged-manual",
      primary: "0",
    });
    expect(ciHistoryConfig("history-long")).toEqual({
      expectedArchiveSessions: "1",
      experiment: "paged-manual",
      primary: "1",
    });
  });

  it("creates a fixed balanced order with two blocks per direction", () => {
    const plan = createPairedPlan({
      blocks: 4,
      samplesPerBlock: 6,
      seed: 1104,
    });
    expect(plan.blocks).toHaveLength(4);
    expect(
      plan.blocks.filter(({ order }) => order === "control-first")
    ).toHaveLength(2);
    expect(
      plan.blocks.filter(({ order }) => order === "treatment-first")
    ).toHaveLength(2);
  });

  it("rejects source identity and top-level sample-count mismatches", () => {
    const sourceMismatch = validateCiReport(
      report({ sourceRef: "different" }),
      expected(),
      "mixed"
    );
    expect(sourceMismatch.valid).toBe(false);
    expect(sourceMismatch.errors).toContain("sourceRef mismatch");

    const countMismatch = validateCiReport(
      report({ samples: 7 }),
      expected(),
      "mixed"
    );
    expect(countMismatch.valid).toBe(false);
    expect(countMismatch.errors).toContain("samples mismatch");
  });

  it("rejects missing and non-finite metric samples", () => {
    const missing = validateCiReport(
      report({
        metrics: { ...validMetrics, streamReadyMs: undefined },
      }),
      expected(),
      "mixed"
    );
    expect(missing.valid).toBe(false);
    expect(missing.errors.join(" ")).toContain("streamReadyMs");

    const nonFinite = validateCiReport(
      report({
        metrics: {
          ...validMetrics,
          streamReadyMs: { samples: [1, 2, 3, 4, 5, Number.NaN] },
        },
      }),
      expected(),
      "mixed"
    );
    expect(nonFinite.valid).toBe(false);
    expect(nonFinite.errors.join(" ")).toContain("streamReadyMs");
  });

  it("returns a neutral guard-only decision without a winner claim", () => {
    expect(
      evaluateGuardOnly({
        controlP50: 100,
        guardrails: [{ metric: "streamReadyMs", pass: true }],
        targetSpeedup: 0.91,
        treatmentP50: 109,
        valid: true,
      })
    ).toEqual({
      decision: "neutral",
      failures: [],
      startupPass: true,
      startupSpeedup: 100 / 109,
      warnings: [],
    });
  });

  it("returns regressed for a startup target or p95 guard failure", () => {
    const startup = evaluateGuardOnly({
      controlP50: 100,
      guardrails: [{ metric: "streamReadyMs", pass: true }],
      targetSpeedup: 0.91,
      treatmentP50: 120,
      valid: true,
    });
    expect(startup.decision).toBe("regressed");
    expect(startup.startupPass).toBe(false);

    const guardrail = evaluateGuardOnly({
      controlP50: 100,
      guardrails: [
        {
          adjustedAlpha: 0.006_25,
          exceedsLimit: true,
          metric: "streamReadyMs",
          pass: false,
          pValue: 0.001,
          ratio: 1.4,
        },
      ],
      targetSpeedup: 0.91,
      treatmentP50: 100,
      valid: true,
    });
    expect(guardrail.decision).toBe("regressed");
    expect(guardrail.failures).toEqual([
      "streamReadyMs p95 exceeded the 10% guardrail (ratio 1.400, permutation p=0.0010, threshold 0.0063)",
    ]);
  });

  it("warns without failing when a p95 excess is not significant", () => {
    const evaluation = evaluateGuardOnly({
      controlP50: 100,
      guardrails: [
        {
          adjustedAlpha: 0.006_25,
          exceedsLimit: true,
          metric: "coldStreamReadyMs",
          pass: true,
          pValue: 0.1159,
          ratio: 1.343,
        },
      ],
      targetSpeedup: 0.91,
      treatmentP50: 100,
      valid: true,
    });
    expect(evaluation.decision).toBe("neutral");
    expect(evaluation.warnings).toEqual([
      "coldStreamReadyMs p95 above 1.10 but not significant (ratio 1.343, permutation p=0.1159, threshold 0.0063); rerun if it reproduces",
    ]);
  });
});

describe("startup gate significance", () => {
  const base = {
    controlP50: 700,
    guardrails: [],
    targetSpeedup: 0.91,
    treatmentP50: 790,
    valid: true,
  };

  it("fails a significant startup slowdown", () => {
    const result = evaluateGuardOnly({ ...base, startupPValue: 0.01 });
    expect(result.decision).toBe("regressed");
    expect(result.failures[0]).toContain("permutation p=0.0100");
  });

  it("only warns when the slowdown is not significant", () => {
    const result = evaluateGuardOnly({ ...base, startupPValue: 0.38 });
    expect(result.decision).toBe("neutral");
    expect(result.startupPass).toBe(true);
    expect(result.warnings[0]).toContain("not significant");
  });

  it("keeps the point-estimate rule without a p-value", () => {
    expect(evaluateGuardOnly(base).decision).toBe("regressed");
  });
});
