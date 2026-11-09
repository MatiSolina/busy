import { SchedulesApiError, type SchedulesClient } from "@vercel/schedules";
import { describe, expect, it, vi } from "vitest";
import {
  isRoutineSchedule,
  routineCron,
  syncRoutineSchedule,
} from "./schedule";

const row = {
  botId: "11111111-1111-4111-8111-111111111111",
  daysOfWeek: [5, 1, 3],
  deletedAt: null,
  enabled: true,
  id: "33333333-3333-4333-8333-333333333333",
  time: "09:05",
  timeZone: "America/Argentina/Cordoba",
};
const ref = {
  name: `routine-${row.id}`,
  namespace: `bot-${row.botId}`,
};

function fakeClient(state: "active" | "inactive" | "missing") {
  const notFound = new SchedulesApiError(404, "nope", { code: "not_found" });
  const client = {
    create: vi.fn().mockResolvedValue({ state: "active" }),
    delete: vi.fn().mockRejectedValue(notFound),
    disable: vi.fn().mockResolvedValue({}),
    enable: vi.fn().mockResolvedValue({}),
    get: vi.fn(() =>
      state === "missing"
        ? Promise.reject(notFound)
        : Promise.resolve({ scheduleId: "sch_1", state })
    ),
    update: vi.fn(() =>
      state === "missing"
        ? Promise.reject(notFound)
        : Promise.resolve({ state })
    ),
  };
  return { client, sdk: client as unknown as SchedulesClient };
}

describe("routineCron", () => {
  it("turns local weekdays and HH:mm into a five-field expression", () => {
    expect(routineCron(row)).toBe("5 9 * * 1,3,5");
    expect(routineCron({ daysOfWeek: [0], time: "00:00" })).toBe("0 0 * * 0");
    expect(
      routineCron({ daysOfWeek: [6, 5, 4, 3, 2, 1, 0], time: "23:59" })
    ).toBe("59 23 * * *");
  });
});

describe("syncRoutineSchedule", () => {
  it("creates a missing schedule in the bot's namespace with the routine's time zone", async () => {
    const { client, sdk } = fakeClient("missing");
    await syncRoutineSchedule(row, sdk);
    const spec = {
      ...ref,
      expression: { cron: "5 9 * * 1,3,5", type: "cron" },
      payload: { routineId: row.id },
      target: { topic: "routine-runs" },
      timezone: "America/Argentina/Cordoba",
    };
    expect(client.update).toHaveBeenCalledWith(spec);
    expect(client.create).toHaveBeenCalledWith(spec);
    expect(client.enable).not.toHaveBeenCalled();
  });

  it("pauses and resumes through disable and enable", async () => {
    const paused = fakeClient("active");
    await syncRoutineSchedule({ ...row, enabled: false }, paused.sdk);
    expect(paused.client.disable).toHaveBeenCalledWith(ref);

    const resumed = fakeClient("inactive");
    await syncRoutineSchedule(row, resumed.sdk);
    expect(resumed.client.enable).toHaveBeenCalledWith(ref);
    expect(resumed.client.create).not.toHaveBeenCalled();
  });

  it("deletes the schedule of a deleted routine, tolerating one already gone", async () => {
    const { client, sdk } = fakeClient("active");
    await syncRoutineSchedule({ ...row, deletedAt: new Date() }, sdk);
    expect(client.delete).toHaveBeenCalledWith(ref);
    expect(client.update).not.toHaveBeenCalled();
  });
});

describe("isRoutineSchedule", () => {
  it("accepts only the routine's own schedule id", async () => {
    const { client, sdk } = fakeClient("active");
    expect(await isRoutineSchedule(row, "sch_1", sdk)).toBe(true);
    expect(client.get).toHaveBeenCalledWith(ref);
    expect(await isRoutineSchedule(row, "sch_forged", sdk)).toBe(false);
    expect(
      await isRoutineSchedule(row, "sch_1", fakeClient("missing").sdk)
    ).toBe(false);
  });
});
