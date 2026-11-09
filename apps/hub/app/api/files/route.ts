import { z } from "zod";
import { getBot } from "@/lib/bots/service";
import { fileInput, isBotUnavailable, registerFile } from "@/lib/files";

const input = z.object({
  botSlug: z.string().max(40),
  contentType: z.string().max(200).default("application/octet-stream"),
  name: z.string().trim().min(1).max(fileInput.maxNameLength),
  size: z.number().int().positive().max(fileInput.maxBytes),
});

// The app reserves a file for a bot, then uploads it directly to Blob.
export async function POST(req: Request) {
  const parsed = input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "The file is invalid or too large" },
      { status: 400 }
    );
  }
  const { botSlug, ...f } = parsed.data;
  const bot = await getBot(botSlug);
  if (!bot) {
    return new Response("not found", { status: 404 });
  }
  try {
    return Response.json(await registerFile(bot, f, "user"));
  } catch (error) {
    if (isBotUnavailable(error)) {
      return Response.json(
        { error: "This bot is being deleted" },
        { status: 409 }
      );
    }
    throw error;
  }
}
