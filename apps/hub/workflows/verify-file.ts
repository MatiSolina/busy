import { promoteVerifiedFile } from "../lib/library-objects";

async function verifyFileStep(botId: string, fileId: string): Promise<void> {
  "use step";
  await promoteVerifiedFile(botId, fileId);
}

/** Verifies a large direct-to-Blob upload outside the short HTTP completion request. */
export async function verifyFileWorkflow(botId: string, fileId: string) {
  "use workflow";
  await verifyFileStep(botId, fileId);
}
