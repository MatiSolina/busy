import { handleCallback } from "@vercel/queue";
import type { ScheduleQueueMessage } from "@vercel/schedules";
import { z } from "zod";
import { runRoutineOccurrence } from "@/lib/routines/dispatch";

const message = z.object({
  executionId: z.string().min(1),
  payload: z.object({ routineId: z.uuid() }),
  scheduledAt: z.iso.datetime({ offset: true }),
  scheduleId: z.string().min(1),
});

/**
 * Consumer of the `routine-runs` topic that every routine's Vercel schedule publishes to
 * (lib/routines/schedule.ts). Subscribed in vercel.json. Throwing redelivers the message.
 */
const handler = handleCallback<ScheduleQueueMessage<unknown>>(
  async (raw, { deliveryCount }) => {
    const parsed = message.safeParse(raw);
    if (!parsed.success) {
      console.error("routine-runs: dropping a malformed schedule message");
      return; // acknowledged: retrying cannot fix it
    }
    const { executionId, payload, scheduledAt, scheduleId } = parsed.data;
    await runRoutineOccurrence(
      {
        executionId,
        routineId: payload.routineId,
        scheduledAt: new Date(scheduledAt),
        scheduleId,
      },
      deliveryCount
    );
  },
  { retry: () => ({ afterSeconds: 60 }) }
);

// Next's route types want `(request: Request)`; handleCallback also accepts `{ request }`.
export const POST = (request: Request) => handler(request);

export const maxDuration = 300;
