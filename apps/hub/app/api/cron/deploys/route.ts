import { start } from "workflow/api";
import { deployRunArg, reconcileDeploys } from "@/lib/bots/service";
import { deployBotWorkflow } from "@/workflows/deploy-bot";

// Every 5 minutes: a creating/deploying generation whose workflow should be over gets one new run
// of the same generation (it adopts the recorded deployment), bounded; then a retryable failure.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  return Response.json(
    await reconcileDeploys((target) =>
      start(deployBotWorkflow, [
        deployRunArg({ deployGeneration: target.generation, id: target.botId }),
      ])
    )
  );
}

export const maxDuration = 60;
