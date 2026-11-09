"use client";

import { Pencil, Plus, Search, Trash2, X } from "lucide-react";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";

interface Entry {
  author?: string | null;
  createdAt?: string | null;
  id: string;
  messageId?: string | null;
  origin?: "bot" | "legacy" | "owner";
  sourceStatus?: string;
  text: string;
  turnId?: string | null;
  updatedAt?: string | null;
}

interface MemoryPayload {
  entries: Entry[];
  version: number | null;
}

type MemoryResponse = Entry[] | Partial<MemoryPayload>;

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
});

function payload(
  value: MemoryResponse,
  fallbackVersion: number | null
): MemoryPayload {
  if (Array.isArray(value)) {
    return { entries: value, version: fallbackVersion };
  }
  return {
    entries: Array.isArray(value.entries) ? value.entries : [],
    version:
      typeof value.version === "number" ? value.version : fallbackVersion,
  };
}

function dateLabel(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : DATE_FORMATTER.format(date);
}

function sourceLabel(entry: Entry): string {
  if (
    !(entry.origin && entry.sourceStatus) ||
    entry.origin === "legacy" ||
    entry.sourceStatus === "legacy"
  ) {
    return "Source unknown (earlier memory)";
  }
  const actor = entry.origin === "owner" ? "Added by you" : "Saved by the bot";
  const date = dateLabel(entry.createdAt);
  return `${actor}${date ? ` · ${date}` : ""}`;
}

/** What the bot remembers, with editable entries and honest provenance. */
export function MemorySheet({
  slug,
  name,
  open,
  onOpenChange,
  embedded = false,
}: {
  embedded?: boolean;
  slug: string;
  name: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [memory, setMemory] = useState<MemoryPayload | null | "error">(null);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(
      `/api/bots/${encodeURIComponent(slug)}/memory`
    ).catch(() => null);
    if (!response?.ok) {
      setMemory("error");
      return;
    }
    const body = (await response.json()) as MemoryResponse;
    setMemory((previous) =>
      payload(body, previous && previous !== "error" ? previous.version : null)
    );
  }, [slug]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const timer = window.setTimeout(() => {
      load().catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, open]);

  const visibleEntries = useMemo(() => {
    const entries = memory && memory !== "error" ? memory.entries : [];
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? entries.filter((entry) =>
          entry.text.toLocaleLowerCase().includes(needle)
        )
      : entries;
  }, [memory, query]);

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setEditingId(null);
    setDraft("");
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        closeForm();
      }
      onOpenChange(next);
    },
    [closeForm, onOpenChange]
  );

  const submit = useCallback(async () => {
    if (!memory || memory === "error" || !draft.trim() || saving) {
      return;
    }
    setSaving(true);
    try {
      const editing = editingId !== null;
      const response = await fetch(
        `/api/bots/${encodeURIComponent(slug)}/memory`,
        {
          body: JSON.stringify({
            ...(editing ? { entryId: editingId } : {}),
            expectedVersion: memory.version,
            text: draft,
          }),
          headers: { "Content-Type": "application/json" },
          method: editing ? "PATCH" : "POST",
        }
      ).catch(() => null);
      if (response?.ok) {
        setMemory(
          payload((await response.json()) as MemoryResponse, memory.version)
        );
        closeForm();
      } else if (response?.status === 409) {
        await load();
      }
    } finally {
      setSaving(false);
    }
  }, [closeForm, draft, editingId, load, memory, saving, slug]);

  const forget = useCallback(
    async (entryId: string) => {
      if (!memory || memory === "error") {
        return;
      }
      const before = memory;
      setMemory({
        ...before,
        entries: before.entries.filter((entry) => entry.id !== entryId),
      });
      const response = await fetch(
        `/api/bots/${encodeURIComponent(slug)}/memory`,
        {
          body: JSON.stringify({ entryId, expectedVersion: before.version }),
          headers: { "Content-Type": "application/json" },
          method: "DELETE",
        }
      ).catch(() => null);
      if (response?.ok) {
        setMemory(
          payload((await response.json()) as MemoryResponse, before.version)
        );
      } else if (response?.status === 409) {
        await load();
      } else {
        // A failed DELETE must put the entry back, as before.
        setMemory(before);
      }
    },
    [load, memory, slug]
  );

  const beginAdd = useCallback(() => {
    setEditingId(null);
    setDraft("");
    setFormOpen(true);
  }, []);

  const beginEdit = useCallback((entry: Entry) => {
    setEditingId(entry.id);
    setDraft(entry.text);
    setFormOpen(true);
  }, []);

  const handleQueryChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
    []
  );
  const handleDraftChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value),
    []
  );
  const handleSubmit = useCallback(() => {
    submit().catch(() => undefined);
  }, [submit]);

  function renderEntries() {
    if (memory === null) {
      return <p className="text-muted-foreground text-sm">Loading…</p>;
    }
    if (memory === "error") {
      return (
        <p className="text-muted-foreground text-sm">
          Couldn&apos;t load. Close it and open it again.
        </p>
      );
    }
    if (visibleEntries.length === 0) {
      return (
        <p className="text-muted-foreground text-sm">
          {query.trim()
            ? "No memories match your search."
            : "Nothing remembered yet. Ask it to note something down and it shows up here."}
        </p>
      );
    }
    return (
      <ul className="flex flex-col">
        {visibleEntries.map((entry) => (
          <MemoryEntry
            entry={entry}
            key={entry.id}
            onEdit={beginEdit}
            onForget={forget}
          />
        ))}
      </ul>
    );
  }

  const content = (
    <>
      {embedded ? null : (
        <SheetHeader className="border-border border-b">
          <SheetTitle>What {name} remembers</SheetTitle>
          <SheetDescription>
            Review what {name} remembers. Add a fact or correct something that
            changed.
          </SheetDescription>
        </SheetHeader>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden="true"
              className="text-muted-foreground absolute top-2 left-2 size-4"
            />
            <Input
              aria-label="Search memories"
              className="pl-8"
              onChange={handleQueryChange}
              placeholder="Search memories"
              value={query}
            />
          </div>
          <Button
            aria-label="Add memory"
            onClick={beginAdd}
            size="sm"
            type="button"
          >
            <Plus aria-hidden="true" />
            Add
          </Button>
        </div>
        {formOpen ? (
          <div className="border-border flex flex-col gap-2 rounded-lg border p-3">
            <Textarea
              aria-label={editingId ? "Edit memory" : "New memory"}
              autoFocus
              onChange={handleDraftChange}
              placeholder="A concise, lasting fact"
              value={draft}
            />
            <div className="flex justify-end gap-2">
              <Button
                onClick={closeForm}
                size="sm"
                type="button"
                variant="ghost"
              >
                <X aria-hidden="true" />
                Cancel
              </Button>
              <Button
                disabled={!draft.trim() || saving}
                onClick={handleSubmit}
                size="sm"
                type="button"
              >
                {editingId ? "Save changes" : "Save memory"}
              </Button>
            </div>
          </div>
        ) : null}
        {renderEntries()}
      </div>
    </>
  );
  if (embedded) {
    return content;
  }
  return (
    <Sheet onOpenChange={handleOpenChange} open={open}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        {content}
      </SheetContent>
    </Sheet>
  );
}

function MemoryEntry({
  entry,
  onEdit,
  onForget,
}: {
  entry: Entry;
  onEdit: (entry: Entry) => void;
  onForget: (id: string) => Promise<void>;
}) {
  const handleForget = useCallback(
    () => onForget(entry.id),
    [entry.id, onForget]
  );
  const handleEdit = useCallback(() => onEdit(entry), [entry, onEdit]);
  return (
    <li className="group animate-enter border-border flex items-start gap-3 border-b py-3 last:border-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-6">{entry.text}</p>
        <p className="text-muted-foreground mt-1 text-xs">
          {sourceLabel(entry)}
        </p>
        {entry.messageId || entry.turnId ? (
          <details className="text-muted-foreground mt-1 text-xs">
            <summary className="cursor-pointer">Conversation reference</summary>
            {entry.messageId ? (
              <p className="mt-1 break-all">Message: {entry.messageId}</p>
            ) : null}
            {entry.turnId ? (
              <p className="mt-1 break-all">Turn: {entry.turnId}</p>
            ) : null}
          </details>
        ) : null}
      </div>
      <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          aria-label={`Edit: ${entry.text}`}
          className="text-muted-foreground hover:bg-accent hover:text-foreground rounded-md p-1.5"
          onClick={handleEdit}
          type="button"
        >
          <Pencil aria-hidden="true" className="size-4" />
        </button>
        <button
          aria-label={`Forget: ${entry.text}`}
          className="text-muted-foreground hover:bg-accent hover:text-foreground rounded-md p-1.5"
          onClick={handleForget}
          type="button"
        >
          <Trash2 aria-hidden="true" className="size-4" />
        </button>
      </div>
    </li>
  );
}
