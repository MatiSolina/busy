import { type TaskRouteContext, taskCommand } from "@/lib/code-tasks/service";
export const POST = (request: Request, context: TaskRouteContext) =>
  taskCommand(request, context, true);
export const maxDuration = 60;
