import type { DeployFile } from "../bots/files";

const PROJECT_EXISTS_ERROR = /already.?exists|project_name_already/iu;
const ALREADY_ERROR = /already/iu;
const ANOTHER_PROJECT_ERROR = /another project/iu;
const ALREADY_CURRENT_ERROR = /already the current production deployment/iu;

export interface VercelClientConfig {
  fetchImpl?: typeof fetch;
  teamId: string;
  token: string;
}

// Never put the token in an error message.
async function call(
  cfg: VercelClientConfig,
  method: string,
  path: string,
  body?: unknown,
  query: Record<string, string> = {}
): Promise<Response> {
  const qs = new URLSearchParams({ ...query, teamId: cfg.teamId });
  return await (cfg.fetchImpl ?? fetch)(`https://api.vercel.com${path}?${qs}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    method,
    // A hung API call otherwise holds a deploy step until the function's 300 s limit (2026-11-09).
    // Generous for createDeployment's inline files; an abort surfaces as a normal, retryable error.
    signal: AbortSignal.timeout(120_000),
  });
}

async function fail(what: string, res: Response): Promise<never> {
  throw new Error(
    `Vercel ${what} failed: ${res.status} ${(await res.text()).slice(0, 500)}`
  );
}

/** A project's id, which the Sandbox SDK needs to reach that project's sandboxes. */
export async function projectId(
  cfg: VercelClientConfig,
  name: string
): Promise<string> {
  const res = await call(cfg, "GET", `/v9/projects/${name}`);
  if (!res.ok) {
    return fail("get project", res);
  }
  return ((await res.json()) as { id: string }).id;
}

interface SamplingRule {
  env?: string;
  rate: number;
  requestPath?: string | null;
  type: string;
}
// Same API and limit as `vercel traces config set` in the pinned CLI.
const TRACE_RULE_LIMIT = 10;

/**
 * Head-sample a project's production traces at `percent` (1-100), keeping its
 * other rules. Without a rule Vercel records no traces for the bot.
 * Idempotent: an existing production rule at that rate is left alone.
 */
export async function ensureTraceSampling(
  cfg: VercelClientConfig,
  name: string,
  percent: number
): Promise<"unchanged" | "updated"> {
  const id = await projectId(cfg, name);
  const path = "/v1/drains/tracing/config";
  const got = await call(cfg, "GET", path, undefined, { projectId: id });
  if (!got.ok) {
    return fail("get trace sampling", got);
  }
  const config = (await got.json()) as {
    enabled?: boolean;
    sampling?: SamplingRule[];
  };
  const current = config.sampling ?? [];
  // The CLI reads an enabled config without rules as "everything at 100%".
  const rules =
    config.enabled && current.length === 0
      ? [{ rate: 1, type: "head_sampling" }]
      : current;
  const rate = percent / 100;
  const isProduction = (rule: SamplingRule) =>
    rule.env === "production" &&
    (rule.requestPath === undefined || rule.requestPath === null);
  const existing = rules.find(isProduction);
  if (config.enabled && existing?.rate === rate) {
    return "unchanged";
  }
  const production = { env: "production", rate, type: "head_sampling" };
  const next = existing
    ? rules.map((rule) => (isProduction(rule) ? production : rule))
    : [...rules, production];
  if (next.length > TRACE_RULE_LIMIT) {
    throw new Error("Vercel trace sampling has no room for another rule");
  }
  const put = await call(
    cfg,
    "PUT",
    path,
    { enabled: true, sampling: next },
    { projectId: id }
  );
  if (!put.ok) {
    return fail("set trace sampling", put);
  }
  return "updated";
}

export interface VercelProject {
  accountId?: string;
  id: string;
  name: string;
}

/** The team's project with exactly this name, or null when there is none. Never another team's. */
export async function findProject(
  cfg: VercelClientConfig,
  name: string
): Promise<VercelProject | null> {
  const res = await call(cfg, "GET", `/v9/projects/${name}`);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    return fail("get project", res);
  }
  const project = (await res.json()) as Partial<VercelProject>;
  if (
    typeof project.id !== "string" ||
    project.name !== name ||
    (project.accountId !== undefined && project.accountId !== cfg.teamId)
  ) {
    throw new Error("Vercel get project returned a different project");
  }
  return { accountId: project.accountId, id: project.id, name: project.name };
}

/** GET-then-create; losing a create race counts as existing. Returns the project's real id. */
export async function ensureProject(
  cfg: VercelClientConfig,
  name: string
): Promise<{ existed: boolean; id: string }> {
  const found = await findProject(cfg, name);
  if (found) {
    return { existed: true, id: found.id };
  }
  const made = await call(cfg, "POST", "/v11/projects", { name });
  if (made.ok) {
    const project = (await made.json()) as Partial<VercelProject>;
    if (typeof project.id !== "string" || project.name !== name) {
      throw new Error("Vercel create project returned a different project");
    }
    return { existed: false, id: project.id };
  }
  const text = await made.text();
  if (PROJECT_EXISTS_ERROR.test(text)) {
    const raced = await findProject(cfg, name);
    if (raced) {
      return { existed: true, id: raced.id };
    }
  }
  throw new Error(
    `Vercel create project failed: ${made.status} ${text.slice(0, 500)}`
  );
}

/**
 * Opt-in default memory/CPU for every function of the project (BOT_FUNCTION_MEMORY: `standard` is
 * 2 GB/1 vCPU, `performance` 4 GB/2 vCPUs). Any other value leaves the project alone. It takes
 * effect on the next deployment; vercel.json can't set it (docs/flow-cold-start.md).
 */
export async function setFunctionMemory(
  cfg: VercelClientConfig,
  name: string,
  type = process.env.BOT_FUNCTION_MEMORY
): Promise<void> {
  if (type !== "performance" && type !== "standard") {
    return;
  }
  const res = await call(cfg, "PATCH", `/v9/projects/${name}`, {
    resourceConfig: { functionDefaultMemoryType: type },
  });
  if (!res.ok) {
    await fail("set function memory", res);
  }
}

/** Takes its deployments, domains and env with it. Idempotent: an already-gone project is fine. */
export async function deleteProject(
  cfg: VercelClientConfig,
  name: string
): Promise<void> {
  const res = await call(cfg, "DELETE", `/v9/projects/${name}`);
  if (!res.ok && res.status !== 404) {
    await fail("delete project", res);
  }
}

/** Encrypted, production + preview. Values never appear in errors. */
export async function upsertProjectEnv(
  cfg: VercelClientConfig,
  name: string,
  vars: Record<string, string>
): Promise<void> {
  const body = Object.entries(vars).map(([key, value]) => ({
    key,
    target: ["production", "preview"],
    type: "encrypted",
    value,
  }));
  const res = await call(cfg, "POST", `/v10/projects/${name}/env`, body, {
    upsert: "true",
  });
  if (!res.ok) {
    await res.text().catch(() => "");
    throw new Error(`Vercel upsert env failed: ${res.status}`);
  }
  const failed = (
    (await res.json().catch(() => null)) as {
      failed?: { error?: { key?: string } }[];
    } | null
  )?.failed;
  if (failed?.length) {
    throw new Error(
      `Vercel upsert env failed for: ${failed.map((f) => f.error?.key ?? "?").join(", ")}`
    );
  }
}

/** Idempotent: a domain already on this project is fine. */
/** Deletes a variable from every environment. A missing one is fine. */
export async function removeProjectEnv(
  cfg: VercelClientConfig,
  name: string,
  key: string
): Promise<void> {
  const res = await call(cfg, "GET", `/v10/projects/${name}/env`);
  if (!res.ok) {
    return fail("list env", res);
  }
  const { envs } = (await res.json()) as {
    envs: { id: string; key: string }[];
  };
  for (const env of envs.filter((e) => e.key === key)) {
    // biome-ignore lint/performance/noAwaitInLoops: Environment deletes are serialized to respect Vercel API ordering and rate limits.
    const del = await call(cfg, "DELETE", `/v9/projects/${name}/env/${env.id}`);
    if (!del.ok && del.status !== 404) {
      await fail("delete env", del);
    }
  }
}

export async function addProjectDomain(
  cfg: VercelClientConfig,
  name: string,
  domain: string
): Promise<void> {
  const res = await call(cfg, "POST", `/v10/projects/${name}/domains`, {
    name: domain,
  });
  if (res.ok) {
    return;
  }
  const text = await res.text();
  if (
    res.status === 409 &&
    ALREADY_ERROR.test(text) &&
    !ANOTHER_PROJECT_ERROR.test(text)
  ) {
    return;
  }
  throw new Error(
    `Vercel add domain failed: ${res.status} ${text.slice(0, 500)}`
  );
}

/**
 * Explicit promotion of bot deployments (H-04) is opt-in until it is verified against Vercel with a
 * real bot: `BOT_DEPLOY_PROMOTION=on`. Off, deployments publish themselves as before and READY
 * means published; the generation fencing of the hub's rows applies either way.
 */
export const explicitPromotion = () =>
  process.env.BOT_DEPLOY_PROMOTION === "on";

export async function createDeployment(
  cfg: VercelClientConfig,
  name: string,
  files: DeployFile[],
  promote: boolean = explicitPromotion()
): Promise<{ id: string; url: string }> {
  const res = await call(
    cfg,
    "POST",
    "/v13/deployments",
    {
      // With explicit promotion: built with the production environment (env vars, OIDC
      // `environment: production`) but not published; only the promotion lease holder promotes it
      // (promoteDeployment). Same as the pinned CLI's production deploy with --skip-domain.
      autoAssignCustomDomains: !promote,
      files,
      name,
      project: name,
      projectSettings: {
        // Opt-in: bundle a Node compile cache into the bot's functions (docs/flow-cold-start.md).
        buildCommand:
          process.env.BOT_COMPILE_CACHE === "1"
            ? "eve build && node scripts/compile-cache.mjs"
            : "eve build",
        framework: "eve",
        nodeVersion: "24.x",
      },
      target: "production",
    },
    { skipAutoDetectionConfirmation: "1" }
  );
  if (!res.ok) {
    await fail("create deployment", res);
  }
  const json = (await res.json()) as { id: string; url: string };
  return { id: json.id, url: json.url };
}

/**
 * Assigns the project's production domains to a READY production deployment, without a rebuild.
 * The alias job runs after the response: read it with getPromotionStatus. Same endpoint as the
 * pinned CLI's promote command.
 */
export async function promoteDeployment(
  cfg: VercelClientConfig,
  project: string,
  deploymentId: string
): Promise<"current" | "requested"> {
  const res = await call(
    cfg,
    "POST",
    `/v10/projects/${project}/promote/${deploymentId}`,
    {}
  );
  if (res.ok) {
    return "requested";
  }
  // A new project's first production deployment is already current: Vercel answers 409 and records
  // no alias request, so getPromotionStatus would never confirm it (seen 2026-11-09).
  const text = await res.text();
  if (res.status === 409 && ALREADY_CURRENT_ERROR.test(text)) {
    return "current";
  }
  throw new Error(
    `Vercel promote deployment failed: ${res.status} ${text.slice(0, 500)}`
  );
}

export interface PromotionStatus {
  /** pending, in-progress, succeeded, failed or skipped (Vercel's lastAliasRequest.jobStatus). */
  jobStatus: string;
  toDeploymentId: string;
}

/** The project's latest promotion/rollback request, or null when it never had one. */
export async function getPromotionStatus(
  cfg: VercelClientConfig,
  project: string
): Promise<PromotionStatus | null> {
  const res = await call(cfg, "GET", `/v9/projects/${project}`);
  if (!res.ok) {
    return fail("get project", res);
  }
  const { lastAliasRequest } = (await res.json()) as {
    lastAliasRequest?: { jobStatus?: string; toDeploymentId?: string } | null;
  };
  if (!(lastAliasRequest?.jobStatus && lastAliasRequest.toDeploymentId)) {
    return null;
  }
  return {
    jobStatus: lastAliasRequest.jobStatus,
    toDeploymentId: lastAliasRequest.toDeploymentId,
  };
}

/** The project a deployment belongs to: proof that a bot's recorded deployment lives in that project. */
export async function getDeploymentProjectId(
  cfg: VercelClientConfig,
  id: string
): Promise<string | null> {
  const res = await call(cfg, "GET", `/v13/deployments/${id}`);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    return fail("get deployment", res);
  }
  const { projectId: owner } = (await res.json()) as { projectId?: unknown };
  return typeof owner === "string" ? owner : null;
}

export type DeploymentState = "BUILDING" | "READY" | "ERROR";

export async function getDeploymentState(
  cfg: VercelClientConfig,
  id: string
): Promise<DeploymentState> {
  const res = await call(cfg, "GET", `/v13/deployments/${id}`);
  if (!res.ok) {
    await fail("get deployment", res);
  }
  const { readyState } = (await res.json()) as { readyState: string };
  if (readyState === "READY") {
    return "READY";
  }
  if (readyState === "ERROR" || readyState === "CANCELED") {
    return "ERROR";
  }
  return "BUILDING";
}

export interface DeploymentDetails {
  buildingAt: number | null;
  createdAt: number | null;
  /** The newest build log line, unsanitized: lib/bots/progress.ts cleans it before it leaves the hub. */
  lastLine: string | null;
  readyAt: number | null;
  /** Vercel's raw readyState: QUEUED, INITIALIZING, BUILDING, READY, ERROR, CANCELED. */
  readyState: string;
}

interface DeploymentEvent {
  created?: number;
  payload?: { text?: string };
  text?: string;
  type?: string;
}

const LOG_TYPES = new Set(["stdout", "stderr", "command"]);

async function lastBuildLine(
  cfg: VercelClientConfig,
  id: string
): Promise<string | null> {
  const res = await call(
    cfg,
    "GET",
    `/v3/deployments/${id}/events`,
    undefined,
    { builds: "1", direction: "backward", limit: "20" }
  );
  if (!res.ok) {
    return null;
  }
  const events = (await res.json()) as DeploymentEvent[];
  const lines = (Array.isArray(events) ? events : [])
    .filter((e) => LOG_TYPES.has(e.type ?? "") && (e.payload?.text ?? e.text))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  const [last] = lines;
  return last ? (last.payload?.text ?? last.text ?? null) : null;
}

/** State and timestamps of a deployment, plus its last build log line while it builds (best effort). */
export async function getDeploymentDetails(
  cfg: VercelClientConfig,
  id: string
): Promise<DeploymentDetails> {
  const res = await call(cfg, "GET", `/v13/deployments/${id}`);
  if (!res.ok) {
    await fail("get deployment", res);
  }
  const json = (await res.json()) as {
    buildingAt?: number;
    createdAt?: number;
    ready?: number;
    readyState: string;
  };
  const settled = json.readyState === "READY" || json.readyState === "QUEUED";
  return {
    buildingAt: json.buildingAt ?? null,
    createdAt: json.createdAt ?? null,
    lastLine: settled ? null : await lastBuildLine(cfg, id).catch(() => null),
    readyAt: json.ready ?? null,
    readyState: json.readyState,
  };
}
