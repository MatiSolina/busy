import { codeJson } from "@/lib/code-tasks/http";
import { recoverCodeTasks } from "@/lib/code-tasks/runtime";
import { recoverFiresides } from "@/lib/firesides/runtime";
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const [tasks, firesides] = await Promise.all([
    recoverCodeTasks(),
    recoverFiresides(),
  ]);
  return codeJson({ ...tasks, ...firesides });
}
export const maxDuration = 60;
