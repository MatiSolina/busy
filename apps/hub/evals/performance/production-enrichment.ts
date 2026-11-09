import {
  isValidPreflightFailure,
  isValidSourceSample,
  type ProductionPreflightFailure,
  type ProductionSourceSample,
} from "./production-config";

export type EnrichmentSourceSample =
  | { kind: "preflight_failure"; sample: ProductionPreflightFailure }
  | { kind: "trace"; sample: ProductionSourceSample };

export function classifyEnrichmentSourceSample(
  value: unknown
): EnrichmentSourceSample | null {
  if (isValidSourceSample(value)) {
    return { kind: "trace", sample: value };
  }
  if (isValidPreflightFailure(value)) {
    return { kind: "preflight_failure", sample: value };
  }
  return null;
}

export function preservePreflightFailure(sample: ProductionPreflightFailure): {
  bot: ProductionPreflightFailure["bot"];
  failureCode: "preflight_failed";
  failurePhase: string | null;
  messageId: null;
  outcome: "failed";
} {
  return {
    bot: sample.bot,
    failureCode: sample.failureCode,
    failurePhase: sample.failurePhase ?? null,
    messageId: null,
    outcome: sample.outcome,
  };
}
