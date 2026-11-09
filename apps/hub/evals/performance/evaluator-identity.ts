import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DRIVER_ROOT = resolve(
  resolve(fileURLToPath(new URL(".", import.meta.url))),
  "../../../.."
);
export const REPORT_SCHEMA_VERSION = 11;

/** Keep this order shared by the evaluator report and paired runner. */
export const EVALUATOR_FILES = [
  "apps/hub/evals/performance/run.ts",
  "apps/hub/evals/performance/native-typing.ts",
  "apps/hub/evals/performance/verify-ui.ts",
  "apps/hub/evals/performance/local.mjs",
  "apps/desktop/evals/performance-electron.mjs",
  "apps/hub/evals/performance/evaluator-identity.ts",
] as const;

export const FIXTURE_FILES = [
  "apps/hub/evals/performance/seed.ts",
  "apps/hub/evals/performance/workload.ts",
] as const;

export async function hashOrderedFiles(
  source: string,
  files: readonly string[]
): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    // biome-ignore lint/performance/noAwaitInLoops: Hash order is part of identity.
    hash.update(await readFile(resolve(source, file)));
  }
  return hash.digest("hex");
}

export function hashEvaluatorFiles(source = DRIVER_ROOT): Promise<string> {
  return hashOrderedFiles(source, EVALUATOR_FILES);
}

export function hashFixtureFiles(source = DRIVER_ROOT): Promise<string> {
  return hashOrderedFiles(source, FIXTURE_FILES);
}
