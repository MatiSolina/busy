import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { isConsultation } from "../lib/caller";
import { hubFetch } from "../lib/hub";
import { contentTypeOf } from "../lib/mime";

// Sends a file from this bot's computer to the chat. Bytes go straight to Blob (spec 4.4).
// Not in consultations or child sessions: the user-facing root owns delivery, so a child can
// prepare an artifact without racing the root's file card or publishing into the wrong chat.
export default defineDynamic((ctx) =>
  isConsultation(ctx.session.auth) || ctx.session.parent ? null : tool
);

const tool = defineTool({
  description:
    "Send the user a file from your computer: it shows up in the chat as a card the user can view or download. Use it for every deliverable (Word, Excel, PDF, images).",
  async execute({ path }, ctx) {
    // Dynamic capabilities hide this from child sessions before the model call. Keep the
    // check here too: a call that was already advertised must not publish after a session
    // handoff or a stale tool catalog.
    if (
      ctx.session &&
      (isConsultation(ctx.session.auth) || ctx.session.parent)
    ) {
      return {
        error:
          "Only the user-facing session can deliver files; return the artifact path to its parent.",
      };
    }
    const sandbox = await ctx.getSandbox();
    const bytes = await sandbox.readBinaryFile({ path });
    if (!bytes) {
      return { error: `${path} doesn't exist` };
    }
    const name = path.split("/").pop();
    if (!name) {
      throw new Error("A file name is required.");
    }
    const contentType = contentTypeOf(name);

    const reserved = await hubFetch("/api/bot/files", {
      body: JSON.stringify({ contentType, name, size: bytes.byteLength }),
      headers: { "x-busy-session-id": ctx.session.id },
      method: "POST",
    });
    if (!reserved.ok) {
      return { error: `Couldn't reserve the file (${reserved.status})` };
    }
    const { fileId, uploadUrl } = (await reserved.json()) as {
      fileId: string;
      uploadUrl: string;
    };

    const put = await fetch(uploadUrl, {
      body: new Uint8Array(bytes),
      headers: { "content-type": contentType },
      method: "PUT",
    });
    if (!put.ok) {
      return { error: `Couldn't upload the file (${put.status})` };
    }
    const done = await hubFetch(`/api/bot/files/${fileId}/complete`, {
      headers: { "x-busy-session-id": ctx.session.id },
      method: "POST",
    });
    if (!done.ok) {
      return { error: `Couldn't finish sending the file (${done.status})` };
    }
    return { contentType, fileId, name, size: bytes.byteLength };
  },
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe("Absolute path of the file, for example /data/out/report.docx"),
  }),
});
