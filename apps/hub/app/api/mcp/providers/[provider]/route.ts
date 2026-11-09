import { mcpJson } from "@/lib/mcp/http";
import {
  getProviderSetup,
  InvalidProviderClientInputError,
  isRegisteredProvider,
  parseProviderClientInput,
  providerSetup,
  saveProviderClient,
} from "@/lib/mcp/provider-clients";

interface Context {
  params: Promise<{ provider: string }>;
}

export async function GET(_req: Request, { params }: Context) {
  const { provider } = await params;
  if (!isRegisteredProvider(provider)) {
    return mcpJson({ error: "Unknown OAuth provider." }, 404);
  }
  try {
    return mcpJson(await getProviderSetup(provider));
  } catch {
    return mcpJson({ error: "Couldn't load provider configuration." }, 503);
  }
}

export async function PUT(req: Request, { params }: Context) {
  const { provider } = await params;
  if (!isRegisteredProvider(provider)) {
    return mcpJson({ error: "Unknown OAuth provider." }, 404);
  }
  const input = parseProviderClientInput(await req.json().catch(() => null));
  if (!input) {
    return mcpJson({ error: "Client ID and client secret are required." }, 400);
  }
  try {
    const saved = await saveProviderClient(provider, input);
    // Construct this from the validated input and revision, without another
    // decrypt/read round-trip that could expose a transient stale row.
    return mcpJson({
      ...providerSetup(provider, saved.version, input.clientId),
      changed: saved.changed,
    });
  } catch (error) {
    if (error instanceof InvalidProviderClientInputError) {
      return mcpJson(
        { error: "A client secret is required for this client ID." },
        400
      );
    }
    return mcpJson({ error: "Couldn't save provider configuration." }, 503);
  }
}
