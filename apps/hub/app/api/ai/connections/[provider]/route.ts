import {
  aiJson,
  authenticatedUser,
  boundedJson,
  json,
  loopbackRedirectForRequest,
  providerParam,
  startInput,
  subscriptionResponseHeaders,
} from "@/lib/ai/subscription-http";
import {
  disconnectConnection,
  listSubscriptionConnections,
  startConnection,
} from "@/lib/ai/subscription-store";

interface Context {
  params: Promise<{ provider: string }>;
}

export async function GET(_req: Request, { params }: Context) {
  if (!(await authenticatedUser())) {
    return aiJson("unauthorized", null, 401);
  }
  const provider = providerParam((await params).provider);
  if (!provider) {
    return aiJson("provider_not_found", null, 404);
  }
  const connections = await listSubscriptionConnections();
  const connection =
    connections.find((entry) => entry.provider === provider) ?? null;
  return Response.json(
    { connection },
    { headers: subscriptionResponseHeaders }
  );
}

export async function POST(_req: Request, { params }: Context) {
  const user = await authenticatedUser();
  if (!user) {
    return aiJson("unauthorized", null, 401);
  }
  const provider = providerParam((await params).provider);
  if (!provider) {
    return aiJson("provider_not_found", null, 404);
  }
  const body = await boundedJson(_req, { allowEmpty: true });
  const parsed = startInput.safeParse(body);
  if (!parsed.success) {
    return aiJson("invalid_data", provider, 400);
  }
  if (provider === "chatgpt") {
    let redirectUri: string | null;
    try {
      redirectUri = loopbackRedirectForRequest(_req, parsed.data.redirectUri);
    } catch {
      return aiJson("invalid_redirect_uri", provider, 400);
    }
    if (!redirectUri) {
      return aiJson("chatgpt_desktop_required", provider, 409);
    }
    try {
      return json(await startConnection(provider, user, { redirectUri }));
    } catch {
      return aiJson("could_not_start_connection", provider, 503);
    }
  }
  try {
    return json(await startConnection(provider, user));
  } catch {
    return aiJson("could_not_start_connection", provider, 503);
  }
}

export async function DELETE(_req: Request, { params }: Context) {
  if (!(await authenticatedUser())) {
    return aiJson("unauthorized", null, 401);
  }
  const provider = providerParam((await params).provider);
  if (!provider) {
    return aiJson("provider_not_found", null, 404);
  }
  try {
    await disconnectConnection(provider);
    return json({ ok: true });
  } catch {
    return aiJson("could_not_disconnect", provider, 503);
  }
}
