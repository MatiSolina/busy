import {
  Schedules,
  SchedulesApiError,
  type SchedulesClient,
} from "@vercel/schedules";
import type { RoutineRow } from "@/lib/db";

/** Every routine schedule publishes here; `app/api/queues/routine-runs` consumes it. */
export const ROUTINE_TOPIC = "routine-runs";

export interface RoutinePayload {
  routineId: string;
}

type ScheduledRoutine = Pick<
  RoutineRow,
  "botId" | "daysOfWeek" | "deletedAt" | "enabled" | "id" | "time" | "timeZone"
>;

/** One namespace per bot, so deleting a bot can sweep its schedules without the database. */
const ref = (row: Pick<RoutineRow, "botId" | "id">) => ({
  name: `routine-${row.id}`,
  namespace: `bot-${row.botId}`,
});

/** Local weekdays (0 = Sunday) at `HH:mm`; Vercel evaluates it in the routine's IANA time zone. */
export function routineCron({
  daysOfWeek,
  time,
}: Pick<RoutineRow, "daysOfWeek" | "time">): string {
  const [hour, minute] = time.split(":").map(Number);
  const days = [...new Set(daysOfWeek)].sort((a, b) => a - b);
  return `${minute} ${hour} * * ${days.length === 7 ? "*" : days.join(",")}`;
}

/**
 * Deployed code talks to the Schedules API of its own environment (OIDC); `vercel dev` points the
 * SDK at its local scheduler. A plain `next dev` has neither, so routines there never fire.
 */
const schedulesAvailable = () =>
  Boolean(process.env.VERCEL || process.env.VERCEL_SCHEDULE_BASE_URL);

const notFound = (error: unknown) =>
  error instanceof SchedulesApiError && error.code === "not_found";

/**
 * Make the routine's Vercel schedule match its row: idempotent, so any caller can retry it.
 * `client` defaults to the deployment's own environment; the backfill script passes its own.
 */
export async function syncRoutineSchedule(
  row: ScheduledRoutine,
  client: SchedulesClient = Schedules
): Promise<void> {
  if (client === Schedules && !schedulesAvailable()) {
    return;
  }
  const id = ref(row);
  if (row.deletedAt) {
    await client.delete(id).catch((error: unknown) => {
      if (!notFound(error)) {
        throw error;
      }
    });
    return;
  }
  const spec = {
    ...id,
    expression: { cron: routineCron(row), type: "cron" as const },
    payload: { routineId: row.id } satisfies RoutinePayload,
    target: { topic: ROUTINE_TOPIC },
    timezone: row.timeZone,
  };
  const schedule = await client.update(spec).catch((error: unknown) => {
    if (notFound(error)) {
      return client.create(spec);
    }
    throw error;
  });
  if (row.enabled && schedule.state !== "active") {
    await client.enable(id);
  } else if (!row.enabled && schedule.state === "active") {
    await client.disable(id);
  }
}

/**
 * Whether `scheduleId` is this routine's own schedule. The queue consumer is reachable over HTTP;
 * the schedule id never leaves Vercel and the hub, so a forged message cannot know it.
 */
export async function isRoutineSchedule(
  row: Pick<RoutineRow, "botId" | "id">,
  scheduleId: string,
  client: SchedulesClient = Schedules
): Promise<boolean> {
  if (client === Schedules && !schedulesAvailable()) {
    return true; // plain `next dev` and tests: there is no schedule to compare with
  }
  try {
    return (await client.get(ref(row))).scheduleId === scheduleId;
  } catch (error) {
    if (notFound(error)) {
      return false;
    }
    throw error;
  }
}

/** Remove every routine schedule of a bot (its rows go with the bot through the FK cascade). */
export async function deleteBotSchedules(botId: string): Promise<void> {
  if (!schedulesAvailable()) {
    return;
  }
  const namespace = `bot-${botId}`;
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    // biome-ignore lint/performance/noAwaitInLoops: Pages are cursor-chained.
    const page = await Schedules.list({ cursor, limit: 100, namespace });
    names.push(...page.data.map((schedule) => schedule.name));
    cursor = page.cursor ?? undefined;
  } while (cursor);
  await Promise.all(
    names.map((name) =>
      Schedules.delete({ name, namespace }).catch((error: unknown) => {
        if (!notFound(error)) {
          throw error;
        }
      })
    )
  );
}
