import { getVercelOidcToken } from "@vercel/oidc";
import { SUBSCRIPTION_MAX_BODY_BYTES } from "@/lib/ai/inference";
import { botFromRequest } from "@/lib/bot-auth";
import { coveredByTokenPass } from "@/lib/bots/models";
import { countModelRequest, runtimeParticipant } from "@/lib/firesides/auth";
import { boundedBody } from "@/lib/firesides/body";

export async function POST(req: Request) {
  const caller = await botFromRequest(req);
  if (caller instanceof Response) {
    return caller;
  }
  const runtime = await runtimeParticipant(req, caller.slug);
  if (
    !(
      runtime && ["gateway", "token-pass"].includes(runtime.participant.billing)
    )
  ) {
    return new Response("unavailable", { status: 403 });
  }
  const { participant, row } = runtime;
  if (
    req.headers.get("ai-language-model-id") !== participant.model ||
    (participant.billing === "token-pass" &&
      !coveredByTokenPass(participant.model))
  ) {
    return new Response("invalid model", { status: 403 });
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await boundedBody(req, SUBSCRIPTION_MAX_BODY_BYTES);
  } catch {
    return new Response("too large", { status: 413 });
  }
  if (
    !(await countModelRequest(
      row.id,
      participant.id,
      runtime.sessionId,
      runtime.revision
    ))
  ) {
    return new Response("Execution limit reached.", { status: 429 });
  }
  try {
    const key =
      participant.billing === "token-pass"
        ? process.env.TOKEN_PASS_API_KEY
        : (process.env.AI_GATEWAY_API_KEY ?? (await getVercelOidcToken()));
    if (!key) {
      return new Response("Connection unavailable.", { status: 409 });
    }
    const headers = new Headers({
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    });
    for (const name of [
      "ai-gateway-protocol-version",
      "ai-language-model-id",
      "ai-language-model-specification-version",
      "ai-language-model-streaming",
    ]) {
      const value = req.headers.get(name);
      if (value) {
        headers.set(name, value);
      }
    }
    const response = await fetch(
      "https://ai-gateway.vercel.sh/v4/ai/language-model",
      {
        body: bytes,
        headers,
        method: "POST",
        redirect: "error",
        signal: req.signal,
      }
    );
    if (!response.ok) {
      return Response.json(
        {
          error: {
            message:
              "The selected AI connection could not complete this request.",
          },
        },
        { status: response.status }
      );
    }
    return new Response(response.body, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type":
          response.headers.get("content-type") ?? "text/event-stream",
      },
      status: response.status,
    });
  } catch {
    return Response.json(
      {
        error: {
          message: "The selected AI connection is temporarily unavailable.",
        },
      },
      { status: 502 }
    );
  }
}
export const maxDuration = 800;
