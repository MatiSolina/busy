import { z } from "zod";
import { getBot } from "@/lib/bots/service";
import { botCall } from "@/lib/chat/store";
import { answerInteraction } from "@/lib/eve/client";

interface Ctx {
  params: Promise<{ slug: string }>;
}

// The chat's answer to a native eve question, approval, or sign-in interaction.
export async function POST(req: Request, { params }: Ctx) {
  const parsed = z
    .object({
      interactionId: z.string().min(1).max(200),
      optionId: z.string().min(1).max(200).optional(),
      text: z.string().max(20_000).optional(),
    })
    .refine(
      (value) => Boolean(value.optionId || value.text),
      "An option or text answer is required"
    )
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return new Response("bad request", { status: 400 });
  }
  const bot = await getBot((await params).slug);
  if (!bot?.sessionId) {
    return new Response("not found", { status: 404 });
  }
  await answerInteraction(botCall(bot.slug), bot.sessionId, parsed.data);
  return Response.json({ ok: true });
}
