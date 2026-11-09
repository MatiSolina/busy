import { z } from "zod";
import { sseResponse } from "@/lib/chat/sse";
import { codeError, codeJson } from "@/lib/code-tasks/http";
import { projectTask } from "@/lib/code-tasks/runtime";
import { getPublicTask, listEvents } from "@/lib/code-tasks/store";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const id = z.uuid().parse((await context.params).id);
    if (!(await getPublicTask(id))) {
      return codeJson({ error: "Code task not found." }, 404);
    }
    const query = new URL(request.url).searchParams;
    let after = Number(
      request.headers.get("last-event-id") || query.get("after") || 0
    );
    if (!Number.isSafeInteger(after) || after < 0) {
      return codeJson({ error: "Invalid event cursor." }, 400);
    }
    return sseResponse(request, async (send, closed) => {
      for (let tick = 0; tick < 25 && !closed(); tick += 1) {
        if (tick % 3 === 0) {
          // biome-ignore lint/performance/noAwaitInLoops: live polling must project before its corresponding snapshot.
          await projectTask(id).catch(() => undefined);
        }
        const task = await getPublicTask(id);
        if (!task) {
          return;
        }
        send("task", task);
        const events = await listEvents(id, after, 200);
        for (const event of events) {
          send("event", event, event.seq);
          after = event.seq;
        }
        if (
          ["ready", "cancelled", "failed", "needs_attention"].includes(
            task.status
          ) &&
          events.length < 200
        ) {
          send("end", {});
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    });
  } catch (error) {
    return codeError(error);
  }
}
export const maxDuration = 60;
