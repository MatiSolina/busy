import { z } from "zod";
import { FiresideConflict } from "./state";
export const commandInput = z.discriminatedUnion("kind", [
  z.object({
    id: z.uuid(),
    kind: z.enum(["continue", "pause", "close"]),
    revision: z.number().int().positive(),
  }),
  z.object({
    id: z.uuid(),
    kind: z.literal("intervene"),
    revision: z.number().int().positive(),
    text: z.string().trim().min(1).max(20_000),
  }),
]);
export const computerInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stop") }),
  z.object({ kind: z.literal("open") }),
  z.object({
    action: z.enum(["acquire", "renew", "release"]),
    kind: z.literal("control"),
    viewerId: z.uuid(),
  }),
]);
export const fireJson = (value: unknown, status = 200) =>
  Response.json(value, {
    headers: { "Cache-Control": "private, no-store" },
    status,
  });
export const fireError = (error: unknown) =>
  fireJson(
    {
      error:
        error instanceof FiresideConflict
          ? error.message
          : "The fireside is temporarily unavailable. Please try again.",
    },
    error instanceof FiresideConflict ? 409 : 503
  );
