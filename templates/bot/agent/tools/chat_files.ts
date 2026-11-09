import { defineTool } from "eve/tools";
import { z } from "zod";
import { CHAT_DIR, chatFilePath } from "../lib/chat-file-path";
import { hubFetch } from "../lib/hub";
import { lazyTool } from "../lib/lazy-tools";

// Files of this bot's chat with the user, from Blob: always current, even when /data is a stale snapshot
// in a consultation (a Drive snapshot only sees writes once the main computer sleeps).
export default lazyTool(
  "files",
  defineTool({
    description:
      "The files in your chat with the user (the ones you sent and the ones the user sent you), in their latest version. Without `id` it lists them; with `id` it copies one to /workspace/chat/ and gives you the path.",
    async execute({ id }, ctx) {
      if (!id) {
        const res = await hubFetch("/api/bot/files");
        return res.ok
          ? { files: await res.json() }
          : { error: `Couldn't list the files (${res.status})` };
      }
      const res = await hubFetch(`/api/bot/files/${id}`);
      if (!res.ok) {
        return { error: `Couldn't find the file (${res.status})` };
      }
      const { url, filename } = (await res.json()) as {
        url: string;
        filename: string;
      };
      const download = await fetch(url);
      if (!download.ok) {
        return { error: `Couldn't download the file (${download.status})` };
      }
      const path = chatFilePath(id, filename);
      // Written next to its destination and renamed into place, so a retry or a
      // concurrent copy of the same id never leaves a half-written file at `path`.
      const partial = `${CHAT_DIR}/.${id}.${crypto.randomUUID()}.part`;
      const sandbox = await ctx.getSandbox();
      await sandbox.writeBinaryFile({
        content: new Uint8Array(await download.arrayBuffer()),
        path: partial,
      });
      const moved = await sandbox.run({
        command: 'mv -f -- "$BUSY_CHAT_PART" "$BUSY_CHAT_PATH"',
        env: { BUSY_CHAT_PART: partial, BUSY_CHAT_PATH: path },
      });
      if (moved.exitCode !== 0) {
        await sandbox.removePath({ force: true, path: partial });
        return { error: "Couldn't save the file in /workspace/chat" };
      }
      return { path };
    },
    inputSchema: z.object({
      id: z.uuid().optional().describe("The id of a file from the list"),
    }),
  })
);
