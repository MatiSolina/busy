import { listCodeTasks, startCodeTask } from "@/lib/code-tasks/service";
export const GET = (request: Request) => listCodeTasks(request, true);
export const POST = startCodeTask;
export const maxDuration = 60;
