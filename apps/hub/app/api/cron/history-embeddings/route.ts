import { start } from "workflow/api";
import { historyEmbeddingsWorkflow } from "@/workflows/history-embeddings";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  if (
    process.env.HISTORY_EMBEDDINGS_ENABLED !== "1" ||
    !process.env.HISTORY_EMBEDDING_MODEL
  ) {
    return Response.json({ enabled: false });
  }
  await start(historyEmbeddingsWorkflow, [null]);
  return Response.json({ enabled: true, started: true }, { status: 202 });
}
