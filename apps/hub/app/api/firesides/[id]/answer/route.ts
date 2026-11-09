import { after } from "next/server";
import { z } from "zod";
import { answerInteraction } from "@/lib/eve/client";
import { fireError, fireJson } from "@/lib/firesides/http";
import { scheduleFireside } from "@/lib/firesides/schedule";
import { getFireside, publicFireside } from "@/lib/firesides/store";
import { firesideCall } from "@/lib/firesides/transport";

interface Ctx {
  params: Promise<{ id: string }>;
}
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const input = z
    .object({
      interactionId: z.string().min(1).max(200),
      optionId: z.string().max(200).optional(),
      participantId: z.uuid(),
      revision: z.number().int(),
      text: z.string().max(20_000).optional(),
    })
    .refine((v) => Boolean(v.optionId || v.text))
    .safeParse(await req.json().catch(() => null));
  if (!(z.uuid().safeParse(id).success && input.success)) {
    return fireJson({ error: "Invalid answer." }, 400);
  }
  const fire = await getFireside(id);
  const active = fire?.state.active;
  if (
    !(
      fire &&
      active &&
      fire.state.status === "running" &&
      fire.state.revision === input.data.revision
    )
  ) {
    return fireJson({ error: "This turn has ended." }, 409);
  }
  const participant = fire.state.participants[active.participant];
  const shown = publicFireside(fire).active?.items.some(
    (item) =>
      (item.kind === "interaction" || item.kind === "login") &&
      item.interactionId === input.data.interactionId &&
      (item.state ?? "open") === "open"
  );
  if (
    !participant.sessionId ||
    participant.id !== input.data.participantId ||
    !shown
  ) {
    return fireJson({ error: "This question is no longer open." }, 409);
  }
  try {
    await answerInteraction(
      firesideCall(id, participant),
      participant.sessionId,
      input.data
    );
    after(() => scheduleFireside(id));
    return fireJson({ ok: true });
  } catch (error) {
    return fireError(error);
  }
}
