import { start } from "workflow/api";
import { z } from "zod";
import { codeTaskWorkflow } from "../../workflows/code-task";
import { hasSubscriptionModel } from "../ai/inference";
import { getSubscriptionAccess } from "../ai/subscription-store";
import { botFromRequest } from "../bot-auth";
import { getBot } from "../bots/service";
import type { BotRow, CodeRepositoryRow, McpConnectionRow } from "../db";
import { listConnections, withConnection } from "../mcp/store";
import { listGitHubRepositories, resolveRepository } from "./github";
import { CodeTaskHttpError, codeBody, codeError, codeJson } from "./http";
import { providerOptions } from "./providers";
import {
  createTask,
  enqueueCommand,
  getActiveRepository,
  getPublicTask,
  getRepositoryRow,
  getTaskRow,
  listEvents,
  listRepositories,
  listTasks,
  putRepository,
  setActiveRepository,
} from "./store";
import { type PublicCodeTask, publicCodeTaskSummary } from "./types";

export interface TaskRouteContext {
  params: Promise<{ id: string }>;
}
const taskId = z.uuid();
const source = {
  sourceCallId: z.string().trim().min(1).max(255),
  sourceSessionId: z.string().trim().min(1).max(255),
};
const startInput = z.strictObject({
  id: z.uuid(),
  ...source,
  acceptanceCriteria: z
    .array(z.string().trim().min(1).max(1000))
    .max(20)
    .optional(),
  goal: z.string().trim().min(1).max(20_000),
  repositoryId: z.uuid().optional(),
  title: z.string().trim().min(1).max(200),
});
const commandInput = z
  .object({
    id: z.uuid(),
    kind: z.enum(["steer", "cancel"]),
    sourceCallId: source.sourceCallId.optional(),
    sourceSessionId: source.sourceSessionId.optional(),
    text: z.string().trim().max(20_000).optional(),
  })
  .refine(
    (value) => value.kind !== "steer" || Boolean(value.text),
    "An instruction is required."
  );

async function callingBot(request: Request): Promise<BotRow | Response> {
  const caller = await botFromRequest(request);
  if (caller instanceof Response) {
    return caller;
  }
  const bot = await getBot(caller.slug);
  return bot ?? codeJson({ error: "Bot not found." }, 404);
}

async function scopedBinding(
  request: Request,
  bot: BotRow,
  codeTaskId: string
): Promise<Response | null> {
  const sourceSessionId = new URL(request.url).searchParams.get(
    "sourceSessionId"
  );
  if (sourceSessionId === null) {
    return null;
  }
  // Binding proof is intentionally narrower than public task detail.
  mainSession(bot, sourceSessionId);
  const stored = await getTaskRow(codeTaskId);
  if (!stored || stored.sourceSessionId !== sourceSessionId) {
    return codeJson({ error: "Code task not found." }, 404);
  }
  return codeJson({ binding: { sourceSessionId, taskId: codeTaskId } });
}

function mainSession(bot: BotRow, sessionId: string) {
  if (!bot.sessionId || bot.sessionId !== sessionId) {
    throw new CodeTaskHttpError(
      "Only the bot's main conversation can control code work.",
      403
    );
  }
}

async function githubConnectionReady(
  connectionId: string,
  knownRows?: McpConnectionRow[]
): Promise<boolean> {
  const rows = knownRows ?? (await listConnections());
  const row = rows.find((candidate) => candidate.id === connectionId);
  if (row?.catalogId !== "github" || row.status !== "connected") {
    return false;
  }
  try {
    return (
      (await withConnection(connectionId, (current, data) => ({
        data,
        value:
          current.catalogId === "github" &&
          current.status === "connected" &&
          data.registeredProvider === "github",
      }))) === true
    );
  } catch {
    return false;
  }
}

type RepositoryPreflight =
  | { ok: true }
  | { ok: false; reason: "reconnect_github" | "select_repository" };

/** Verify the stored repository identity and current GitHub write permission without changing it. */
async function preflightRepository(
  repository: CodeRepositoryRow
): Promise<RepositoryPreflight> {
  if (!(repository.enabled && repository.connectionId)) {
    return { ok: false, reason: "select_repository" };
  }
  try {
    const current = await resolveRepository(
      repository.connectionId,
      repository.fullName,
      repository.defaultBranch
    );
    if (
      current.fullName !== repository.fullName ||
      current.githubId !== repository.githubId
    ) {
      return { ok: false, reason: "select_repository" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "reconnect_github" };
  }
}

const repositoryStatusQuery = z.object({
  repositoryId: z.uuid().optional(),
  sourceSessionId: z.string().trim().min(1).max(255),
});

/** Lightweight server-owned readiness check used by the conversational setup workflow. */
export async function codeRepositoryStatus(
  request: Request
): Promise<Response> {
  try {
    const bot = await callingBot(request);
    if (bot instanceof Response) {
      return bot;
    }
    const input = repositoryStatusQuery.parse(
      Object.fromEntries(new URL(request.url).searchParams)
    );
    mainSession(bot, input.sourceSessionId);

    const [active, requested, connections] = await Promise.all([
      getActiveRepository(bot.id),
      input.repositoryId ? getRepositoryRow(input.repositoryId) : undefined,
      listConnections(),
    ]);
    if (input.repositoryId && input.repositoryId !== active?.id) {
      return codeJson({ ready: false, reason: "select_repository" });
    }
    let repository: CodeRepositoryRow | undefined;
    if (input.repositoryId) {
      repository = requested;
    } else if (active) {
      repository = await getRepositoryRow(active.id);
    }
    const githubConnections = connections.filter(
      (connection) =>
        connection.catalogId === "github" && connection.status === "connected"
    );
    if (!githubConnections.length) {
      return codeJson({ ready: false, reason: "connect_github" });
    }
    if (!(repository?.enabled && repository.connectionId)) {
      return codeJson({ ready: false, reason: "select_repository" });
    }
    if (!(await githubConnectionReady(repository.connectionId, connections))) {
      return codeJson({ ready: false, reason: "reconnect_github" });
    }
    const preflight = await preflightRepository(repository);
    if (!preflight.ok) {
      return codeJson({ ready: false, reason: preflight.reason });
    }
    return codeJson({
      ready: true,
      repository: { fullName: repository.fullName, id: repository.id },
    });
  } catch (error) {
    return codeError(error);
  }
}

const githubRepositoryQuery = z.object({
  connectionId: z.uuid(),
  page: z.coerce.number().int().min(1).max(100).default(1),
});

/** Browser-only repository discovery; tokens stay in the server-side MCP broker. */
export async function listGitHubRepositoryOptions(
  request: Request
): Promise<Response> {
  try {
    const input = githubRepositoryQuery.parse(
      Object.fromEntries(new URL(request.url).searchParams)
    );
    const connection = (await listConnections()).find(
      (candidate) =>
        candidate.id === input.connectionId &&
        candidate.catalogId === "github" &&
        candidate.status === "connected"
    );
    if (!connection) {
      throw new CodeTaskHttpError(
        "Connect GitHub in this conversation before browsing repositories."
      );
    }
    if (!(await githubConnectionReady(input.connectionId))) {
      throw new CodeTaskHttpError(
        "Reconnect GitHub before browsing repositories."
      );
    }
    const repositories = await listGitHubRepositories(
      input.connectionId,
      undefined,
      input.page
    );
    const writable = repositories.filter(
      (repository) => repository.canPush !== false
    );
    return codeJson({
      nextPage:
        repositories.length === 100 && input.page < 100 ? input.page + 1 : null,
      page: input.page,
      repositories: writable.map((repository) => ({
        defaultBranch: repository.defaultBranch,
        fullName: repository.fullName,
        githubId: repository.githubId,
        private: repository.private,
      })),
    });
  } catch (error) {
    return codeError(error);
  }
}

/** Browser metadata for the conversational repository card; deliberately excludes tasks and credentials. */
export async function codeRepositoryMetadata(
  _request: Request,
  context: { params: Promise<{ slug: string }> }
): Promise<Response> {
  try {
    const bot = await getBot((await context.params).slug);
    if (!bot) {
      return codeJson({ error: "Bot not found." }, 404);
    }
    const [repositories, active, connections] = await Promise.all([
      listRepositories(),
      getActiveRepository(bot.id),
      listConnections(),
    ]);
    const github = connections.filter(
      (connection) =>
        connection.catalogId === "github" && connection.status === "connected"
    );
    const compatible = new Set(
      (
        await Promise.all(
          github.map(async (connection) =>
            (await githubConnectionReady(connection.id, connections))
              ? connection.id
              : null
          )
        )
      ).filter((id): id is string => id !== null)
    );
    const visibleRepositories = repositories.filter(
      (repository) =>
        repository.enabled &&
        repository.connectionId !== null &&
        compatible.has(repository.connectionId)
    );
    return codeJson({
      activeRepositoryId:
        active && visibleRepositories.some((repo) => repo.id === active.id)
          ? active.id
          : null,
      connections: github
        .filter((connection) => compatible.has(connection.id))
        .map((connection, index) => ({
          id: connection.id,
          label: `GitHub${index ? ` ${index + 1}` : ""}`,
        })),
      repositories: visibleRepositories,
    });
  } catch (error) {
    return codeError(error);
  }
}

async function readyProfile(bot: BotRow) {
  if (bot.billing === "chatgpt" || bot.billing === "grok") {
    const access = await getSubscriptionAccess(bot.billing).catch(() => null);
    if (
      !(access && hasSubscriptionModel(access.models, bot.billing, bot.model))
    ) {
      throw new CodeTaskHttpError(
        "Reconnect this bot's AI connection or select one of its available models."
      );
    }
  } else if (bot.billing === "token-pass" && !process.env.TOKEN_PASS_API_KEY) {
    throw new CodeTaskHttpError(
      "Token Pass is not configured. This task cannot switch billing automatically."
    );
  }
  return {
    agentName: providerOptions(bot.billing).agentName,
    billing: bot.billing,
    fast: bot.fast,
    model: bot.model,
  };
}

async function follow(id: string) {
  // The persisted outbox is the recovery path if starting this monitor fails.
  await start(codeTaskWorkflow, [id]).catch(() => undefined);
}

export async function listCodeTasks(
  request: Request,
  asBot = false
): Promise<Response> {
  try {
    const bot = asBot
      ? await callingBot(request)
      : await getBot(new URL(request.url).searchParams.get("botSlug") ?? "");
    if (bot instanceof Response) {
      return bot;
    }
    if (!bot) {
      return codeJson({ error: "Bot not found." }, 404);
    }
    const [tasks, repositories, active, connections] = await Promise.all([
      listTasks({ botId: bot.id }),
      listRepositories(),
      getActiveRepository(bot.id),
      listConnections(),
    ]);
    return codeJson({
      activeRepositoryId: active?.id ?? null,
      connections: connections
        .filter(
          (item) => item.catalogId === "github" && item.status === "connected"
        )
        .map((item, index) => ({
          id: item.id,
          label: `GitHub${index ? ` ${index + 1}` : ""}`,
        })),
      repositories,
      tasks,
    });
  } catch (error) {
    return codeError(error);
  }
}

export async function startCodeTask(request: Request): Promise<Response> {
  try {
    const bot = await callingBot(request);
    if (bot instanceof Response) {
      return bot;
    }
    const input = startInput.parse(await codeBody(request));
    mainSession(bot, input.sourceSessionId);
    const active = await getActiveRepository(bot.id);
    if (input.repositoryId && input.repositoryId !== active?.id) {
      throw new CodeTaskHttpError(
        "Select the repository in this bot's code context before starting the task."
      );
    }
    const repository = active ? await getRepositoryRow(active.id) : undefined;
    if (!(repository?.enabled && repository.connectionId)) {
      throw new CodeTaskHttpError(
        "Select an enabled GitHub repository in this conversation first."
      );
    }
    if (!(await githubConnectionReady(repository.connectionId))) {
      throw new CodeTaskHttpError(
        "Reconnect GitHub before starting this code task."
      );
    }
    const preflight = await preflightRepository(repository);
    if (!preflight.ok) {
      throw new CodeTaskHttpError(
        preflight.reason === "select_repository"
          ? "The selected GitHub repository identity changed. Choose it again."
          : "Reconnect GitHub or choose a repository with write access."
      );
    }
    const ai = await readyProfile(bot);
    const goal = input.acceptanceCriteria?.length
      ? `${input.goal}\n\nAcceptance criteria:\n${input.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`
      : input.goal;
    const task = await createTask({
      ai,
      botId: bot.id,
      branch: `codex/busy-${input.id}`,
      goal,
      id: input.id,
      repository: {
        baseBranch:
          "defaultBranch" in repository ? repository.defaultBranch : "main",
        fullName: repository.fullName,
        id: repository.id,
      },
      repositoryId: repository.id,
      sourceCallId: input.sourceCallId,
      sourceSessionId: input.sourceSessionId,
      title: input.title,
    });
    await follow(task.id);
    return codeJson(
      { task, taskId: task.id, url: `/code-tasks/${task.id}` },
      202
    );
  } catch (error) {
    return codeError(error);
  }
}

export async function taskDetail(
  request: Request,
  context: TaskRouteContext,
  asBot = false
): Promise<Response> {
  try {
    const id = taskId.parse((await context.params).id);
    let task = await getPublicTask(id);
    if (!task) {
      return codeJson({ error: "Code task not found." }, 404);
    }
    if (asBot) {
      const bot = await callingBot(request);
      if (bot instanceof Response) {
        return bot;
      }
      if (task.botId !== bot.id) {
        return codeJson({ error: "Code task not found." }, 404);
      }
      const binding = await scopedBinding(request, bot, id);
      if (binding) {
        return binding;
      }
    }
    const query = new URL(request.url).searchParams;
    if (query.get("view") === "summary") {
      return codeJson({ task: publicCodeTaskSummary(task) });
    }
    const afterValue = query.get("after");
    const after = afterValue === null ? 0 : Number(afterValue);
    if (!Number.isSafeInteger(after) || after < 0) {
      return codeJson({ error: "Invalid event cursor." }, 400);
    }
    if (
      task.usage?.costStatus === "pending" ||
      task.usage?.costStatus === "partial" ||
      task.usage?.costStatus === "unavailable"
    ) {
      await import("./runtime")
        .then(({ refreshCodeTaskCosts }) => refreshCodeTaskCosts(id))
        .catch(() => undefined);
      const refreshed = await getPublicTask(id);
      if (refreshed) {
        task = refreshed;
      }
    }
    const events = await listEvents(id, after, 500);
    return codeJson({
      events,
      hasMoreEvents: events.length === 500,
      task,
    });
  } catch (error) {
    return codeError(error);
  }
}

export async function taskCommand(
  request: Request,
  context: TaskRouteContext,
  asBot = false
): Promise<Response> {
  try {
    const id = taskId.parse((await context.params).id);
    const input = commandInput.parse(await codeBody(request));
    const task = await getTaskRow(id);
    if (!task) {
      return codeJson({ error: "Code task not found." }, 404);
    }
    if (asBot) {
      const bot = await callingBot(request);
      if (bot instanceof Response) {
        return bot;
      }
      if (task.botId !== bot.id) {
        return codeJson({ error: "Code task not found." }, 404);
      }
      mainSession(bot, input.sourceSessionId ?? "");
    }
    const command = await enqueueCommand(id, {
      kind: input.kind,
      messageId: input.id,
      text: input.text,
    });
    await follow(id);
    return codeJson({ command, task: await getPublicTask(id) }, 202);
  } catch (error) {
    return codeError(error);
  }
}

export async function addCodeRepository(request: Request): Promise<Response> {
  try {
    const input = z
      .strictObject({
        baseBranch: z.string().trim().min(1).max(255).optional(),
        connectionId: z.uuid(),
        fullName: z.string().trim().min(3).max(200),
      })
      .parse(await codeBody(request));
    const connections = await listConnections();
    if (
      !connections.some(
        (connection) =>
          connection.id === input.connectionId &&
          connection.catalogId === "github" &&
          connection.status === "connected"
      )
    ) {
      throw new CodeTaskHttpError(
        "Connect GitHub in Skills and plugins before adding a repository."
      );
    }
    const meta = await resolveRepository(
      input.connectionId,
      input.fullName,
      input.baseBranch
    );
    const repository = await putRepository({
      connectionId: input.connectionId,
      defaultBranch: meta.baseRef,
      fullName: meta.fullName,
      githubId: meta.githubId,
    });
    return codeJson({ repository }, 201);
  } catch (error) {
    return codeError(error);
  }
}

export async function selectCodeRepository(
  request: Request,
  context: { params: Promise<{ slug: string }> }
): Promise<Response> {
  try {
    const bot = await getBot((await context.params).slug);
    if (!bot) {
      return codeJson({ error: "Bot not found." }, 404);
    }
    const { repositoryId } = z
      .object({ repositoryId: z.uuid() })
      .parse(await codeBody(request));
    return codeJson({
      repository: await setActiveRepository(bot.id, repositoryId),
    });
  } catch (error) {
    return codeError(error);
  }
}

export function taskIsActive(task: Pick<PublicCodeTask, "status">) {
  return [
    "queued",
    "running",
    "waiting_for_input",
    "cancel_requested",
  ].includes(task.status);
}
