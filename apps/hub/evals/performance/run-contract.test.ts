import { readFile } from "node:fs/promises";
import { expect, it as test } from "vitest";

test("functional verification is after timed route/archive measurements", async () => {
  const source = await readFile(new URL("./run.ts", import.meta.url), "utf8");
  const routeMeasurement = source.indexOf(
    "const routes = await verifyRouteNavigation(page, () => ready(page, 0));"
  );
  const verification = source.indexOf(
    'if (process.env.PERF_VERIFY === "1" && sample === samples - 1)'
  );
  expect(routeMeasurement).toBeGreaterThanOrEqual(0);
  expect(verification).toBeGreaterThan(routeMeasurement);
  expect(source).toContain("const archiveFirstPage = historyPrimary");
  expect(source).not.toContain("uiVerification?.archiveFirstPageReadyMs");
});
