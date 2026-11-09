import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  codeRepositoryMetadata,
  codeRepositoryStatus,
  listCodeTasks,
  listGitHubRepositoryOptions,
  startCodeTask,
  taskCommand,
  taskDetail,
} from "@/lib/code-tasks/service";

const mocks = vi.hoisted(() => ({
  botFromRequest: vi.fn(),
  createTask: vi.fn(),
  enqueueCommand: vi.fn(),
  getActiveRepository: vi.fn(),
  getBot: vi.fn(),
  getPublicTask: vi.fn(),
  getRepositoryRow: vi.fn(),
  getSubscriptionAccess: vi.fn(),
  getTaskRow: vi.fn(),
  hasSubscriptionModel: vi.fn(),
  listConnections: vi.fn(),
  listEvents: vi.fn(),
  listGitHubRepositories: vi.fn(),
  listRepositories: vi.fn(),
  listTasks: vi.fn(),
  providerOptions: vi.fn(),
  resolveRepository: vi.fn(),
  start: vi.fn(),
  withConnection: vi.fn(),
}));

vi.mock("@/lib/bot-auth", () => ({ botFromRequest: mocks.botFromRequest }));
vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/ai/inference", () => ({
  hasSubscriptionModel: mocks.hasSubscriptionModel,
}));
vi.mock("@/lib/ai/subscription-store", () => ({
  getSubscriptionAccess: mocks.getSubscriptionAccess,
}));
vi.mock("@/lib/mcp/store", () => ({
  listConnections: mocks.listConnections,
  withConnection: mocks.withConnection,
}));
vi.mock("@/lib/code-tasks/providers", () => ({
  providerOptions: mocks.providerOptions,
}));
vi.mock("@/lib/code-tasks/github", () => ({
  listGitHubRepositories: mocks.listGitHubRepositories,
  resolveRepository: mocks.resolveRepository,
}));
vi.mock("@/lib/code-tasks/store", () => ({
  createTask: mocks.createTask,
  enqueueCommand: mocks.enqueueCommand,
  getActiveRepository: mocks.getActiveRepository,
  getPublicTask: mocks.getPublicTask,
  getRepositoryRow: mocks.getRepositoryRow,
  getTaskRow: mocks.getTaskRow,
  listEvents: mocks.listEvents,
  listRepositories: mocks.listRepositories,
  listTasks: mocks.listTasks,
}));
vi.mock(
  "@/lib/code-tasks/types",
  async () => await vi.importActual("@/lib/code-tasks/types")
);
vi.mock("@/workflows/code-task", () => ({
  codeTaskWorkflow: "code-task-workflow",
}));
vi.mock("workflow/api", () => ({ start: mocks.start }));

const bot = {
  billing: "gateway",
  fast: false,
  id: "11111111-1111-4111-8111-111111111111",
  model: "gateway-model",
  sessionId: "main-session",
  slug: "main",
};
const otherBot = {
  ...bot,
  id: "22222222-2222-4222-8222-222222222222",
  slug: "other",
};
const repository = {
  connectionId: "44444444-4444-4444-8444-444444444444",
  defaultBranch: "trunk",
  enabled: true,
  fullName: "acme/widgets",
  githubId: "42",
  id: "33333333-3333-4333-8333-333333333333",
};
const taskId = "55555555-5555-4555-8555-555555555555";

function request(body: unknown, authorization = "Bearer bot") {
  return new Request("https://busy.test/api/bot/code-tasks", {
    body: JSON.stringify(body),
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
}

function taskRow(botId = bot.id) {
  return {
    botId,
    id: taskId,
    sourceSessionId: bot.sessionId,
    status: "running",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.botFromRequest.mockResolvedValue({ slug: "main" });
  mocks.getBot.mockResolvedValue(bot);
  mocks.getActiveRepository.mockResolvedValue(repository);
  mocks.getRepositoryRow.mockResolvedValue(repository);
  mocks.getSubscriptionAccess.mockResolvedValue({
    credentials: {},
    models: [],
  });
  mocks.hasSubscriptionModel.mockReturnValue(true);
  mocks.providerOptions.mockReturnValue({ agentName: "busy-code-gateway" });
  mocks.resolveRepository.mockResolvedValue({
    fullName: repository.fullName,
    githubId: repository.githubId,
  });
  mocks.createTask.mockResolvedValue({ id: taskId });
  mocks.start.mockResolvedValue(undefined);
  mocks.getTaskRow.mockResolvedValue(taskRow());
  mocks.getPublicTask.mockResolvedValue({ ...taskRow(), botSlug: "main" });
  mocks.enqueueCommand.mockResolvedValue({
    id: "command-1",
    kind: "steer",
    messageId: "message-1",
  });
  mocks.listTasks.mockResolvedValue([]);
  mocks.listRepositories.mockResolvedValue([]);
  mocks.listEvents.mockResolvedValue([]);
  mocks.listConnections.mockResolvedValue([
    { catalogId: "github", id: repository.connectionId, status: "connected" },
  ]);
  mocks.withConnection.mockImplementation(
    async (
      _id: string,
      run: (
        row: { catalogId: string; status: string },
        data: { registeredProvider: string }
      ) => Promise<{ value: boolean }>
    ) =>
      (
        await run(
          { catalogId: "github", status: "connected" },
          { registeredProvider: "github" }
        )
      ).value
  );
  mocks.listGitHubRepositories.mockResolvedValue([]);
});

describe("bot code-task routes", () => {
  it("derives bot identity from OIDC and freezes that bot's AI profile", async () => {
    const response = await startCodeTask(
      request({
        acceptanceCriteria: ["The login form rejects an invalid email."],
        goal: "Fix login validation.",
        id: taskId,
        repositoryId: repository.id,
        sourceCallId: "call-1",
        sourceSessionId: bot.sessionId,
        title: "Fix login",
      })
    );

    expect(response.status).toBe(202);
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        ai: {
          agentName: "busy-code-gateway",
          billing: "gateway",
          fast: false,
          model: "gateway-model",
        },
        botId: bot.id,
        repositoryId: repository.id,
      })
    );
    expect(mocks.getBot).toHaveBeenCalledWith("main");
    expect(mocks.start).toHaveBeenCalledWith("code-task-workflow", [taskId]);
  });

  it("rejects a model-supplied bot id and a non-main source session", async () => {
    const arbitraryBot = await startCodeTask(
      request({
        botId: otherBot.id,
        goal: "Do it",
        id: taskId,
        sourceCallId: "call-1",
        sourceSessionId: bot.sessionId,
        title: "Change",
      })
    );
    expect(arbitraryBot.status).toBe(400);
    expect(mocks.createTask).not.toHaveBeenCalled();

    const wrongSession = await startCodeTask(
      request({
        goal: "Do it",
        id: taskId,
        sourceCallId: "call-1",
        sourceSessionId: "another-session",
        title: "Change",
      })
    );
    expect(wrongSession.status).toBe(403);
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("returns actionable setup errors instead of switching billing", async () => {
    mocks.getActiveRepository.mockResolvedValue(undefined);
    const missingRepository = await startCodeTask(
      request({
        goal: "Do it",
        id: taskId,
        sourceCallId: "call-1",
        sourceSessionId: bot.sessionId,
        title: "Change",
      })
    );
    expect(missingRepository.status).toBe(409);
    await expect(missingRepository.json()).resolves.toMatchObject({
      error: expect.stringContaining("repository"),
    });

    mocks.getActiveRepository.mockResolvedValue(repository);
    mocks.getBot.mockResolvedValue({
      ...bot,
      billing: "chatgpt",
      model: "chatgpt/gpt-test",
    });
    mocks.getSubscriptionAccess.mockResolvedValue(null);
    const missingAi = await startCodeTask(
      request({
        goal: "Do it",
        id: taskId,
        sourceCallId: "call-1",
        sourceSessionId: bot.sessionId,
        title: "Change",
      })
    );
    expect(missingAi.status).toBe(409);
    expect(mocks.providerOptions).not.toHaveBeenCalled();
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("requires the requested repository to be the bot's selected context", async () => {
    const unselected = {
      ...repository,
      fullName: "acme/other",
      githubId: "43",
      id: "99999999-9999-4999-8999-999999999999",
    };
    mocks.getRepositoryRow.mockResolvedValue(unselected);
    const status = await codeRepositoryStatus(
      new Request(
        `https://busy.test/api/bot/code-repository?sourceSessionId=${bot.sessionId}&repositoryId=${unselected.id}`
      )
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({
      ready: false,
      reason: "select_repository",
    });
    expect(mocks.resolveRepository).not.toHaveBeenCalled();

    const start = await startCodeTask(
      request({
        goal: "Do it",
        id: taskId,
        repositoryId: unselected.id,
        sourceCallId: "call-unselected",
        sourceSessionId: bot.sessionId,
        title: "Change",
      })
    );
    expect(start.status).toBe(409);
    await expect(start.json()).resolves.toMatchObject({
      error: expect.stringContaining("code context"),
    });
    expect(mocks.createTask).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("does not report ready or queue work after GitHub write access is lost", async () => {
    mocks.resolveRepository.mockRejectedValueOnce(
      new Error("Authorization bearer github_pat_secret")
    );
    const status = await codeRepositoryStatus(
      new Request(
        `https://busy.test/api/bot/code-repository?sourceSessionId=${bot.sessionId}&repositoryId=${repository.id}`
      )
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({
      ready: false,
      reason: "reconnect_github",
    });
    expect(mocks.createTask).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();

    mocks.resolveRepository.mockRejectedValueOnce(
      new Error("Authorization bearer github_pat_secret")
    );
    const start = await startCodeTask(
      request({
        goal: "Do it",
        id: taskId,
        repositoryId: repository.id,
        sourceCallId: "call-revoked",
        sourceSessionId: bot.sessionId,
        title: "Change",
      })
    );
    expect(start.status).toBe(409);
    const body = (await start.json()) as { error?: string };
    expect(body.error).toBe(
      "Reconnect GitHub or choose a repository with write access."
    );
    expect(body.error).not.toContain("github_pat");
    expect(mocks.createTask).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("rejects a changed GitHub identity instead of silently replacing the stored repository", async () => {
    mocks.resolveRepository.mockResolvedValueOnce({
      fullName: "acme/widgets-renamed",
      githubId: "404",
    });
    const status = await codeRepositoryStatus(
      new Request(
        `https://busy.test/api/bot/code-repository?sourceSessionId=${bot.sessionId}&repositoryId=${repository.id}`
      )
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({
      ready: false,
      reason: "select_repository",
    });
    expect(mocks.createTask).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("checks the main session and connection before allowing conversational setup", async () => {
    const wrongSession = await codeRepositoryStatus(
      new Request(
        "https://busy.test/api/bot/code-repository?sourceSessionId=not-main"
      )
    );
    expect(wrongSession.status).toBe(403);

    const ready = await codeRepositoryStatus(
      new Request(
        `https://busy.test/api/bot/code-repository?sourceSessionId=${bot.sessionId}&repositoryId=${repository.id}`
      )
    );
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({
      ready: true,
      repository: { fullName: repository.fullName, id: repository.id },
    });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("serves browser repository metadata without reading code tasks or secrets", async () => {
    const incompatibleConnection = {
      catalogId: "github",
      id: "77777777-7777-4777-8777-777777777777",
      status: "connected",
    };
    const incompatibleRepository = {
      ...repository,
      connectionId: incompatibleConnection.id,
      fullName: "acme/hidden",
      id: "88888888-8888-4888-8888-888888888888",
    };
    mocks.listRepositories.mockResolvedValue([
      repository,
      incompatibleRepository,
    ]);
    mocks.listConnections.mockResolvedValue([
      {
        catalogId: "github",
        id: repository.connectionId,
        status: "connected",
      },
      incompatibleConnection,
    ]);
    mocks.withConnection.mockImplementation(
      async (
        id: string,
        run: (
          row: { catalogId: string; status: string },
          data: { registeredProvider: string }
        ) => Promise<{ value: boolean }>
      ) =>
        (
          await run(
            { catalogId: "github", status: "connected" },
            { registeredProvider: "github" }
          )
        ).value && id !== incompatibleConnection.id
    );
    const response = await codeRepositoryMetadata(
      new Request("https://busy.test/api/bots/main/code-repository"),
      { params: Promise.resolve({ slug: "main" }) }
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      activeRepositoryId: repository.id,
      connections: [{ id: repository.connectionId, label: "GitHub" }],
      repositories: [repository],
    });
    expect(mocks.listTasks).not.toHaveBeenCalled();
    expect(mocks.getTaskRow).not.toHaveBeenCalled();
    expect(mocks.listEvents).not.toHaveBeenCalled();
  });

  it("returns 404 metadata for a missing browser bot", async () => {
    mocks.getBot.mockResolvedValueOnce(null);
    const response = await codeRepositoryMetadata(
      new Request("https://busy.test/api/bots/missing/code-repository"),
      { params: Promise.resolve({ slug: "missing" }) }
    );
    expect(response.status).toBe(404);
  });

  it("fails closed when the selected GitHub connection is revoked", async () => {
    mocks.withConnection.mockImplementationOnce(
      async (
        _id: string,
        run: (
          row: { catalogId: string; status: string },
          data: { registeredProvider: string }
        ) => Promise<{ value: boolean }>
      ) =>
        (
          await run(
            { catalogId: "github", status: "connected" },
            { registeredProvider: "google" }
          )
        ).value
    );
    const response = await codeRepositoryStatus(
      new Request(
        `https://busy.test/api/bot/code-repository?sourceSessionId=${bot.sessionId}&repositoryId=${repository.id}`
      )
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ready: false,
      reason: "reconnect_github",
    });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("paginates server-side GitHub discovery and hides read-only repositories", async () => {
    mocks.listGitHubRepositories.mockResolvedValue([
      {
        canPush: true,
        defaultBranch: "main",
        fullName: "acme/writable",
        githubId: "42",
        private: true,
      },
      {
        canPush: false,
        defaultBranch: "main",
        fullName: "acme/read-only",
        githubId: "43",
        private: false,
      },
    ]);
    const response = await listGitHubRepositoryOptions(
      new Request(
        `https://busy.test/api/code-repositories/github?connectionId=${repository.connectionId}&page=2`
      )
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      nextPage: null,
      page: 2,
      repositories: [
        {
          defaultBranch: "main",
          fullName: "acme/writable",
          githubId: "42",
          private: true,
        },
      ],
    });
    expect(mocks.listGitHubRepositories).toHaveBeenCalledWith(
      repository.connectionId,
      undefined,
      2
    );
  });

  it("does not reveal another bot's task and uses the submitted command id", async () => {
    mocks.getPublicTask.mockResolvedValue({
      ...taskRow(otherBot.id),
      botSlug: "other",
    });
    const detail = await taskDetail(
      new Request("https://busy.test"),
      { params: Promise.resolve({ id: taskId }) },
      true
    );
    expect(detail.status).toBe(404);

    mocks.getPublicTask.mockResolvedValue({ ...taskRow(), botSlug: "main" });
    const command = await taskCommand(
      request({
        id: "66666666-6666-4666-8666-666666666666",
        kind: "steer",
        sourceCallId: "call-2",
        sourceSessionId: bot.sessionId,
        text: "Also cover the empty state.",
      }),
      { params: Promise.resolve({ id: taskId }) },
      true
    );
    expect(command.status).toBe(202);
    expect(mocks.enqueueCommand).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({
        kind: "steer",
        messageId: "66666666-6666-4666-8666-666666666666",
        text: "Also cover the empty state.",
      })
    );
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("returns a compact task summary without execution or events", async () => {
    mocks.getPublicTask.mockResolvedValue({
      ...taskRow(),
      botSlug: "main",
      error: null,
      execution: { hugeLog: "private" },
      phase: "editing",
      prUrl: null,
      repository: {
        baseBranch: "main",
        fullName: repository.fullName,
        id: repository.id,
      },
      summary: "Working",
      title: "Fix login",
      updatedAt: "2026-11-02T00:00:00.000Z",
    });
    const response = await taskDetail(
      new Request("https://busy.test/api/code-tasks/task?view=summary"),
      { params: Promise.resolve({ id: taskId }) },
      true
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { task: Record<string, unknown> };
    expect(body.task).toMatchObject({ id: taskId, title: "Fix login" });
    expect(body.task).not.toHaveProperty("execution");
    expect(body.task).not.toHaveProperty("events");
  });

  it("returns a scoped binding proof only for the bot's main source session", async () => {
    const response = await taskDetail(
      new Request(
        `https://busy.test/api/bot/code-tasks/${taskId}?sourceSessionId=${bot.sessionId}`
      ),
      { params: Promise.resolve({ id: taskId }) },
      true
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      binding: { sourceSessionId: bot.sessionId, taskId },
    });

    const mismatch = await taskDetail(
      new Request(
        `https://busy.test/api/bot/code-tasks/${taskId}?sourceSessionId=other-session`
      ),
      { params: Promise.resolve({ id: taskId }) },
      true
    );
    expect(mismatch.status).toBe(403);
  });

  it("passes the event cursor and reports when another page exists", async () => {
    const events = Array.from({ length: 500 }, (_, index) => ({
      createdAt: "2026-11-03T00:00:00.000Z",
      data: { message: `Event ${index + 500}` },
      revision: 1,
      seq: index + 500,
      taskId,
      type: "agent.working",
    }));
    mocks.listEvents.mockResolvedValue(events);
    const response = await taskDetail(
      new Request(`https://busy.test/api/code-tasks/${taskId}?after=499`),
      { params: Promise.resolve({ id: taskId }) }
    );

    expect(response.status).toBe(200);
    expect(mocks.listEvents).toHaveBeenCalledWith(taskId, 499, 500);
    await expect(response.json()).resolves.toMatchObject({
      events,
      hasMoreEvents: true,
    });
  });

  it("rejects an invalid event cursor before querying the event store", async () => {
    const response = await taskDetail(
      new Request(`https://busy.test/api/code-tasks/${taskId}?after=NaN`),
      { params: Promise.resolve({ id: taskId }) }
    );

    expect(response.status).toBe(400);
    expect(mocks.listEvents).not.toHaveBeenCalled();
  });

  it("lists bot-scoped tasks and connected GitHub repositories for the UI", async () => {
    mocks.listTasks.mockResolvedValue([{ ...taskRow(), botSlug: "main" }]);
    mocks.listRepositories.mockResolvedValue([repository]);
    mocks.getActiveRepository.mockResolvedValue(repository);
    const response = await listCodeTasks(
      new Request("https://busy.test/api/bot/code-tasks"),
      true
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      activeRepositoryId: repository.id,
      repositories: [repository],
      tasks: [{ id: taskId }],
    });
    expect(mocks.listTasks).toHaveBeenCalledWith({ botId: bot.id });
  });
});
