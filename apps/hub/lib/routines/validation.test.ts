import { describe, expect, it } from "vitest";
import { routineInputSchema, routinePatchSchema } from "./validation";

const base = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Morning report",
  prompt: "Read the inbox and summarize it.",
  time: "09:30",
  timeZone: "America/Argentina/Cordoba",
};

describe("routine validation", () => {
  it("trims fields and defaults to every day", () => {
    const parsed = routineInputSchema.parse({
      ...base,
      daysOfWeek: undefined,
      name: "  Morning report ",
    });
    expect(parsed.name).toBe("Morning report");
    expect(parsed.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("rejects duplicate days, invalid timezones, and unknown input keys", () => {
    expect(() =>
      routineInputSchema.parse({ ...base, daysOfWeek: [1, 1] })
    ).toThrow();
    expect(() =>
      routineInputSchema.parse({ ...base, timeZone: "Mars/Olympus" })
    ).toThrow();
    expect(() =>
      routineInputSchema.parse({ ...base, daysOfWeek: [1], extra: true })
    ).toThrow();
  });

  it("accepts a nonempty strict patch and rejects an empty or unknown patch", () => {
    expect(routinePatchSchema.parse({ name: "  Updated " })).toEqual({
      name: "Updated",
    });
    expect(routinePatchSchema.parse({ enabled: false })).toEqual({
      enabled: false,
    });
    expect(() => routinePatchSchema.parse({})).toThrow();
    expect(() => routinePatchSchema.parse({ unknown: true })).toThrow();
  });
});
