import { getBot } from "@/lib/bots/service";
import {
  parseRoutineBody,
  parseRoutineId,
  readRoutineJson,
  routineJson,
  routineValidationError,
} from "@/lib/routines/http";
import { deleteRoutine, updateRoutine } from "@/lib/routines/store";
import { routinePatchSchema } from "@/lib/routines/validation";

interface Context {
  params: Promise<{ slug: string; id: string }>;
}

export async function PATCH(req: Request, { params }: Context) {
  try {
    const { slug, id: rawId } = await params;
    const id = parseRoutineId(rawId);
    const bot = await getBot(slug);
    if (!bot) {
      return routineJson({ error: "Bot not found." }, 404);
    }
    const patch = parseRoutineBody(
      await readRoutineJson(req),
      routinePatchSchema
    );
    return routineJson({ routine: await updateRoutine(bot.id, id, patch) });
  } catch (error) {
    return routineValidationError(error);
  }
}

export async function DELETE(_req: Request, { params }: Context) {
  try {
    const { slug, id: rawId } = await params;
    const id = parseRoutineId(rawId);
    const bot = await getBot(slug);
    if (!bot) {
      return routineJson({ error: "Bot not found." }, 404);
    }
    await deleteRoutine(bot.id, id);
    return routineJson({ ok: true });
  } catch (error) {
    return routineValidationError(error);
  }
}
