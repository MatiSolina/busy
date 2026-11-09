import { z } from "zod";

/** Return whether the runtime recognizes `timeZone` as an IANA/Intl timezone. */
export function validTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.trim() === "") {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
    return true;
  } catch {
    return false;
  }
}

const time = z
  .string()
  .trim()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, "Use a 24-hour time in HH:mm format.");
const timeZone = z
  .string()
  .trim()
  .refine(validTimeZone, "Use a valid IANA time zone.");
const daysOfWeek = z
  .array(z.number().int().min(0).max(6))
  .min(1, "Choose at least one day.")
  .max(7, "Choose no more than seven days.")
  .refine(
    (days) => new Set(days).size === days.length,
    "Each weekday can appear only once."
  );

const routineShape = {
  daysOfWeek,
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(20_000),
  time,
  timeZone,
};

export const routineInputSchema = z
  .object({
    ...routineShape,
    daysOfWeek: daysOfWeek.default([0, 1, 2, 3, 4, 5, 6]),
  })
  .strict();

export const routinePatchSchema = z
  .object({
    daysOfWeek: routineShape.daysOfWeek.optional(),
    enabled: z.boolean().optional(),
    name: routineShape.name.optional(),
    prompt: routineShape.prompt.optional(),
    time: routineShape.time.optional(),
    timeZone: routineShape.timeZone.optional(),
  })
  .strict()
  .refine(
    (patch) => Object.keys(patch).length > 0,
    "At least one routine field is required."
  );

export type RoutineInput = z.infer<typeof routineInputSchema>;
export type RoutinePatch = z.infer<typeof routinePatchSchema>;
