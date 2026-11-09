import { botFromRequest } from "@/lib/bot-auth";
import { runtimeParticipant } from "@/lib/firesides/auth";

export async function GET(req: Request) {
  const caller = await botFromRequest(req);
  if (caller instanceof Response) {
    return caller;
  }
  const runtime = await runtimeParticipant(req, caller.slug);
  if (!runtime) {
    return new Response("unavailable", { status: 403 });
  }
  const { participant } = runtime;
  return Response.json(
    {
      billing: participant.billing,
      model: participant.model,
      name: participant.name,
      workspace: `busy-fireside-${participant.id}`,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
