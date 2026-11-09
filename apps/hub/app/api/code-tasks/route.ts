import { listCodeTasks } from "@/lib/code-tasks/service";
export const GET = (request: Request) => listCodeTasks(request);
