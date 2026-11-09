import { z } from "zod";
import { getBot } from "@/lib/bots/service";
import {
  DEMO_ID,
  startTeaching,
  stopTeaching,
  teachMessage,
} from "@/lib/live-actions";

interface Ctx {
  params: Promise<{ slug: string }>;
}

const fail = (status: number, error: string) =>
  Response.json({ error }, { status });

async function readyBot(ctx: Ctx) {
  const bot = await getBot((await ctx.params).slug);
  return bot?.sessionId ? bot : null;
}

// Live's Teach: records the user's demonstration on the bot's screen into /data/demos/<id>/.
export async function POST(_req: Request, ctx: Ctx) {
  const bot = await readyBot(ctx);
  if (!bot) {
    return fail(404, "That bot doesn't exist.");
  }
  try {
    const id = await startTeaching(bot);
    return id
      ? Response.json({ id })
      : fail(409, "Its computer isn't running. Open Live again.");
  } catch (error) {
    console.error("teach: could not start", { error, slug: bot.slug });
    return fail(502, "Couldn't start recording. Try again.");
  }
}

// Stop teaching: returns the message the user sends the bot so it learns the recording.
export async function DELETE(req: Request, ctx: Ctx) {
  const parsed = z
    .object({ id: z.string().regex(DEMO_ID) })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(400, "Invalid recording.");
  }
  const bot = await readyBot(ctx);
  if (!bot) {
    return fail(404, "That bot doesn't exist.");
  }
  try {
    const stats = await stopTeaching(bot, parsed.data.id);
    if (!stats) {
      return fail(409, "Its computer isn't running.");
    }
    return Response.json({
      ...stats,
      message: teachMessage(parsed.data.id, stats),
    });
  } catch (error) {
    console.error("teach: could not stop", { error, slug: bot.slug });
    return fail(502, "Couldn't stop recording. Try again.");
  }
}
