import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyPerformanceScope,
  performanceScopeArtifact,
} from "./performance-scope.mjs";

test("chat SSE persistence changes select backend contracts and skip synthetic UI timing", () => {
  const scope = classifyPerformanceScope([
    "apps/hub/app/api/bots/[slug]/events/route.ts",
    "apps/hub/app/api/consultations/[id]/events/route.ts",
    "apps/hub/lib/chat/sse.ts",
    "apps/hub/lib/eve/client.ts",
    "apps/hub/lib/chat/sse.test.ts",
    "apps/hub/evals/performance/stream-persistence-ab.ts",
  ]);
  assert.equal(scope.mode, "backend");
  assert.equal(scope.uiRequired, false);
  assert.equal(scope.backendRequired, true);
  assert.ok(scope.backendTests.includes("apps/hub/lib/chat/sse.test.ts"));
});

test("the complete stream-persistence change is mixed because chat store data is client-visible", () => {
  const scope = classifyPerformanceScope([
    "apps/hub/app/api/bots/[slug]/events/route.ts",
    "apps/hub/app/api/consultations/[id]/events/route.ts",
    "apps/hub/chat-observability.test.ts",
    "apps/hub/chat-store-consultation.test.ts",
    "apps/hub/evals/performance/stream-persistence-ab-worker.ts",
    "apps/hub/evals/performance/stream-persistence-ab.ts",
    "apps/hub/lib/chat/observability.ts",
    "apps/hub/lib/chat/sse.test.ts",
    "apps/hub/lib/chat/sse.ts",
    "apps/hub/lib/chat/store.ts",
    "apps/hub/lib/eve/client.test.ts",
    "apps/hub/lib/eve/client.ts",
  ]);
  assert.equal(scope.mode, "mixed");
  assert.equal(scope.uiRequired, true);
  assert.equal(scope.backendRequired, true);
});

test("cross-flow telemetry changes select operation contracts and skip UI timing", () => {
  const scope = classifyPerformanceScope([
    "apps/hub/lib/operation-observability.ts",
    "apps/hub/operation-observability.test.ts",
    "apps/hub/lib/code-tasks/providers.ts",
    "apps/hub/lib/firesides/runtime.ts",
    "apps/hub/lib/live.ts",
    "apps/hub/lib/library-objects.ts",
    "apps/hub/lib/routines/monitor.ts",
  ]);
  assert.equal(scope.mode, "backend");
  assert.equal(scope.uiRequired, false);
  assert.equal(scope.backendRequired, true);
  assert.ok(
    scope.backendTests.includes("apps/hub/operation-observability.test.ts")
  );
  assert.ok(scope.backendTests.includes("apps/hub/firesides-database.test.ts"));
  assert.ok(
    scope.backendTests.includes("apps/hub/lib/firesides/metadata.test.ts")
  );
});

test("metadata-only chat trace changes select backend contracts", () => {
  const scope = classifyPerformanceScope([
    "apps/hub/app/api/bots/[slug]/messages/[id]/trace/route.ts",
    "apps/hub/lib/chat/observability.ts",
    "apps/hub/chat-trace-route.test.ts",
  ]);
  assert.equal(scope.mode, "backend");
  assert.equal(scope.uiRequired, false);
  assert.equal(scope.backendRequired, true);
  assert.ok(scope.backendTests.includes("apps/hub/chat-observability.test.ts"));
  assert.ok(scope.backendTests.includes("apps/hub/chat-events-route.test.ts"));
});

test("the complete cross-flow lifecycle change is mixed because state and route contracts are client-visible", () => {
  const scope = classifyPerformanceScope([
    "apps/hub/app/api/bots/[slug]/live/route.ts",
    "apps/hub/app/api/bots/[slug]/route.ts",
    "apps/hub/app/api/dev/live/[slug]/route.ts",
    "apps/hub/lib/chat/send.ts",
    "apps/hub/lib/code-tasks/providers.test.ts",
    "apps/hub/lib/code-tasks/providers.ts",
    "apps/hub/lib/firesides/metadata.test.ts",
    "apps/hub/lib/firesides/metadata.ts",
    "apps/hub/lib/firesides/project.ts",
    "apps/hub/lib/firesides/runtime.ts",
    "apps/hub/lib/firesides/state.ts",
    "apps/hub/lib/firesides/types.ts",
    "apps/hub/lib/library-objects.ts",
    "apps/hub/lib/live.ts",
    "apps/hub/lib/operation-observability.test.ts",
    "apps/hub/lib/operation-observability.ts",
    "apps/hub/lib/routines/dispatch.ts",
    "apps/hub/lib/routines/monitor.ts",
    "apps/hub/live-control-route.test.ts",
    "apps/hub/operation-observability.test.ts",
    "docs/operation-observability.md",
  ]);
  assert.equal(scope.mode, "mixed");
  assert.equal(scope.uiRequired, true);
  assert.equal(scope.backendRequired, true);
});

test("chat-pane and client history changes require browser timing plus backend checks when mixed", () => {
  const scope = classifyPerformanceScope([
    "apps/hub/components/chat-pane.tsx",
    "apps/hub/lib/chat/client-store.ts",
    "apps/hub/app/api/bots/[slug]/events/route.ts",
  ]);
  assert.equal(scope.mode, "mixed");
  assert.equal(scope.uiRequired, true);
  assert.equal(scope.backendRequired, true);
});

test("unknown application or tooling paths fail closed to UI performance", () => {
  for (const path of [
    "apps/hub/app/(new-area)/page.tsx",
    "apps/hub/lib/new-runtime-seam.ts",
    ".github/workflows/performance.yml",
    "package.json",
  ]) {
    const scope = classifyPerformanceScope([path]);
    assert.equal(scope.uiRequired, true, path);
  }
});

test("docs and policy-only edits do not invent a UI measurement", () => {
  const scope = classifyPerformanceScope([
    "docs/performance.md",
    ".github/scripts/performance-scope.mjs",
  ]);
  assert.equal(scope.mode, "docs");
  assert.equal(scope.uiRequired, false);
  assert.equal(scope.backendRequired, false);
});

test("manual runs remain full coverage", () => {
  const scope = classifyPerformanceScope([], {
    eventName: "workflow_dispatch",
  });
  assert.equal(scope.mode, "full");
  assert.equal(scope.uiRequired, true);
  assert.equal(scope.backendRequired, true);
});

test("backend-only reports retain the UI result as an unexercised seam", () => {
  const scope = classifyPerformanceScope([
    "apps/hub/lib/chat/sse.ts",
    "apps/hub/lib/eve/client.ts",
  ]);
  const artifact = performanceScopeArtifact(scope, {
    baseSha: "a".repeat(40),
    baseStale: true,
    candidateSha: "b".repeat(40),
    declaredBaseSha: "c".repeat(40),
  });
  assert.equal(artifact.uiMeasurement, "unexercised_seam");
  assert.equal(artifact.unexercisedSeam, true);
  assert.equal(artifact.baseSha, "a".repeat(40));
  assert.equal(artifact.baseStale, true);
  assert.equal(artifact.candidateSha, "b".repeat(40));
  assert.equal(artifact.declaredBaseSha, "c".repeat(40));
  assert.equal(artifact.mergeParentBaseSha, "a".repeat(40));
  assert.equal(artifact.payloadBaseSha, "c".repeat(40));
});
