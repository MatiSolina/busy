import { getBot } from "@/lib/bots/service";
import { capabilityError, capabilityJson } from "@/lib/capabilities/http";
import {
  createCapability,
  listCapabilities,
  publicCapability,
} from "@/lib/capabilities/store";
import { parseCapabilityInput } from "@/lib/capabilities/validation";

interface Context {
  params: Promise<{ slug: string }>;
}

export async function GET(_req: Request, { params }: Context) {
  try {
    const bot = await getBot((await params).slug);
    if (!bot) {
      return capabilityJson({ error: "Bot not found." }, 404);
    }
    return capabilityJson({
      capabilities: (await listCapabilities()).map(publicCapability),
    });
  } catch (error) {
    return capabilityError(error);
  }
}

export async function POST(req: Request, { params }: Context) {
  try {
    const bot = await getBot((await params).slug);
    if (!bot) {
      return capabilityJson({ error: "Bot not found." }, 404);
    }
    const input = parseCapabilityInput(await req.json().catch(() => null));
    const row = await createCapability(input);
    return capabilityJson({ capability: publicCapability(row) }, 201);
  } catch (error) {
    return capabilityError(error);
  }
}
