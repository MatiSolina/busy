import { historyEmbeddingBatch } from "../lib/history-embeddings";

function batchStep(botId: string | null): Promise<boolean> {
  "use step";
  return historyEmbeddingBatch(botId);
}

/**
 * Durable semantic-index maintenance. A missing/failed embedding provider
 * leaves rows pending and lexical search continues to work; a later cron can
 * resume the same model/content rows without duplicating vectors.
 */
export async function historyEmbeddingsWorkflow(botId: string | null = null) {
  "use workflow";
  for (let batch = 0; batch < 8; batch += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: workflow steps must be sequential to bound provider load.
    if (!(await batchStep(botId))) {
      return;
    }
  }
}
