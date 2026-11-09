import { codeAgents } from "@/lib/code-tasks/runtime";
// This function has a private Vercel queue trigger; it is not a public command endpoint.
export async function POST(request: Request) {
  const agents = await codeAgents();
  return agents.gateway.wakeHandler()(request);
}
export const maxDuration = 300;
