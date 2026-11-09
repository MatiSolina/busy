"use client";

import { CalendarClock, LoaderCircle } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { RoutineRow } from "@/components/routine-row";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { PublicRoutine } from "@/lib/routines/types";
import type { RoutinePatch } from "@/lib/routines/validation";

const RoutineEditor = dynamic(
  () => import("@/components/routine-editor").then((m) => m.RoutineEditor),
  {
    loading: () => (
      <>
        <DialogTitle>Edit routine</DialogTitle>
        <DialogDescription>Loading routine…</DialogDescription>
      </>
    ),
  }
);

function apiPath(slug: string, id?: string) {
  const base = `/api/bots/${encodeURIComponent(slug)}/routines`;
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

interface RoutinesPanelProps {
  name: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  slug: string;
}

interface RoutineDialog {
  kind: "edit" | "delete";
  routine: PublicRoutine;
}

async function mutateRoutine(slug: string, id: string, patch?: RoutinePatch) {
  const response = await fetch(
    apiPath(slug, id),
    patch
      ? {
          body: JSON.stringify(patch),
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        }
      : { method: "DELETE" }
  );
  if (!response.ok) {
    throw new Error("mutation");
  }
  if (!patch) {
    return null;
  }
  const body = (await response.json()) as { routine?: PublicRoutine };
  if (!body.routine) {
    throw new Error("response");
  }
  return body.routine;
}

/** Keep the dialog root mounted so Base UI can finish its closing transition. */
export function RoutinesPanel(props: RoutinesPanelProps) {
  const [loadAttempt, setLoadAttempt] = useState(0);
  const handleRetry = useCallback(() => {
    setLoadAttempt((attempt) => attempt + 1);
  }, []);
  const resetSession = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      setLoadAttempt((attempt) => attempt + 1);
    }
  }, []);
  return (
    <Sheet
      onOpenChange={props.onOpenChange}
      onOpenChangeComplete={resetSession}
      open={props.open}
    >
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <RoutinesPanelSession
          key={`${props.slug}:${loadAttempt}`}
          {...props}
          onRetry={handleRetry}
        />
      </SheetContent>
    </Sheet>
  );
}

export function RoutinesContent({
  slug,
  name,
  open,
}: Pick<RoutinesPanelProps, "slug" | "name" | "open">) {
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return (
    <RoutinesPanelSession
      embedded
      key={`${slug}:${attempt}`}
      name={name}
      onRetry={retry}
      open={open}
      slug={slug}
    />
  );
}

function RoutinesPanelSession({
  slug,
  name,
  open,
  onRetry,
  embedded = false,
}: Pick<RoutinesPanelProps, "slug" | "name" | "open"> & {
  embedded?: boolean;
  onRetry: () => void;
}) {
  const [routines, setRoutines] = useState<PublicRoutine[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<RoutineDialog | null>(null);
  const mutationPending = useRef<boolean>(false);
  // Ignore requests from a previous bot or an already closed panel.
  const requestGeneration = useRef(0);

  useEffect(() => {
    requestGeneration.current += 1;
    const generation = requestGeneration.current;
    if (!open) {
      return;
    }
    const controller = new AbortController();
    fetch(apiPath(slug), { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("load");
        }
        const body = (await response.json()) as { routines?: PublicRoutine[] };
        if (
          !controller.signal.aborted &&
          requestGeneration.current === generation
        ) {
          setRoutines(Array.isArray(body.routines) ? body.routines : []);
        }
      })
      .catch(() => {
        if (
          !controller.signal.aborted &&
          requestGeneration.current === generation
        ) {
          setLoadError(true);
        }
      });
    return () => {
      controller.abort();
      requestGeneration.current += 1;
    };
  }, [open, slug]);

  const mutate = useCallback(
    async (routine: PublicRoutine, patch?: RoutinePatch) => {
      if (mutationPending.current) {
        return;
      }
      mutationPending.current = true;
      const generation = requestGeneration.current;
      setBusy(routine.id);
      setActionError(null);
      try {
        const updated = await mutateRoutine(slug, routine.id, patch);
        if (requestGeneration.current !== generation) {
          return;
        }
        setRoutines(
          (previous) =>
            previous?.flatMap((item) => {
              if (item.id !== routine.id) {
                return [item];
              }
              return updated ? [updated] : [];
            }) ?? previous
        );
        setDialog(null);
      } catch {
        if (requestGeneration.current === generation) {
          setActionError(
            patch
              ? "Couldn’t update this routine. Try again."
              : "Couldn’t delete this routine. Try again."
          );
        }
      } finally {
        mutationPending.current = false;
        if (requestGeneration.current === generation) {
          setBusy(null);
        }
      }
    },
    [slug]
  );
  const toggle = useCallback(
    async (routine: PublicRoutine) => {
      await mutate(routine, { enabled: !routine.enabled });
    },
    [mutate]
  );
  const edit = useCallback((routine: PublicRoutine) => {
    setActionError(null);
    setDialog({ kind: "edit", routine });
  }, []);
  const confirmDelete = useCallback((routine: PublicRoutine) => {
    setActionError(null);
    setDialog({ kind: "delete", routine });
  }, []);
  const closeDialog = useCallback(() => {
    if (!mutationPending.current) {
      setDialog(null);
      setActionError(null);
    }
  }, []);
  const handleDialogOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        closeDialog();
      }
    },
    [closeDialog]
  );
  const remove = useCallback(async () => {
    if (dialog?.kind === "delete") {
      await mutate(dialog.routine);
    }
  }, [dialog, mutate]);

  function renderRoutineList() {
    if (loadError) {
      return (
        <div
          className="text-muted-foreground flex flex-wrap items-center gap-3 text-sm"
          role="alert"
        >
          <p>Couldn’t load routines. Try again.</p>
          <Button onClick={onRetry} size="sm" variant="outline">
            Retry
          </Button>
        </div>
      );
    }
    if (routines === null) {
      return (
        <p
          className="text-muted-foreground flex items-center gap-2 py-8 text-sm"
          role="status"
        >
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          Loading routines…
        </p>
      );
    }
    if (routines.length === 0) {
      return (
        <div className="flex min-h-64 flex-col items-center justify-center px-4 text-center">
          <CalendarClock
            aria-hidden="true"
            className="text-muted-foreground mb-4 size-7"
          />
          <h3 className="text-base font-medium">No routines yet</h3>
          <p className="text-muted-foreground mt-2 max-w-sm text-sm leading-6">
            Ask {name} in chat to create a routine.
          </p>
          <p className="text-muted-foreground mt-3 max-w-sm text-sm leading-6">
            “Every day at 9 AM, review my inbox and send a summary.”
          </p>
        </div>
      );
    }
    return (
      <ul
        aria-label="Scheduled routines"
        className="border-border bg-accent/30 overflow-hidden rounded-2xl border"
      >
        {routines.map((routine) => (
          <RoutineRow
            busy={busy === routine.id}
            disabled={Boolean(busy)}
            key={routine.id}
            onDelete={confirmDelete}
            onEdit={edit}
            onToggle={toggle}
            routine={routine}
          />
        ))}
      </ul>
    );
  }

  return (
    <>
      {embedded ? null : (
        <SheetHeader className="pr-12">
          <SheetTitle>Routines</SheetTitle>
          <SheetDescription className="sr-only">
            Manage routines for {name}. Ask in chat to create a routine.
          </SheetDescription>
        </SheetHeader>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {actionError && !dialog ? (
          <p className="text-destructive mb-3 text-sm" role="alert">
            {actionError}
          </p>
        ) : null}
        {renderRoutineList()}
      </div>
      <Dialog onOpenChange={handleDialogOpenChange} open={dialog !== null}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 sm:max-w-lg">
          {dialog?.kind === "edit" ? (
            <RoutineEditor
              busy={Boolean(busy)}
              error={actionError}
              key={dialog.routine.id}
              onCancel={closeDialog}
              onSave={mutate}
              routine={dialog.routine}
            />
          ) : null}
          {dialog?.kind === "delete" ? (
            <>
              <DialogTitle>Delete routine?</DialogTitle>
              <DialogDescription>
                “{dialog.routine.name}” will stop running and be removed.
              </DialogDescription>
              {actionError ? (
                <p className="text-destructive text-sm" role="alert">
                  {actionError}
                </p>
              ) : null}
              <div className="mt-2 flex justify-end gap-2">
                <Button
                  disabled={Boolean(busy)}
                  onClick={closeDialog}
                  variant="ghost"
                >
                  Cancel
                </Button>
                <Button
                  disabled={Boolean(busy)}
                  onClick={remove}
                  variant="destructive"
                >
                  {busy ? (
                    <LoaderCircle aria-hidden="true" className="animate-spin" />
                  ) : null}
                  Delete routine
                </Button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
