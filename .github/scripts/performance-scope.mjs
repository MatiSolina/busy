import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const SERVER_SEAM_FILES = new Set([
  "apps/hub/app/api/bots/[slug]/events/route.ts",
  "apps/hub/app/api/bots/[slug]/messages/[id]/trace/route.ts",
  "apps/hub/app/api/consultations/[id]/events/route.ts",
  "apps/hub/lib/chat/observability.ts",
  "apps/hub/lib/chat/sse.ts",
  "apps/hub/lib/chat/sse.test.ts",
  "apps/hub/lib/eve/client.ts",
  "apps/hub/lib/eve/client.test.ts",
  "apps/hub/chat-store-consultation.test.ts",
  "apps/hub/chat-events-route.test.ts",
  "apps/hub/chat-observability.test.ts",
  "apps/hub/chat-trace-route.test.ts",
  "apps/hub/evals/performance/stream-persistence-ab.ts",
  "apps/hub/evals/performance/stream-persistence-ab-worker.ts",
]);

const CROSS_FLOW_FILES = [
  /^apps\/hub\/lib\/operation-observability(?:\.test)?\.ts$/u,
  /^apps\/hub\/lib\/code-tasks\/providers(?:\.test)?\.ts$/u,
  /^apps\/hub\/lib\/firesides\/(?:metadata|runtime)(?:\.test)?\.ts$/u,
  /^apps\/hub\/lib\/library-objects(?:\.test)?\.ts$/u,
  /^apps\/hub\/lib\/live(?:\.test)?\.ts$/u,
  /^apps\/hub\/lib\/routines\/(?:dispatch|monitor)(?:\.test)?\.ts$/u,
  /^apps\/hub\/(?:operation-observability|live-control-route|firesides-database|routine-monitor-database|routines-database|library-objects-database)\.test\.ts$/u,
];

const UI_FILES = [
  /^apps\/hub\/components\//u,
  /^apps\/hub\/app\/(?!api\/)/u,
  /^apps\/hub\/lib\/chat\/(?:client-store|items|initial|markdown|projection|store|sync|model-errors|quick-replies)/u,
  /^apps\/hub\/lib\/firesides\/(?:project|state|types)(?:\.test)?\.ts$/u,
  /^apps\/hub\/evals\/performance\/(?!stream-persistence-)/u,
  /^apps\/hub\/(?:next\.config\.ts|postcss\.config\.mjs)$/u,
  /^apps\/hub\/package\.json$/u,
  /^pnpm-lock\.yaml$/u,
  /^patches\//u,
];

const IGNORED_FILES = [
  /^docs\//u,
  /^README(?:\..*)?$/u,
  /^\.github\/scripts\/performance-scope(?:\.test)?\.mjs$/u,
];

const BACKEND_TESTS = {
  chat: [
    "apps/hub/lib/chat/sse.test.ts",
    "apps/hub/lib/eve/client.test.ts",
    "apps/hub/chat-store-consultation.test.ts",
    "apps/hub/chat-observability.test.ts",
    "apps/hub/chat-trace-route.test.ts",
    "apps/hub/chat-events-route.test.ts",
  ],
  crossFlow: [
    "apps/hub/operation-observability.test.ts",
    "apps/hub/lib/code-tasks/providers.test.ts",
    "apps/hub/lib/firesides/metadata.test.ts",
    "apps/hub/live-control-route.test.ts",
    "apps/hub/firesides-database.test.ts",
    "apps/hub/routine-monitor-database.test.ts",
    "apps/hub/routines-database.test.ts",
    "apps/hub/library-objects-database.test.ts",
  ],
};

function matchesAny(path, patterns) {
  return patterns.some((pattern) => pattern.test(path));
}

function isServerSeam(path) {
  return SERVER_SEAM_FILES.has(path) || matchesAny(path, CROSS_FLOW_FILES);
}

function isIgnored(path) {
  return matchesAny(path, IGNORED_FILES);
}

export function classifyPerformanceScope(
  paths,
  { eventName = "pull_request" } = {}
) {
  if (eventName !== "pull_request") {
    return {
      backendRequired: true,
      backendTests: [
        ...new Set([...BACKEND_TESTS.chat, ...BACKEND_TESTS.crossFlow]),
      ],
      changedPaths: [],
      mode: "full",
      reason:
        "Manual or non-PR execution requires the complete performance suite.",
      uiRequired: true,
    };
  }

  const changedPaths = paths.filter((path) => !isIgnored(path));
  const serverPaths = changedPaths.filter(isServerSeam);
  const unknownPaths = changedPaths.filter(
    (path) => !(isServerSeam(path) || matchesAny(path, UI_FILES))
  );
  const uiPaths = changedPaths.filter(
    (path) => matchesAny(path, UI_FILES) || unknownPaths.includes(path)
  );
  const backendTests = [
    ...(serverPaths.some((path) => SERVER_SEAM_FILES.has(path))
      ? BACKEND_TESTS.chat
      : []),
    ...(serverPaths.some((path) => matchesAny(path, CROSS_FLOW_FILES))
      ? BACKEND_TESTS.crossFlow
      : []),
  ].filter((path, index, all) => all.indexOf(path) === index);
  const backendRequired = serverPaths.length > 0;
  const uiRequired = uiPaths.length > 0;
  let mode = "docs";
  if (uiRequired && backendRequired) {
    mode = "mixed";
  } else if (uiRequired) {
    mode = "ui";
  } else if (backendRequired) {
    mode = "backend";
  }
  let reason = "No performance-relevant source path changed.";
  if (mode === "backend") {
    reason =
      "All changed source paths belong to an allowlisted server seam; UI fixture timing does not exercise them.";
  } else if (mode === "mixed") {
    reason =
      "A server seam and a UI/data path changed; run both contract and UI measurements.";
  } else if (mode === "ui") {
    reason =
      "A UI or client/data path changed; run the browser performance comparison.";
  }

  return {
    backendRequired,
    backendTests,
    changedPaths,
    mode,
    reason,
    uiRequired,
  };
}

export function performanceScopeArtifact(
  scope,
  {
    baseSha = null,
    baseStale = false,
    candidateSha = null,
    declaredBaseSha = null,
    eventName = "pull_request",
  } = {}
) {
  return {
    ...scope,
    baseSha,
    baseStale,
    candidateSha,
    declaredBaseSha,
    eventBaseStale: baseStale,
    eventName,
    mergeParentBaseSha: baseSha,
    payloadBaseSha: declaredBaseSha,
    uiMeasurement: scope.uiRequired ? "required" : "unexercised_seam",
    unexercisedSeam: scope.backendRequired && !scope.uiRequired,
  };
}

function pathsFromGit(baseSha, cwd) {
  return execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", `${baseSha}...HEAD`, "--"],
    { cwd, encoding: "utf8" }
  )
    .split("\0")
    .filter(Boolean);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "pull_request";
  const baseSha = process.env.CI_BASE_SHA;
  if (eventName === "pull_request" && !baseSha) {
    throw new Error("CI_BASE_SHA is required for a pull-request scope");
  }
  const paths =
    eventName === "pull_request"
      ? await pathsFromGit(baseSha, process.cwd())
      : [];
  const scope = classifyPerformanceScope(paths, {
    eventName,
  });
  const output = process.env.GITHUB_OUTPUT;
  const artifact = performanceScopeArtifact(scope, {
    baseSha: baseSha ?? null,
    baseStale: process.env.CI_BASE_STALE === "true",
    candidateSha: process.env.CI_CANDIDATE_SHA ?? null,
    declaredBaseSha: process.env.CI_DECLARED_BASE_SHA ?? null,
    eventName,
  });
  const artifactPath = process.env.PERF_SCOPE_OUTPUT;
  if (artifactPath) {
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  }
  if (output) {
    appendFileSync(output, `mode=${scope.mode}\n`);
    appendFileSync(output, `ui_required=${scope.uiRequired}\n`);
    appendFileSync(output, `backend_required=${scope.backendRequired}\n`);
    appendFileSync(output, `backend_tests=${scope.backendTests.join(" ")}\n`);
    appendFileSync(output, `reason=${scope.reason}\n`);
  }
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}
