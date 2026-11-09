import { z } from "zod";
import { botFromRequest } from "@/lib/bot-auth";
import { runtimeParticipant } from "@/lib/firesides/auth";
import { updateFireside } from "@/lib/firesides/store";

export async function GET(req: Request) {
  const caller = await botFromRequest(req);
  if (caller instanceof Response) {
    return caller;
  }
  const runtime = await runtimeParticipant(req, caller.slug);
  if (!runtime) {
    return new Response("unavailable", { status: 403 });
  }
  if (!runtime.participant.memory) {
    return new Response("not found", { status: 404 });
  }
  return Response.json(
    {
      content: runtime.participant.memory,
      version: runtime.participant.memoryVersion,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
export async function PUT(req: Request) {
  const caller = await botFromRequest(req);
  if (caller instanceof Response) {
    return caller;
  }
  const runtime = await runtimeParticipant(req, caller.slug);
  if (!runtime) {
    return new Response("unavailable", { status: 403 });
  }
  const body = z
    .object({
      content: z.string().max(262_144),
      expectedVersion: z.number().int().nullable(),
    })
    .safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return new Response("bad request", { status: 400 });
  }
  let conflict = false;
  const row = await updateFireside(runtime.row.id, (state) => {
    const participant = Object.values(state.participants).find(
      (p) => p.id === runtime.participant.id
    );
    if (
      !participant ||
      state.status !== "running" ||
      state.active?.revision !== runtime.revision ||
      participant.sessionId !== runtime.sessionId ||
      participant.memoryVersion !== (body.data.expectedVersion ?? 0)
    ) {
      conflict = true;
      return;
    }
    participant.memory = body.data.content;
    participant.memoryVersion += 1;
  });
  if (!row || conflict) {
    return new Response("version conflict", { status: 409 });
  }
  const participant = Object.values(row.state.participants).find(
    (p) => p.id === runtime.participant.id
  );
  return Response.json({
    content: participant?.memory,
    version: participant?.memoryVersion,
  });
}
