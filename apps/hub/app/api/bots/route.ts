import { start } from "workflow/api";
import { aiIssue, issueFromError, issueResponse } from "@/lib/ai/errors";
import {
  AiProviderUnavailableError,
  getDefaultAiSelection,
} from "@/lib/ai/settings";
import {
  botCreateInput,
  InvalidBotTemplateError,
  type ResolvedBotCreate,
  resolveBotCreation,
} from "@/lib/bots/creation";
import {
  deployRunArg,
  insertBot,
  listBots,
  markDeployStartFailed,
  publicBot,
  SlugConflictError,
} from "@/lib/bots/service";
import { deployBotWorkflow } from "@/workflows/deploy-bot";

export async function GET() {
  return Response.json((await listBots()).map(publicBot));
}

export async function POST(req: Request) {
  const parsed = botCreateInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return issueResponse(aiIssue("invalid_data"), 400);
  }

  let selection: Awaited<ReturnType<typeof getDefaultAiSelection>>;
  try {
    selection = await getDefaultAiSelection();
  } catch (error) {
    if (error instanceof AiProviderUnavailableError) {
      return issueResponse(
        error.issue ??
          aiIssue("provider_unconfigured", "token-pass", {
            message:
              "Token Pass is not configured. Choose another AI connection in Settings.",
          }),
        409
      );
    }
    return issueResponse(issueFromError(error, null, "could_not_load"), 503);
  }

  let resolved: ResolvedBotCreate;
  try {
    resolved =
      selection.model === undefined
        ? await resolveBotCreation(parsed.data, undefined, selection.billing)
        : await resolveBotCreation(
            parsed.data,
            undefined,
            selection.billing,
            selection.model
          );
  } catch (error) {
    if (error instanceof InvalidBotTemplateError) {
      return issueResponse(aiIssue("invalid_data"), 400);
    }
    return issueResponse(aiIssue("provider_unavailable"), 503);
  }

  let bot: Awaited<ReturnType<typeof insertBot>>;
  try {
    bot = await insertBot(resolved);
  } catch (error) {
    if (error instanceof SlugConflictError) {
      return issueResponse(
        aiIssue("could_not_save", null, {
          message:
            "Another bot with this name was created at the same time. Try again.",
        }),
        409
      );
    }
    throw error;
  }
  try {
    await start(deployBotWorkflow, [deployRunArg(bot)]);
  } catch {
    // The bot exists: it shows a retryable failure instead of staying "creating" forever.
    bot = await markDeployStartFailed(bot);
  }
  return Response.json(publicBot(bot), { status: 201 });
}

export const maxDuration = 60;
