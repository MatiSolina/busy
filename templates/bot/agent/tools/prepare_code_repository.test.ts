import { beforeEach, describe, expect, it, vi } from "vitest";
import prepare from "./prepare_code_repository";

const getCodeRepositoryStatus = vi.hoisted(() => vi.fn());
vi.mock("../lib/code-repository-setup-client", () => ({
  getCodeRepositoryStatus,
}));

const repositoryId = "22222222-2222-4222-8222-222222222222";

interface TestContext {
  ask: ReturnType<typeof vi.fn>;
  session: {
    auth: {
      current?: { principalId?: string; principalType?: string } | null;
    };
    id: string;
    parent?: unknown;
  };
}

interface PreparedTool {
  execute: (input: unknown, context: TestContext) => Promise<unknown>;
}

const tool = prepare as unknown as PreparedTool;

function context(overrides: Partial<TestContext["session"]> = {}): TestContext {
  return {
    ask: vi.fn(),
    session: {
      auth: { current: { principalId: "owner", principalType: "app" } },
      id: "session-1",
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("prepare_code_repository workflow", () => {
  it("returns ready without asking or starting a task", async () => {
    getCodeRepositoryStatus.mockResolvedValue({
      ready: true,
      repository: { fullName: "acme/widgets", id: repositoryId },
    });
    const ctx = context();
    await expect(
      tool.execute({ title: "Fix login" }, ctx)
    ).resolves.toMatchObject({ ready: true, repository: { id: repositoryId } });
    expect(ctx.ask).not.toHaveBeenCalled();
    expect(getCodeRepositoryStatus).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      auth: {
        current: {
          principalId: "busy-hub:hub:code-task:task-1",
          principalType: "service",
        },
      },
      name: "completion delivery",
    },
    {
      auth: {
        current: {
          principalId: "busy-hub:hub:routine:run-1",
          principalType: "service",
        },
      },
      name: "routine execution",
    },
  ])("does not ask from a $name", async ({ auth }) => {
    const ctx = context({ auth });
    await expect(tool.execute({}, ctx)).resolves.toMatchObject({
      ready: false,
    });
    expect(ctx.ask).not.toHaveBeenCalled();
    expect(getCodeRepositoryStatus).not.toHaveBeenCalled();
  });

  it("does not ask from a consultation or child session", async () => {
    const consultation = context({
      auth: {
        current: {
          principalId: "owner:project:bot-child:consultation",
          principalType: "app",
        },
      },
    });
    await expect(tool.execute({}, consultation)).resolves.toMatchObject({
      ready: false,
    });
    const child = context({ parent: { id: "parent" } });
    await expect(tool.execute({}, child)).resolves.toMatchObject({
      ready: false,
    });
    expect(getCodeRepositoryStatus).not.toHaveBeenCalled();
  });

  it("cancels without validating a repository or starting code work", async () => {
    getCodeRepositoryStatus.mockResolvedValue({
      ready: false,
      reason: "connect_github",
    });
    const ctx = context();
    ctx.ask.mockResolvedValue({ optionId: "cancel", status: "answered" });
    await expect(tool.execute({}, ctx)).resolves.toEqual({
      ready: false,
      reason: "Repository setup was cancelled.",
    });
    expect(getCodeRepositoryStatus).toHaveBeenCalledTimes(1);
  });

  it("revalidates the selected repository after the card answer", async () => {
    getCodeRepositoryStatus
      .mockResolvedValueOnce({ ready: false, reason: "select_repository" })
      .mockResolvedValueOnce({
        ready: true,
        repository: { fullName: "acme/widgets", id: repositoryId },
      });
    const ctx = context();
    ctx.ask.mockResolvedValue({ status: "answered", text: repositoryId });
    await expect(tool.execute({}, ctx)).resolves.toMatchObject({
      next: expect.stringContaining("start_code_task"),
      ready: true,
      repository: { id: repositoryId },
    });
    expect(getCodeRepositoryStatus).toHaveBeenNthCalledWith(
      2,
      "session-1",
      repositoryId
    );
  });
});
