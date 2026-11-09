import { runLatencyProbe } from "@/lib/chat/latency-probe";

// Synthetic chat latency probe for the QA bots: one `latency.probe` log line per bot (docs/performance-production.md).
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  // Deployed off: nothing is sent unless explicitly enabled.
  if (process.env.LATENCY_PROBE_ENABLED !== "1") {
    return Response.json(
      { enabled: false },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
  return Response.json(
    { enabled: true, ...(await runLatencyProbe()) },
    { headers: { "Cache-Control": "no-store" } }
  );
}

// 60 s of polling per bot (in parallel) plus delivery and the last sync.
export const maxDuration = 120;
