import assert from "node:assert/strict";
import test from "node:test";
import { resolvePerformanceRefs } from "./performance-refs.mjs";

const baseSha = "1".repeat(40);
const candidateSha = "2".repeat(40);
const headSha = "3".repeat(40);
const otherSha = "4".repeat(40);
const exactlyTwoParents = /exactly two parents/u;
const secondParentMismatch = /second parent does not match/u;
const identicalRefs = /must differ/u;

test("uses the declared merge parents for a PR baseline and candidate", () => {
  assert.deepEqual(
    resolvePerformanceRefs({
      candidateParents: [baseSha, headSha],
      candidateSha,
      declaredBaseSha: baseSha,
      eventName: "pull_request",
      pullRequestHeadSha: headSha,
    }),
    {
      baseSha,
      baseStale: false,
      candidateHeadSha: headSha,
      candidateParents: [baseSha, headSha],
      candidateSha,
      declaredBaseMatches: true,
      declaredBaseSha: baseSha,
    }
  );
});

test("uses the verified merge first parent and records a stale declared base", () => {
  assert.deepEqual(
    resolvePerformanceRefs({
      candidateParents: [baseSha, headSha],
      candidateSha,
      declaredBaseSha: otherSha,
      eventName: "pull_request",
      pullRequestHeadSha: headSha,
    }),
    {
      baseSha,
      baseStale: true,
      candidateHeadSha: headSha,
      candidateParents: [baseSha, headSha],
      candidateSha,
      declaredBaseMatches: false,
      declaredBaseSha: otherSha,
    }
  );
});

test("rejects inconsistent merge parents before any profiles run", () => {
  assert.throws(
    () =>
      resolvePerformanceRefs({
        candidateParents: [baseSha],
        candidateSha,
        declaredBaseSha: baseSha,
        eventName: "pull_request",
        pullRequestHeadSha: headSha,
      }),
    exactlyTwoParents
  );
  assert.throws(
    () =>
      resolvePerformanceRefs({
        candidateParents: [baseSha, otherSha],
        candidateSha,
        declaredBaseSha: baseSha,
        eventName: "pull_request",
        pullRequestHeadSha: headSha,
      }),
    secondParentMismatch
  );
});

test("freezes a manually selected baseline SHA once", () => {
  assert.deepEqual(
    resolvePerformanceRefs({
      candidateParents: [],
      candidateSha,
      eventName: "workflow_dispatch",
      resolvedBaselineSha: baseSha,
    }),
    {
      baseSha,
      baseStale: false,
      candidateHeadSha: null,
      candidateParents: [],
      candidateSha,
      declaredBaseMatches: true,
      declaredBaseSha: null,
    }
  );
});

test("rejects an identical manual baseline and candidate", () => {
  assert.throws(
    () =>
      resolvePerformanceRefs({
        candidateParents: [],
        candidateSha,
        eventName: "workflow_dispatch",
        resolvedBaselineSha: candidateSha,
      }),
    identicalRefs
  );
});
