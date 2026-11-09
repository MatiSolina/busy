import { fileURLToPath } from "node:url";
import { withDurableHarness } from "durable-harness/next";
import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";
import { browserCompileHints } from "./scripts/compile-hints.ts";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    // Streamdown's merger uses cn's documented compatibility export so the
    // browser shares the same class engine as the rest of the interface.
    resolveAlias: {
      "tailwind-merge": "cn",
    },
  },
  webpack(config, { dev, isServer, webpack }) {
    return {
      ...config,
      output: {
        ...config.output,
        environment: { ...config.output.environment, asyncFunction: true },
      },
      plugins: [
        ...(config.plugins ?? []),
        ...browserCompileHints({ dev, isServer, webpack }),
      ],
      resolve: {
        ...config.resolve,
        alias: {
          ...config.resolve.alias,
          // next/dynamic's weak SSR lookup cannot resolve this import-only export.
          streamdown$: fileURLToPath(
            new URL("./node_modules/streamdown/dist/index.js", import.meta.url)
          ),
          "tailwind-merge": "cn",
        },
      },
    };
  },
};

export default withWorkflow(
  withDurableHarness(nextConfig, {
    agents: ["lib/code-tasks/runtime.ts"],
    flowRoute: false,
  })
);
