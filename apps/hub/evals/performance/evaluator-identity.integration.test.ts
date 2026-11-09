import { readFile } from "node:fs/promises";
import { expect, it as test } from "vitest";
import { hashEvaluatorFiles, hashFixtureFiles } from "./evaluator-identity";

test("matches an actual evaluator report to the source identity hash", async () => {
  const reportPath = process.env.PERF_IDENTITY_REPORT;
  if (!reportPath) {
    throw new Error(
      "PERF_IDENTITY_REPORT is required for this integration test"
    );
  }
  const report = JSON.parse(await readFile(reportPath, "utf8")) as {
    evaluatorHash?: string;
    fixtureHash?: string;
  };
  expect(report.evaluatorHash).toBe(await hashEvaluatorFiles());
  expect(report.fixtureHash).toBe(await hashFixtureFiles());
});
