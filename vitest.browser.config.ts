import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./apps/hub", import.meta.url)) },
  },
  test: {
    exclude: ["**/node_modules/**", "**/.next/**"],
    include: [
      "apps/hub/evals/performance/archive-probe.browser.test.ts",
      "apps/hub/evals/performance/native-typing.browser.test.ts",
      "apps/hub/evals/performance/production-visibility.browser.test.ts",
    ],
  },
});
