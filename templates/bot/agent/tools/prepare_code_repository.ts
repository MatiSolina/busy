import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { isConsultation, isRoutineExecution } from "../lib/caller";
import {
  type CodeRepositoryStatusResult,
  codeRepositorySetupInput,
  isCodeRepositoryStatusError,
} from "../lib/code-repository-setup";
import { getCodeRepositoryStatus } from "../lib/code-repository-setup-client";
import { isCodeTaskCompletion } from "../lib/code-task-guards";
import { LAZY_TOOLS } from "../lib/lazy-tools";

const STATUS_REASONS = {
  connect_github:
    "Connect GitHub in the conversation, then choose a repository to continue.",
  reconnect_github:
    "Reconnect GitHub in the conversation, then choose a repository to continue.",
  select_repository:
    "Choose an enabled GitHub repository in the conversation to continue.",
} as const;

function unavailableReason(
  auth: Parameters<typeof isCodeTaskCompletion>[0],
  consultation: boolean,
  routineExecution: boolean,
  parent: unknown
): string | undefined {
  if (consultation || routineExecution || parent) {
    return "Only the bot's main conversation can prepare a code repository.";
  }
  if (isCodeTaskCompletion(auth)) {
    return "A code task completion cannot prepare another code repository.";
  }
  return undefined;
}

function blockedResult(reason: string) {
  return { ready: false as const, reason };
}

function readyResult(
  result: Extract<CodeRepositoryStatusResult, { ready: boolean }>
) {
  if (!result.repository) {
    return blockedResult(
      "Choose a repository from the GitHub repository card."
    );
  }
  return {
    next: "Continue the original request with start_code_task and this repositoryId.",
    ready: true as const,
    repository: result.repository,
  };
}

export default defineWorkflowTool({
  availableInSubagents: false,
  deferred: LAZY_TOOLS,
  description:
    "Prepare a verified GitHub repository for an explicit code implementation request. Use this before start_code_task when the repository is missing, ambiguous, or not yet enabled. It may pause for the user to connect GitHub or choose a repository; it never creates or starts a code task.",
  async execute(input, ctx) {
    "use workflow";
    const reason = unavailableReason(
      ctx.session.auth,
      isConsultation(ctx.session.auth),
      isRoutineExecution(ctx.session.auth),
      ctx.session.parent
    );
    if (reason) {
      return blockedResult(reason);
    }
    const parsed = codeRepositorySetupInput.parse(input);
    const initial = await statusStep({
      repositoryId: parsed.repositoryId,
      sourceSessionId: ctx.session.id,
    });
    if (isCodeRepositoryStatusError(initial)) {
      return initial;
    }
    if (initial.ready) {
      return readyResult(initial);
    }

    const answer = await ctx.ask({
      allowFreeform: true,
      display: "select",
      options: [{ id: "cancel", label: "Not now" }],
      prompt: `Connect GitHub and choose a repository before starting${parsed.title ? ` “${parsed.title}”` : " this code task"}.`,
      title: "GitHub repository",
    });
    if (answer.status !== "answered") {
      return blockedResult(
        answer.status === "cancelled"
          ? "Repository setup was cancelled."
          : "Repository setup is unavailable in this conversation."
      );
    }
    if (answer.optionId === "cancel") {
      return blockedResult("Repository setup was cancelled.");
    }
    const repositoryId = answer.text?.trim();
    if (!(repositoryId && z.uuid().safeParse(repositoryId).success)) {
      return blockedResult(
        "Choose a repository from the GitHub repository card to continue."
      );
    }
    const selected = await statusStep({
      repositoryId,
      sourceSessionId: ctx.session.id,
    });
    if (isCodeRepositoryStatusError(selected)) {
      return selected;
    }
    if (selected.ready) {
      return readyResult(selected);
    }
    return blockedResult(
      STATUS_REASONS[selected.reason ?? "select_repository"]
    );
  },
  inputSchema: codeRepositorySetupInput,
  label: {
    start: ({ title }: z.infer<typeof codeRepositorySetupInput>) =>
      `Prepare GitHub${title ? `: ${title}` : " repository"}`,
  },
});

async function statusStep(input: {
  repositoryId?: string;
  sourceSessionId: string;
}): Promise<CodeRepositoryStatusResult> {
  "use step";
  return await getCodeRepositoryStatus(
    input.sourceSessionId,
    input.repositoryId
  );
}
