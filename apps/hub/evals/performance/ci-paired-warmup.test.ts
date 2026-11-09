import { readFile } from "node:fs/promises";
import { expect, it as test } from "vitest";

test("warms both arms before the first scored block", async () => {
  const source = await readFile(
    new URL("./ci-paired.ts", import.meta.url),
    "utf8"
  );
  const warmup = source.indexOf(
    'for (const variant of ["control", "treatment"] as const)'
  );
  const scored = source.indexOf("for (const block of plan.blocks)");
  expect(warmup).toBeGreaterThanOrEqual(0);
  expect(scored).toBeGreaterThan(warmup);
});
