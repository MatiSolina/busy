import { z } from "zod";
import { authorizeDevRelay } from "@/lib/dev-relay-access";
import { computerInput, fireError, fireJson } from "@/lib/firesides/http";
import { getFireside } from "@/lib/firesides/store";
import { firesideComputer } from "@/lib/firesides/transport";
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await authorizeDevRelay(req);
  if (denied) {
    return denied;
  }
  const { id } = await params;
  const input = z
    .object({
      command: computerInput,
      participantId: z.uuid(),
      sessionId: z.string().max(200),
    })
    .safeParse(await req.json().catch(() => null));
  if (!(z.uuid().safeParse(id).success && input.success)) {
    return fireJson({ error: "Invalid request." }, 400);
  }
  const fire = await getFireside(id);
  const p =
    fire &&
    Object.values(fire.state.participants).find(
      (person) =>
        person.id === input.data.participantId &&
        person.sessionId === input.data.sessionId
    );
  if (
    !p ||
    (input.data.command.kind !== "stop" && fire?.state.status !== "running")
  ) {
    return fireJson({ error: "Computer unavailable." }, 409);
  }
  try {
    return fireJson(await firesideComputer(id, p, input.data.command));
  } catch (error) {
    return fireError(error);
  }
}
export const maxDuration = 60;
