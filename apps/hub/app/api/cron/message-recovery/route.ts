import { reconcileMessages } from "@/lib/chat/attempts";
import { endOrphanSessions } from "@/lib/chat/session";
import { botCall } from "@/lib/chat/store";

/**
 * Delivery recovery, separate from the hourly stream sync (H-21): reconciles message attempts left
 * pending or ambiguous (a crash after eve answered, a cut response) against the stored evidence of
 * the session each one was sent to, and ends main sessions that lost their install (H-02). Each
 * item is claimed with a compare-and-set, so overlapping runs are safe.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const [messages, sessions] = await Promise.all([
    reconcileMessages(),
    endOrphanSessions(botCall),
  ]);
  const report = { messages, sessions };
  console.info("cron.message-recovery", report);
  return Response.json(report);
}

export const maxDuration = 300;
