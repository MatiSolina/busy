import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getBot } from "@/lib/bots/service";
import { requestIdOf } from "@/lib/chat/observability";
import { authorizeDevRelay } from "@/lib/dev-relay-access";
import {
  type ControlAction,
  desktopControlInSandbox,
  NEW_COMPUTER_WAIT_MS,
  openLive,
  stopComputerObserved,
} from "@/lib/live";

// The live screen uses the same registered, expiring OIDC grant as the bot relay.
// The deployed hub opens or stops the computer without sharing its signing key.
interface Ctx {
  params: Promise<{ slug: string }>;
}

export async function POST(req: Request, { params }: Ctx) {
  const requestId = requestIdOf(req) ?? randomUUID();
  const denied = await authorizeDevRelay(req);
  if (denied) {
    return denied;
  }
  const parsed = z
    .object({
      mode: z.enum(["observe", "control"]),
      waitMs: z.number().int().min(0).max(NEW_COMPUTER_WAIT_MS).default(0),
    })
    .safeParse(await req.json().catch(() => null));
  const bot = await getBot((await params).slug);
  if (!(parsed.success && bot)) {
    return new Response("bad request", { status: 400 });
  }
  // POST is a shared preconnect: always return the control-capable credentials. The browser starts
  // noVNC in view-only mode and asks PATCH for the exclusive input lease later.
  const live = await openLive(bot, "control", parsed.data.waitMs, requestId);
  return live
    ? Response.json(live, { headers: { "Cache-Control": "no-store" } })
    : new Response("no computer", { status: 409 });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const requestId = requestIdOf(req) ?? randomUUID();
  const denied = await authorizeDevRelay(req);
  if (denied) {
    return denied;
  }
  const bot = await getBot((await params).slug);
  if (!bot) {
    return new Response("bad request", { status: 400 });
  }
  await stopComputerObserved(bot, "http", requestId);
  return Response.json({ ok: true });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const denied = await authorizeDevRelay(req);
  if (denied) {
    return denied;
  }
  const parsed = z
    .object({
      action: z.enum(["acquire", "renew", "release"]),
      viewerId: z.uuid(),
    })
    .safeParse(await req.json().catch(() => null));
  const bot = await getBot((await params).slug);
  if (!(parsed.success && bot)) {
    return new Response("bad request", { status: 400 });
  }
  const result = await desktopControlInSandbox(
    bot,
    parsed.data.action as ControlAction,
    parsed.data.viewerId
  );
  let status = 409;
  if (result.ok || result.code === "CONTROL_LOST") {
    status = 200;
  } else if (result.code === "CONTROL_UNAVAILABLE") {
    status = 503;
  }
  return Response.json(result, { status });
}

export const maxDuration = 150;
