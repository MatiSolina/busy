import type { BotRow } from "../db/schema";
import type { DeploymentDetails } from "../vercel/client";
import { BUILD_FAILED } from "./deploy";

export type DeployStepState = "pending" | "active" | "done" | "error";
export interface DeployStep {
  /** Build state or the last log line, sanitized. */
  detail: string | null;
  endedAt: string | null;
  id: "prepare" | "build" | "live";
  label: string;
  startedAt: string | null;
  state: DeployStepState;
}

type ProgressBot = Pick<
  BotRow,
  "deploymentId" | "error" | "status" | "updatedAt"
>;

const LABELS = {
  build: "Building on Vercel",
  live: "Going live",
  prepare: "Preparing project and files",
} as const;

const BUILD_STATES: Record<string, string> = {
  BUILDING: "Building",
  CANCELED: "Canceled",
  ERROR: "Build failed",
  INITIALIZING: "Initializing",
  QUEUED: "Queued",
  READY: "Built",
};

const MAX_LINE = 140;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI color codes start with ESC.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/gu;
const SECRET_PAIR =
  /\b(?<name>[\w-]*(?:token|secret|key|password|passwd|auth)[\w-]*)\s*[=:]\s*\S+/giu;
const LONG_TOKEN = /[A-Za-z0-9_\-+/=.]{32,}/gu;
const URL_CREDENTIALS = /\/\/[^/\s:@]+:[^/\s@]+@/gu;

/** A build log line safe to show: no colors, no credentials, nothing that looks like a key, one short line. */
export function sanitizeLogLine(line: string | null): string | null {
  const clean = line
    ?.replace(ANSI, "")
    .replace(URL_CREDENTIALS, "//…@")
    .replace(SECRET_PAIR, "$<name>=…")
    .replace(LONG_TOKEN, "…")
    .replace(/\s+/gu, " ")
    .trim();
  if (!clean) {
    return null;
  }
  return clean.length > MAX_LINE ? `${clean.slice(0, MAX_LINE - 1)}…` : clean;
}

const iso = (ms: number | null | undefined) =>
  ms ? new Date(ms).toISOString() : null;

function step(
  id: DeployStep["id"],
  state: DeployStepState,
  rest: Partial<Pick<DeployStep, "detail" | "endedAt" | "startedAt">> = {}
): DeployStep {
  return {
    detail: null,
    endedAt: null,
    id,
    label: LABELS[id],
    startedAt: null,
    state,
    ...rest,
  };
}

function buildDetail(d: DeploymentDetails): string {
  const state = BUILD_STATES[d.readyState] ?? "Building";
  const line = sanitizeLogLine(d.lastLine);
  return line ? `${state} · ${line}` : state;
}

/** No deployment to read: failed before Vercel took the build (startDeploy threw), or Vercel didn't answer. */
function withoutDeployment(bot: ProgressBot, since: string): DeployStep[] {
  if (bot.status !== "failed") {
    return [
      step("prepare", "done"),
      step("build", "active"),
      step("live", "pending"),
    ];
  }
  if (bot.error === BUILD_FAILED) {
    return [
      step("prepare", "done"),
      step("build", "error", { endedAt: since }),
      step("live", "pending"),
    ];
  }
  return [
    step("prepare", "error", { endedAt: since }),
    step("build", "pending"),
    step("live", "pending"),
  ];
}

function buildStep(
  bot: ProgressBot,
  d: DeploymentDetails,
  since: string
): DeployStep {
  const rest = { detail: buildDetail(d), startedAt: iso(d.createdAt) };
  if (d.readyState === "READY") {
    return step("build", "done", { ...rest, endedAt: iso(d.readyAt) });
  }
  if (bot.status === "failed") {
    return step("build", "error", { ...rest, endedAt: since });
  }
  return step("build", "active", rest);
}

/**
 * What the deploy is doing now, from what's already stored: the bot row (its status changes and
 * `updatedAt` mark each hub step) and the Vercel deployment's own timestamps. No new column.
 * `deployment` is the bot's current deployment, or null when it wasn't looked up.
 */
export function deployProgress(
  bot: ProgressBot,
  deployment: DeploymentDetails | null
): DeployStep[] | null {
  const since = bot.updatedAt.toISOString();
  if (bot.status === "ready") {
    return null;
  }
  if (bot.status === "creating") {
    return [
      step("prepare", "active", { startedAt: since }),
      step("build", "pending"),
      step("live", "pending"),
    ];
  }
  if (!deployment) {
    return withoutDeployment(bot, since);
  }
  // Vercel finished; the hub flips the bot to ready on its next check (deployBotWorkflow, every 10 s).
  const live =
    deployment.readyState === "READY"
      ? step("live", "active", { startedAt: iso(deployment.readyAt) })
      : step("live", "pending");
  return [
    step("prepare", "done", { endedAt: iso(deployment.createdAt) }),
    buildStep(bot, deployment, since),
    live,
  ];
}

/** Looks the deployment up only when it's the one being shown: deploying, or a failed build. */
export async function loadDeployProgress(
  bot: ProgressBot,
  getDetails: (id: string) => Promise<DeploymentDetails>
): Promise<DeployStep[] | null> {
  const current =
    bot.status === "deploying" ||
    (bot.status === "failed" && bot.error === BUILD_FAILED);
  const deployment =
    current && bot.deploymentId
      ? await getDetails(bot.deploymentId).catch(() => null)
      : null;
  return deployProgress(bot, deployment);
}
