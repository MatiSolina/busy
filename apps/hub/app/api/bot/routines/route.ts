import { botFromRequest } from "@/lib/bot-auth";
import { getBot } from "@/lib/bots/service";
import {
  parseRoutineBody,
  readRoutineJson,
  routineJson,
  routineValidationError,
} from "@/lib/routines/http";
import { createRoutine, listRoutines } from "@/lib/routines/store";
import { routineInputSchema } from "@/lib/routines/validation";

export async function GET(req: Request) {
  try {
    const caller = await botFromRequest(req);
    if (caller instanceof Response) {
      return routineJson({ error: "unauthorized" }, caller.status);
    }
    const bot = await getBot(caller.slug);
    if (!bot) {
      return routineJson({ error: "Bot not found." }, 404);
    }
    return routineJson({ routines: await listRoutines(bot.id) });
  } catch (error) {
    return routineValidationError(error);
  }
}

export async function POST(req: Request) {
  try {
    const caller = await botFromRequest(req);
    if (caller instanceof Response) {
      return routineJson({ error: "unauthorized" }, caller.status);
    }
    const bot = await getBot(caller.slug);
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
