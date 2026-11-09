import { z } from "zod";
import { botFromRequest } from "@/lib/bot-auth";
import { getBot } from "@/lib/bots/service";
import { holdOn } from "@/lib/keep-on";
import {
  claimShutdown,
  confirmShutdown,
  isWatched,
  releaseHold,
  releaseShutdown,
  reportSandbox,
} from "@/lib/live";

const noStore = { "Cache-Control": "no-store" };

// Bots on an older template ask this before stopping their computer: someone watching keeps it on.
export async function GET(req: Request) {
  const caller = await botFromRequest(req);
  if (caller instanceof Response) {
    return caller;
  }
  const bot = await getBot(caller.slug);
  return Response.json(
    { watched: bot ? isWatched(bot) : false },
    { headers: noStore }
  );
}

const sessionId = z.string().min(1).max(200);
const claimed = z.object({
  claim: z.uuid().nullable(),
  generation: z.number().int().nullable(),
  sessionId,
});
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("claim"), sessionId }),
  claimed.extend({ action: z.enum(["verify", "commit", "release"]) }),
  z.object({ action: z.enum(["hold", "unhold"]), sessionId }),
  z.object({
    action: z.literal("sandbox"),
    name: z.string().min(1).max(128),
    sessionId,
  }),
]);

/**
 * The bot's computer handshake (H-16/H-17/H-18), authenticated by the bot's OIDC token:
 * - claim → verify → commit → release: the suspend hook's permission to stop its session's
 *   computer. The hub coordinates only the bot's current session (Live, chat keep-on, login
 *   holds); for any other session it grants a `null` claim that stays valid while that session
 *   isn't the current one.
 * - hold / unhold: request_login keeps the computer alive while the user logs in, bounded.
 * - sandbox: the real sandbox name of the bot's current session.
 */
export async function POST(req: Request) {
  const caller = await botFromRequest(req);
  if (caller instanceof Response) {
    return caller;
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid computer request.", ok: false },
      { headers: noStore, status: 400 }
    );
  }
  const bot = await getBot(caller.slug);
  if (!bot) {
    return Response.json(
      { error: "That bot doesn't exist.", ok: false },
      { headers: noStore, status: 404 }
    );
  }
  const body = parsed.data;
  const current = bot.sessionId === body.sessionId;
  switch (body.action) {
    case "claim": {
      if (!current) {
        return Response.json(
          { claim: null, generation: null, ok: true },
          { headers: noStore }
        );
      }
      const claim = await claimShutdown(bot.id, body.sessionId);
      return Response.json(
        claim
          ? { claim: claim.claim, generation: claim.generation, ok: true }
          : { ok: false },
        { headers: noStore }
      );
    }
    case "verify":
    case "commit": {
      if (body.claim === null || body.generation === null) {
        // A session the hub doesn't coordinate stays free while it isn't the current one.
        return Response.json(
          { ok: body.claim === null && !current },
          { headers: noStore }
        );
      }
      const ok =
        current &&
        (await confirmShutdown(
          bot.id,
          {
            claim: body.claim,
            generation: body.generation,
            sessionId: body.sessionId,
          },
          body.action === "commit" ? "stopping" : "checking"
        ));
      return Response.json({ ok }, { headers: noStore });
    }
    case "release": {
      if (body.claim) {
        await releaseShutdown(bot.id, body.claim);
      }
      return Response.json({ ok: true }, { headers: noStore });
    }
    case "hold": {
      const holdUntil = await holdOn(bot, body.sessionId);
      return holdUntil
        ? Response.json(
            { holdUntil: holdUntil.toISOString(), ok: true },
            { headers: noStore }
          )
        : Response.json(
            { ok: false, reason: "session" },
            { headers: noStore, status: 409 }
          );
    }
    case "unhold": {
      await releaseHold(bot.id, body.sessionId);
      return Response.json({ ok: true }, { headers: noStore });
    }
    case "sandbox": {
      const result = await reportSandbox(bot, body.sessionId, body.name);
      const status = { invalid: 400, missing: 422, session: 409, stored: 200 }[
        result
      ];
      return Response.json(
        { ok: result === "stored", reason: result },
        { headers: noStore, status }
      );
    }
    default:
      return Response.json({ ok: false }, { headers: noStore, status: 400 });
  }
}
