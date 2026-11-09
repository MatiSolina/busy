import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import { aiIssue, issueResponse } from "@/lib/ai/errors";
import {
  AiProviderUnavailableError,
  assertSubscriptionModelAvailable,
} from "@/lib/ai/settings";
import { requestBotDeletion } from "@/lib/bots/deletion";
import {
  billingFits,
  botPatch,
  botProgress,
  DeployRetryConflictError,
  deployRunArg,
  getBot,
  markDeployStartFailed,
  patchBot,
  publicBot,
} from "@/lib/bots/service";
import { requestIdOf } from "@/lib/chat/observability";
import { stopComputerObserved } from "@/lib/live";
import { deleteBotWorkflow } from "@/workflows/delete-bot";
import { deployBotWorkflow } from "@/workflows/deploy-bot";

interface Ctx {
  params: Promise<{ slug: string }>;
}

// Polled by the app while a bot is preparing; deployBotWorkflow advances the state.
export async function GET(_req: Request, { params }: Ctx) {
  const bot = await getBot((await params).slug);
  if (!bot) {
    return issueResponse(aiIssue("not_found"), 404);
  }
  return Response.json({ ...publicBot(bot), progress: await botProgress(bot) });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const bot = await getBot((await params).slug);
  if (!bot) {
    return issueResponse(aiIssue("not_found"), 404);
  }
  const body: unknown = await req.json().catch(() => null);
  const parsed = botPatch.safeParse(body);
  if (!(parsed.success && billingFits({ ...bot, ...parsed.data }))) {
    return issueResponse(aiIssue("invalid_data"), 400);
  }
  // `{ "retry": true }`: redeploy a creating/failed bot as it is, without a config change.
  const retry =
    typeof body === "object" &&
    body !== null &&
    (body as { retry?: unknown }).retry === true;
  if (parsed.data.billing !== undefined || parsed.data.model !== undefined) {
    try {
      await assertSubscriptionModelAvailable(
        parsed.data.billing ?? bot.billing,
        parsed.data.model ?? bot.model
      );
    } catch (error) {
      if (error instanceof AiProviderUnavailableError) {
        return issueResponse(
          error.issue ?? aiIssue("provider_unconfigured"),
          409
        );
      }
      return issueResponse(aiIssue("provider_unavailable"), 503);
    }
  }
  let saved: Awaited<ReturnType<typeof patchBot>>;
  try {
    saved = await patchBot(bot, parsed.data, { retry });
  } catch (error) {
    if (error instanceof DeployRetryConflictError) {
      return issueResponse(
        aiIssue("could_not_save", null, {
          message: "This bot isn't stuck or failed: there is nothing to retry.",
        }),
        409
      );
    }
    throw error;
  }
  const { redeploy } = saved;
  let row = saved.bot;
  if (redeploy) {
    // The new generation is saved first; a run of an older one stops at its next step.
    try {
      await start(deployBotWorkflow, [deployRunArg(row)]);
    } catch {
      row = await markDeployStartFailed(row);
    }
  }
  return Response.json(publicBot(row));
}

/**
 * Accepts the deletion durably and returns 202: the row is marked `deleting` (slug reserved, uploads
 * refused) before anything external happens, and deleteBotWorkflow finishes it. If starting the
 * workflow fails, the library verification cron restarts it from the row (lib/bots/deletion.ts).
 */
export async function DELETE(req: Request, { params }: Ctx) {
  const bot = await getBot((await params).slug);
  if (!bot) {
    return issueResponse(aiIssue("not_found"), 404);
  }
  const deletion = await requestBotDeletion(bot.id);
  if (!deletion) {
    return issueResponse(aiIssue("not_found"), 404);
  }
  // Best effort before its project goes: a computer left on would only end at its own timeout.
  await stopComputerObserved(
    bot,
    "http",
    requestIdOf(req) ?? randomUUID()
  ).catch(() => {
    // Deletion continues; the sandbox timeout remains the fallback cleanup.
  });
  if (deletion.start) {
    await start(deleteBotWorkflow, [bot.id, deletion.token]).catch(() => {
      // The row stays `deleting` with a short lease; the cron restarts it after the lease.
    });
  }
  return Response.json({ deletion: "accepted" }, { status: 202 });
}
