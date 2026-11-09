import { z } from "zod";
import { getBot } from "@/lib/bots/service";
import { botCall } from "@/lib/chat/store";
import { answerInteraction } from "@/lib/eve/client";
import { fillForm } from "@/lib/live-actions";

interface Ctx {
  params: Promise<{ slug: string }>;
}

const input = z.object({
  fields: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u),
        // A ref or a selector; never something the browser CLI could read as an option.
        target: z
          .string()
          .min(1)
          .max(300)
          .refine((t) => !t.startsWith("-")),
        value: z.string().min(1).max(500),
      })
    )
    .min(1)
    .max(8),
  interactionId: z.string().min(1).max(200),
});

// request_form's Submit: the hub types the user's values into the bot's screen, then answers the
// bot's question with which fields worked. The values are secrets: they go to the computer in the
// command's environment and nowhere else. Not logged, not stored, not in the answer or the response.
export async function POST(req: Request, { params }: Ctx) {
  const parsed = input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    // Never echo the issues: they can quote the values.
    return Response.json({ error: "Invalid form." }, { status: 400 });
  }
  const bot = await getBot((await params).slug);
  if (!bot?.sessionId) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  const { fields, interactionId } = parsed.data;
  let failed: string[];
  try {
    failed = await fillForm(bot, fields);
  } catch (error) {
    // Only the error's name: a provider error could carry the request.
    console.error("form: fill failed", {
      error: error instanceof Error ? error.name : "unknown",
      slug: bot.slug,
    });
    failed = fields.map((f) => f.id);
  }
  await answerInteraction(
    botCall(bot.slug),
    bot.sessionId,
    failed.length
      ? { interactionId, optionId: "failed", text: failed.join(",") }
      : { interactionId, optionId: "filled" }
  );
  return Response.json({ failed, ok: failed.length === 0 });
}
