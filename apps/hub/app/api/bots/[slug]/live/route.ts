import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { getBot } from "@/lib/bots/service";
import { WAKE_MESSAGE } from "@/lib/chat/items";
import { requestIdOf } from "@/lib/chat/observability";
import { openSession, sendToBot } from "@/lib/chat/send";
import type { BotRow } from "@/lib/db";
import { keepOn } from "@/lib/keep-on";
import {
  type ControlAction,
  desktopControl,
  KEEP_ON_MS,
  NEW_COMPUTER_WAIT_MS,
  openLive,
  WATCH_MS,
} from "@/lib/live";

interface Ctx {
  params: Promise<{ slug: string }>;
}

const fail = (status: number, error: string) =>
  Response.json({ error }, { status });

/** One wake per session and minute: two opens at once send the bot one message (eve dedupes on its id). */
async function wake(bot: BotRow) {
  const h = createHash("sha256")
    .update(`${bot.sessionId}:wake:${Math.floor(Date.now() / 60_000)}`)
    .digest("hex");
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  await sendToBot(bot, { files: [], id, text: WAKE_MESSAGE });
}

// Preconnects the shared, control-capable live screen. The client starts view-only and activates
// input only after PATCH acquires the VM lease. The app opens it as soon as a bot's chat opens.
export async function POST(req: Request, { params }: Ctx) {
  const requestId = requestIdOf(req) ?? randomUUID();
  const parsed = z
    .object({ mode: z.enum(["observe", "control"]) })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(400, "Invalid mode.");
  }
  let bot = await getBot((await params).slug);
  if (!bot) {
    return fail(404, "That bot doesn't exist.");
  }
  if (bot.status !== "ready") {
    return fail(409, "The bot is still being set up.");
  }
  let live: Awaited<ReturnType<typeof openLive>>;
  try {
    // No session yet (a new bot, or one whose session was replaced): open one. eve prepares a new
    // session's computer in the background, so that wait is short.
    const fresh = !bot.sessionId;
    if (!bot.sessionId) {
      bot = await openSession(bot);
    }
    // POST only preconnects the shared screen. Always return the control-capable
    // credentials; the client remains view-only until PATCH acknowledges its lease.
    live = await openLive(
      bot,
      "control",
      fresh ? NEW_COMPUTER_WAIT_MS : 0,
      requestId
    );
    if (!live) {
      // Only the bot can create its computer (eve sets up its Drive and env): a hidden first message
      // has it boot the screen, and the screen opens once the computer exists.
      await wake(bot);
      live = await openLive(bot, "control", NEW_COMPUTER_WAIT_MS, requestId);
    }
  } catch (error) {
    console.error("live: could not open the screen", { error, slug: bot.slug });
    return fail(502, "Couldn't open the screen. Try again in a moment.");
  }
  if (!live) {
    return fail(409, "Its computer didn't respond. Try again in a moment.");
  }
  await keepOn(bot, KEEP_ON_MS);
  return Response.json(live, { headers: { "Cache-Control": "no-store" } });
}

/** Activates or releases the VM's exclusive input lease. POST above only preconnects the shared screen. */
export async function PATCH(req: Request, { params }: Ctx) {
  const requestId = requestIdOf(req) ?? randomUUID();
  const parsed = z
    .object({ mode: z.enum(["observe", "control"]), viewerId: z.uuid() })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(400, "Invalid control request.");
  }
  const bot = await getBot((await params).slug);
  if (!bot) {
    return fail(404, "That bot doesn't exist.");
  }
  if (bot.status !== "ready") {
    return fail(409, "The bot is still being set up.");
  }

  // A control click is an explicit user action, so it may start the live helper if the preconnect
  // has not reached the VM yet. Watch/release never wakes a stopped sandbox.
  if (parsed.data.mode === "control") {
    let live: Awaited<ReturnType<typeof openLive>>;
    try {
      live = await openLive(bot, "control", 0, requestId);
    } catch (error) {
      console.error("live: could not activate the screen", {
        error,
        slug: bot.slug,
      });
      return fail(502, "Couldn't activate the screen. Try again in a moment.");
    }
    if (!live) {
      return fail(409, "The computer is not ready yet. Try again in a moment.");
    }
  }
  const action: ControlAction =
    parsed.data.mode === "control" ? "acquire" : "release";
  let result: Awaited<ReturnType<typeof desktopControl>>;
  try {
    result = await desktopControl(bot, action, parsed.data.viewerId, requestId);
  } catch (error) {
    console.error("live: control helper failed", {
      action,
      error,
      slug: bot.slug,
    });
    return fail(
      503,
      "Control is temporarily unavailable. Try again in a moment."
    );
  }
  if (result.ok) {
    await keepOn(bot, parsed.data.mode === "control" ? KEEP_ON_MS : WATCH_MS);
    return Response.json(result);
  }
  if (action === "release" && result.code === "CONTROL_LOST") {
    return Response.json(result);
  }
  return Response.json(result, {
    status: result.code === "CONTROL_UNAVAILABLE" ? 503 : 409,
  });
}

// The app's heartbeat every 30 s while the screen is open.
export async function PUT(req: Request, { params }: Ctx) {
  const bot = await getBot((await params).slug);
  if (!bot) {
    return fail(404, "That bot doesn't exist.");
  }
  const body = await req.json().catch(() => null);
  const parsed = z.object({ viewerId: z.uuid() }).safeParse(body);
  if (body !== null && !parsed.success) {
    return fail(400, "Invalid control heartbeat.");
  }
  if (parsed.success) {
    let result: Awaited<ReturnType<typeof desktopControl>>;
    try {
      result = await desktopControl(bot, "renew", parsed.data.viewerId);
    } catch (error) {
      console.error("live: control heartbeat failed", {
        error,
        slug: bot.slug,
      });
      return fail(
        503,
        "Control is temporarily unavailable. Try again in a moment."
      );
    }
    if (!result.ok) {
      return Response.json(result, {
        status: result.code === "CONTROL_UNAVAILABLE" ? 503 : 409,
      });
    }
    await keepOn(bot, WATCH_MS);
    return Response.json(result);
  }
  await keepOn(bot, WATCH_MS);
  return Response.json({ ok: true });
}

export const maxDuration = 300;
