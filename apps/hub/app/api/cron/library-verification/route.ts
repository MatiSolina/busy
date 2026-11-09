import { start } from "workflow/api";
import { claimDueBotDeletions } from "@/lib/bots/deletion";
import { deleteBotWorkflow } from "@/workflows/delete-bot";
import { libraryVerificationWorkflow } from "@/workflows/library-verification";

// Every 15 minutes: file promotion/expiry/GC, plus restarting bot deletions whose run failed, died or
// never started (the row is the durable record; claiming leases it so runs do not pile up).
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  await start(libraryVerificationWorkflow, [32]);
  const deletions = await claimDueBotDeletions();
  const restarted = await Promise.allSettled(
    deletions.map(({ botId, token }) =>
      start(deleteBotWorkflow, [botId, token])
    )
  );
  return Response.json(
    {
      deletions: restarted.filter(({ status }) => status === "fulfilled")
        .length,
      started: true,
    },
    { status: 202 }
  );
}
