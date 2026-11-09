import { cleanupCodeTaskWorkspaces } from "@/lib/code-tasks/cleanup";
import { codeJson } from "@/lib/code-tasks/http";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  return codeJson(await cleanupCodeTaskWorkspaces({ limit: 3 }));
}

export const maxDuration = 300;
