import { botFromRequest } from "@/lib/bot-auth";
import {
  consultationCredentialInput,
  issueConsultationCredential,
} from "@/lib/chat/consultation-credential";

const NO_STORE = { "cache-control": "no-store" };

// A bot asks for a short-lived credential to consult one peer (H-26, docs/consultations.md).
export async function POST(req: Request) {
  const caller = await botFromRequest(req);
  if (caller instanceof Response) {
    return caller;
  }
  const input = consultationCredentialInput.safeParse(
    await req.json().catch(() => null)
  );
  if (!input.success) {
    return Response.json(
      { error: "Name the bot to consult by its id." },
      { headers: NO_STORE, status: 400 }
    );
  }
  const result = await issueConsultationCredential(caller.slug, input.data.to);
  if (!result.ok) {
    return Response.json(
      { error: result.error },
      { headers: NO_STORE, status: result.status }
    );
  }
  return Response.json(
    {
      expiresAt: result.credential.expiresAt,
      to: result.toBotId,
      token: result.credential.token,
    },
    { headers: NO_STORE }
  );
}
