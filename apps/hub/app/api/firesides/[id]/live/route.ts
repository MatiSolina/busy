import { z } from "zod";
import { fireError, fireJson } from "@/lib/firesides/http";
import { getFireside } from "@/lib/firesides/store";
import {
  type ComputerCommand,
  firesideComputer,
} from "@/lib/firesides/transport";

interface Ctx {
  params: Promise<{ id: string }>;
}
async function request(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = z
    .object({
      mode: z.enum(["observe", "control"]).optional(),
      viewerId: z.uuid().optional(),
    })
    .safeParse(await req.json().catch(() => ({})));
  if (!(body.success && z.uuid().safeParse(id).success)) {
    return fireJson({ error: "Invalid request." }, 400);
  }
  const fire = await getFireside(id);
  const participant =
    fire?.state.active &&
    fire.state.participants[fire.state.active.participant];
  if (!(fire && participant?.sessionId) || fire.state.status !== "running") {
    return fireJson({ error: "The participant is no longer working." }, 409);
  }
  if (req.method === "PUT" && !body.data.viewerId) {
    return fireJson({ ok: true });
  }
  let command: ComputerCommand = { kind: "open" };
  if (req.method !== "POST") {
    if (!body.data.viewerId) {
      return fireJson({ error: "Viewer required." }, 400);
    }
    const action = body.data.mode === "control" ? "acquire" : "release";
    command = {
      action: req.method === "PUT" ? "renew" : action,
      kind: "control",
      viewerId: body.data.viewerId,
    };
  }
  try {
    const result = await firesideComputer(id, participant, command);
    return result
      ? fireJson(result)
      : fireJson({ error: "No computer yet." }, 409);
  } catch (error) {
    return fireError(error);
  }
}
export const POST = request;
export const PATCH = request;
export const PUT = request;
export const maxDuration = 60;
