import { after } from "next/server";
import { z } from "zod";
import { getBot } from "@/lib/bots/service";
import { fireError, fireJson } from "@/lib/firesides/http";
import { scheduleFireside } from "@/lib/firesides/schedule";
import {
  createFireside,
  listFiresides,
  publicFireside,
} from "@/lib/firesides/store";

interface Ctx {
  params: Promise<{ slug: string }>;
}
export async function GET(_req: Request, { params }: Ctx) {
  const bot = await getBot((await params).slug);
  if (!bot) {
    return fireJson({ error: "Bot not found." }, 404);
  }
  return fireJson(
    (await listFiresides(bot.id)).map((row) => ({
      createdAt: row.createdAt.toISOString(),
      id: row.id,
      names: Object.values(row.state.participants).map((p) => p.name),
      status: row.status,
    }))
  );
}
export async function POST(req: Request, { params }: Ctx) {
  const input = z
    .object({ id: z.uuid() })
    .safeParse(await req.json().catch(() => null));
  if (!input.success) {
    return fireJson({ error: "Invalid request." }, 400);
  }
  const bot = await getBot((await params).slug);
  if (bot?.status !== "ready") {
    return fireJson({ error: "The bot is not ready." }, 409);
  }
  try {
    const fire = await createFireside(bot, input.data.id);
    after(() => scheduleFireside(fire.id));
    return fireJson(publicFireside(fire));
  } catch (error) {
    return fireError(error);
  }
}
export const maxDuration = 60;
