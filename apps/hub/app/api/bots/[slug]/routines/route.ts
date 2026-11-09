import { getBot } from "@/lib/bots/service";
import {
  parseRoutineBody,
  readRoutineJson,
  routineJson,
  routineValidationError,
} from "@/lib/routines/http";
import { createRoutine, listRoutines } from "@/lib/routines/store";
import { routineInputSchema } from "@/lib/routines/validation";

interface Context {
  params: Promise<{ slug: string }>;
}

export async function GET(_req: Request, { params }: Context) {
  try {
    const bot = await getBot((await params).slug);
    if (!bot) {
      return routineJson({ error: "Bot not found." }, 404);
    }
    return routineJson({ routines: await listRoutines(bot.id) });
  } catch (error) {
    return routineValidationError(error);
  }
}

export async function POST(req: Request, { params }: Context) {
  try {
    const bot = await getBot((await params).slug);
    if (!bot) {
      return routineJson({ error: "Bot not found." }, 404);
    }
    const input = parseRoutineBody(
      await readRoutineJson(req),
      routineInputSchema
    );
    return routineJson({ routine: await createRoutine(bot.id, input) }, 201);
  } catch (error) {
    return routineValidationError(error);
  }
}
