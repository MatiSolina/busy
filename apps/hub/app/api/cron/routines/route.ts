import { recoverRoutineRuns } from "@/lib/routines/monitor";
import { reconcileRoutineSchedules } from "@/lib/routines/outbox";

// Durable follow-up for routines (docs/routines.md): observe runs the run workflow left behind, and
// apply schedule jobs that did not reach Vercel right after their commit.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const [runs, schedules] = await Promise.allSettled([
    recoverRoutineRuns(),
    reconcileRoutineSchedules(),
  ]);
  const settled = <T>(result: PromiseSettledResult<T>) =>
    result.status === "fulfilled" ? result.value : { error: true };
  return Response.json(
    { runs: settled(runs), schedules: settled(schedules) },
    {
      headers: { "cache-control": "no-store" },
      status:
        runs.status === "rejected" || schedules.status === "rejected"
          ? 500
          : 200,
    }
  );
}

export const maxDuration = 60;
