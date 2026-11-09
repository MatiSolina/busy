import { z } from "zod";
import { publicTaskDiff } from "@/lib/code-tasks/changes";
import { codeError, codeJson } from "@/lib/code-tasks/http";
import { getPublicTask } from "@/lib/code-tasks/store";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const id = z.uuid().parse((await context.params).id);
    const task = await getPublicTask(id);
    if (!task) {
      return codeJson({ error: "Code task not found." }, 404);
    }
    return codeJson(publicTaskDiff(task));
  } catch (error) {
    return codeError(error);
  }
}
