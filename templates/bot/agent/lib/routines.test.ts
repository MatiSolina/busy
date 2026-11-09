import { describe, expect, it, vi } from "vitest";
import {
  createRoutine,
  deleteRoutine,
  listRoutines,
  type RoutineCreate,
  stableRoutineId,
  updateRoutine,
} from "./routines";

const ROUTINE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const routine: RoutineCreate = {
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  id: "8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a",
  name: "Morning brief",
  prompt: "Review the latest updates and send me a concise brief.",
  time: "09:00",
  timeZone: "America/Argentina/Cordoba",
};

describe("stableRoutineId", () => {
  it("is deterministic and UUID-shaped", () => {
    const a = stableRoutineId("session-1", "call-1");
    expect(a).toBe("eb8ccf65-1372-5da8-a856-4a602768dbbd");
    expect(a).toBe(stableRoutineId("session-1", "call-1"));
    expect(a).toMatch(ROUTINE_ID_RE);
    expect(a).not.toBe(stableRoutineId("session-1", "call-2"));
  });
});

describe("routine hub client", () => {
  it("lists with an injectable fetcher", async () => {
    const fetcher = vi
      .fn<(path: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(Response.json({ routines: [] }));
    const { signal } = new AbortController();
    await expect(listRoutines(fetcher, signal)).resolves.toEqual({
      routines: [],
    });
    expect(fetcher).toHaveBeenCalledWith("/api/bot/routines", { signal });
  });

  it("sends the create body and HTTP method", async () => {
    const fetcher = vi
      .fn<(path: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(Response.json({ routine }));
    await createRoutine(routine, fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/bot/routines", {
      body: JSON.stringify(routine),
      method: "POST",
    });
  });

  it("patches and deletes only the requested id", async () => {
    const fetcher = vi
      .fn<(path: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(Response.json({ routine }));
    await updateRoutine(routine.id, { enabled: false, time: "18:30" }, fetcher);
    await deleteRoutine(routine.id, fetcher);
    expect(
      fetcher.mock.calls.map(([path, init]) => [path, init?.method, init?.body])
    ).toEqual([
      [
        `/api/bot/routines/${routine.id}`,
        "PATCH",
        JSON.stringify({ enabled: false, time: "18:30" }),
      ],
      [`/api/bot/routines/${routine.id}`, "DELETE", undefined],
    ]);
  });

  it("keeps hub failures short and does not expose response bodies", async () => {
    const fetcher = vi
      .fn<(path: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response("database password", { status: 503 }));
    await expect(listRoutines(fetcher)).resolves.toEqual({
      error: "Couldn't list routines (503)",
    });
  });

  it("turns network failures into a safe message", async () => {
    const fetcher = vi
      .fn<(path: string, init?: RequestInit) => Promise<Response>>()
      .mockRejectedValue(new Error("private host details"));
    await expect(listRoutines(fetcher)).resolves.toEqual({
      error: "Couldn't reach the routines service.",
    });
  });
});
