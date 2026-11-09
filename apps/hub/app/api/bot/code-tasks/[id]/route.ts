import { type TaskRouteContext, taskDetail } from "@/lib/code-tasks/service";
export const GET = (request: Request, context: TaskRouteContext) =>
  taskDetail(request, context, true);
