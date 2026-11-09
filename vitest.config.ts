import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Components format with the user's locale. Pin the test workers' locale so date and
// percentage assertions match on every machine, not only on en-US ones.
process.env.LC_ALL = "en_US.UTF-8";
process.env.LANG = "en_US.UTF-8";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./apps/hub", import.meta.url)) },
  },
  test: {
    // eve builds copy workspace resources into these directories. Test the authored
    // sources once, rather than collecting generated copies after a bot/hub build.
    exclude: [
      "**/node_modules/**",
      "**/.eve/**",
      "**/.output/**",
      "**/.next/**",
      "**/*.integration.test.ts",
      "**/*.browser.test.ts",
    ],
    include: [
      "apps/**/*.test.{ts,tsx}",
      "templates/**/*.test.ts",
      "images/**/*.test.ts",
    ],
  },
});
