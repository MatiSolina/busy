import { codeError, codeJson } from "@/lib/code-tasks/http";
import { addCodeRepository } from "@/lib/code-tasks/service";
import { listRepositories } from "@/lib/code-tasks/store";
export const POST = addCodeRepository;
export async function GET() {
  try {
    return codeJson({ repositories: await listRepositories() });
  } catch (error) {
    return codeError(error);
  }
}
export const maxDuration = 60;
