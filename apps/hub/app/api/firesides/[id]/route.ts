import { after } from "next/server";
import { z } from "zod";
import { commandInput, fireError, fireJson } from "@/lib/firesides/http";
import { scheduleFireside } from "@/lib/firesides/schedule";
import {
  commandFireside,
  getFireside,
  publicFireside,
} from "@/lib/firesides/store";

interface Ctx {
  params: Promise<{ id: string }>;
}
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) {
    return fireJson({ error: "Invalid id." }, 400);
  }
  const fire = await getFireside(id);
  return fire
    ? fireJson(publicFireside(fire))
    : fireJson({ error: "Fireside not found." }, 404);
}
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const command = commandInput.safeParse(await req.json().catch(() => null));
  if (!(z.uuid().safeParse(id).success && command.success)) {
    return fireJson({ error: "Invalid command." }, 400);
  }
  try {
    const fire = await commandFireside(id, command.data);
    if (!fire) {
      return fireJson({ error: "Fireside not found." }, 404);
    }
    after(() => scheduleFireside(id));
    return fireJson(publicFireside(fire));
  } catch (error) {
    return fireError(error);
  }
}
export const maxDuration = 60;
