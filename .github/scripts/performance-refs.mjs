import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;

function assertSha(value, name) {
  if (!SHA_PATTERN.test(value)) {
    throw new Error(`${name} must be a full 40-character commit SHA`);
  }
}

/**
 * Resolve immutable source refs for the performance comparison.
 * Pull-request runs use the event merge commit as the candidate. The second
 * parent must match the immutable event head; the first parent is authoritative
 * for the baseline even when the event's declared base SHA is stale.
 */
export function resolvePerformanceRefs({
  candidateParents,
  candidateSha,
  declaredBaseSha = null,
  eventName,
  pullRequestHeadSha = null,
  resolvedBaselineSha = null,
}) {
  assertSha(candidateSha, "candidateSha");
  if (eventName === "pull_request") {
    if (!(declaredBaseSha && pullRequestHeadSha)) {
      throw new Error(
        "declaredBaseSha and pullRequestHeadSha are required for a pull request"
      );
    }
    assertSha(declaredBaseSha, "declaredBaseSha");
    assertSha(pullRequestHeadSha, "pullRequestHeadSha");
    if (candidateParents.length !== 2) {
      throw new Error(
        "The pull-request candidate must be a merge commit with exactly two parents"
      );
    }
    const [baseSha, headSha] = candidateParents;
    if (!(baseSha && headSha)) {
      throw new Error("The pull-request merge parents are incomplete");
    }
    assertSha(baseSha, "merge base parent");
    assertSha(headSha, "merge head parent");
    if (headSha !== pullRequestHeadSha) {
      throw new Error(
        "The merge commit second parent does not match pull_request.head.sha"
      );
    }
    if (baseSha === candidateSha || headSha === candidateSha) {
      throw new Error("A merge parent must differ from the candidate commit");
    }
    const declaredBaseMatches = baseSha === declaredBaseSha;
    return {
      baseSha,
      baseStale: !declaredBaseMatches,
      candidateHeadSha: headSha,
      candidateParents: [baseSha, headSha],
      candidateSha,
      declaredBaseMatches,
      declaredBaseSha,
    };
  }

  if (!resolvedBaselineSha) {
    throw new Error("resolvedBaselineSha is required outside pull requests");
  }
  assertSha(resolvedBaselineSha, "resolvedBaselineSha");
  if (resolvedBaselineSha === candidateSha) {
    throw new Error("The performance baseline must differ from the candidate");
  }
  return {
    baseSha: resolvedBaselineSha,
    baseStale: false,
    candidateHeadSha: null,
    candidateParents: [],
    candidateSha,
    declaredBaseMatches: true,
    declaredBaseSha: null,
  };
}

function gitValue(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function resolveManualBaseline(ref) {
  try {
    return gitValue(["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", ref], {
      stdio: "inherit",
    });
    return gitValue(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
  }
}

function appendOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(output, `${name}=${value}\n`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "pull_request";
  const candidateSha =
    process.env.CI_CANDIDATE_SHA ?? gitValue(["rev-parse", "HEAD"]);
  const checkedOutSha = gitValue(["rev-parse", "HEAD"]);
  if (checkedOutSha !== candidateSha) {
    throw new Error(
      `The checkout is not the immutable candidate: expected ${candidateSha}, observed ${checkedOutSha}`
    );
  }
  const candidateParents =
    eventName === "pull_request"
      ? gitValue(["rev-list", "--parents", "-n", "1", candidateSha])
          .split(/\s+/u)
          .slice(1)
      : [];
  const resolvedBaselineSha =
    eventName === "pull_request"
      ? null
      : resolveManualBaseline(process.env.CI_BASELINE_REF ?? "main");
  const refs = resolvePerformanceRefs({
    candidateParents,
    candidateSha,
    declaredBaseSha: process.env.CI_EVENT_BASE_SHA || null,
    eventName,
    pullRequestHeadSha: process.env.CI_PR_HEAD_SHA || null,
    resolvedBaselineSha,
  });
  const artifact = {
    ...refs,
    eventBaseSha: process.env.CI_EVENT_BASE_SHA || null,
    eventBaseStale: refs.baseStale,
    eventName,
    mergeParentBaseSha: refs.baseSha,
    payloadBaseSha: refs.declaredBaseSha,
  };
  const artifactPath = process.env.PERF_REFS_OUTPUT;
  if (artifactPath) {
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  }
  appendOutput("base_sha", refs.baseSha);
  appendOutput("base_stale", String(refs.baseStale));
  appendOutput("candidate_sha", refs.candidateSha);
  appendOutput("candidate_head_sha", refs.candidateHeadSha ?? "");
  appendOutput("declared_base_sha", refs.declaredBaseSha ?? "");
  if (refs.baseStale) {
    process.stderr.write(
      `::warning::pull_request.base.sha ${refs.declaredBaseSha} is stale; using merge first parent ${refs.baseSha} as the immutable performance baseline\n`
    );
  }
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}
