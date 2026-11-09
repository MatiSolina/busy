import { refreshExpiringSubscriptions } from "@/lib/ai/subscription-store";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  return Response.json(await refreshExpiringSubscriptions());
}
