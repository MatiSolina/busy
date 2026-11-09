import { capabilityError, capabilityJson } from "@/lib/capabilities/http";
import {
  createCapability,
  listCapabilities,
  publicCapability,
} from "@/lib/capabilities/store";
import { parseCapabilityInput } from "@/lib/capabilities/validation";

// Capabilities are app configuration. The hub proxy supplies the signed-in
// session gate and same-origin write protection before this handler runs.
export async function GET() {
  try {
    return capabilityJson({
      capabilities: (await listCapabilities()).map(publicCapability),
    });
  } catch (error) {
    return capabilityError(error);
  }
}

export async function POST(req: Request) {
  try {
    const input = parseCapabilityInput(await req.json().catch(() => null));
    const row = await createCapability(input);
    return capabilityJson({ capability: publicCapability(row) }, 201);
  } catch (error) {
    return capabilityError(error);
  }
}
