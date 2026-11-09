"use client";

import { LoaderCircle } from "lucide-react";
import { type FormEvent, useCallback, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ROUTINE_DAYS } from "@/lib/routines/display";
import type { PublicRoutine } from "@/lib/routines/types";
import {
  type RoutinePatch,
  routinePatchSchema,
} from "@/lib/routines/validation";

function changedFields(
  routine: PublicRoutine,
  values: RoutinePatch
): RoutinePatch {
  return Object.fromEntries(
    Object.entries(values).filter(([key, value]) => {
      if (key === "daysOfWeek" && Array.isArray(value)) {
        return (
          value.length !== routine.daysOfWeek.length ||
          value.some((day: number) => !routine.daysOfWeek.includes(day))
        );
      }
      return value !== routine[key as keyof RoutinePatch];
    })
  );
}

export function RoutineEditor({
  routine,
  busy,
  error,
  onSave,
  onCancel,
}: {
  routine: PublicRoutine;
  busy: boolean;
  error: string | null;
  onSave: (routine: PublicRoutine, patch: RoutinePatch) => Promise<void>;
  onCancel: () => void;
}) {
  const id = useId();
  const [validationError, setValidationError] = useState<string | null>(null);
  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const result = routinePatchSchema.safeParse({
        daysOfWeek: form.getAll("daysOfWeek").map(Number),
        name: form.get("name"),
        prompt: form.get("prompt"),
        time: form.get("time"),
        timeZone: form.get("timeZone"),
      });
      if (!result.success) {
        setValidationError(
          result.error.issues[0]?.message ?? "Check the fields."
        );
        return;
      }
      setValidationError(null);
      const patch = changedFields(routine, result.data);
      if (Object.keys(patch).length === 0) {
        onCancel();
        return;
      }
      await onSave(routine, patch);
    },
    [onCancel, onSave, routine]
  );

  return (
    <form className="flex min-h-0 flex-col gap-5" onSubmit={submit}>
      <div className="pr-8">
        <DialogTitle>Edit routine</DialogTitle>
        <DialogDescription className="sr-only">
          Change the task and its schedule.
        </DialogDescription>
      </div>
      <fieldset className="flex min-w-0 flex-col gap-4" disabled={busy}>
        <div className="grid gap-1.5">
          <label htmlFor={`${id}-name`}>Title</label>
          <Input
            defaultValue={routine.name}
            id={`${id}-name`}
            maxLength={100}
            name="name"
            required
          />
        </div>
        <div className="grid gap-1.5">
          <label htmlFor={`${id}-prompt`}>Instructions</label>
          <Textarea
            className="max-h-56 min-h-28 resize-y"
            defaultValue={routine.prompt}
            id={`${id}-prompt`}
            maxLength={20_000}
            name="prompt"
            required
          />
        </div>
        <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
          <div className="grid gap-1.5">
            <label htmlFor={`${id}-time`}>Time</label>
            <Input
              defaultValue={routine.time}
              id={`${id}-time`}
              name="time"
              required
              type="time"
            />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor={`${id}-zone`}>Time zone</label>
            <Input
              defaultValue={routine.timeZone}
              id={`${id}-zone`}
              name="timeZone"
              required
            />
          </div>
        </div>
        <fieldset>
          <legend className="mb-2">Repeat</legend>
          <div className="flex flex-wrap gap-2">
            {ROUTINE_DAYS.map((day) => (
              <label className="cursor-pointer" key={day.value}>
                <input
                  className="peer sr-only"
                  defaultChecked={routine.daysOfWeek.includes(day.value)}
                  name="daysOfWeek"
                  type="checkbox"
                  value={day.value}
                />
                <span className="border-border peer-checked:bg-foreground peer-checked:text-background inline-flex h-9 min-w-10 items-center justify-center rounded-lg border px-2 text-xs peer-disabled:opacity-50">
                  {day.label}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </fieldset>
      {validationError || error ? (
        <p className="text-destructive text-sm" role="alert">
          {validationError || error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          disabled={busy}
          onClick={onCancel}
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button disabled={busy} type="submit">
          {busy ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" />
          ) : null}
          Save changes
        </Button>
      </div>
    </form>
  );
}
