import { defineEvalConfig } from "eve/evals";

// Semantic assertions are regression signals. Keep the hard gates in the
// evals themselves deterministic so a missing Gateway credential never hides
// a broken protocol contract.
export default defineEvalConfig({
  judge: { model: "typesafe-ai/jev" },
  maxConcurrency: 1,
  timeoutMs: 120_000,
});
