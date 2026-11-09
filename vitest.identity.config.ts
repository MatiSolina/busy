import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./apps/hub", import.meta.url)) },
  },
  test: {
    include: [
      "apps/hub/evals/performance/evaluator-identity.integration.test.ts",
    ],
  },
});
