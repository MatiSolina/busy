"use client";

import { History, Loader2, Search } from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  type MouseEvent,
  useCallback,
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

interface HistoryResult {
  createdAt: string;
  id: string;
  role: "user" | "assistant";
  text: string;
}

interface HistoryContext extends HistoryResult {
  after: HistoryResult[];
  before: HistoryResult[];
}

interface SearchResponse {
  result?: HistoryContext;
  results: HistoryResult[];
}

export function HistorySheet({
  name,
  onOpenChange,
  open,
  slug,
}: {
  name: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  slug: string;
}) {
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-border border-b pr-12">
          <SheetTitle>Search history</SheetTitle>
          <SheetDescription>
            Search {name}&apos;s messages and memories.
          </SheetDescription>
        </SheetHeader>
        {open ? <HistorySearch key={slug} slug={slug} /> : null}
      </SheetContent>
    </Sheet>
  );
}

export function HistorySearch({ slug }: { slug: string }) {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [results, setResults] = useState<HistoryResult[]>([]);
  const [context, setContext] = useState<HistoryContext | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle"
  );

  const search = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const value = query.trim();
      if (!value) {
        return;
      }
      setStatus("loading");
      setContext(null);
      try {
        const response = await fetch(
          `/api/bots/${encodeURIComponent(slug)}/history?q=${encodeURIComponent(value)}&limit=20`,
          { cache: "no-store" }
        );
        if (!response.ok) {
          throw new Error("search failed");
        }
        const body = (await response.json()) as SearchResponse;
        setResults(body.results);
        setSubmittedQuery(value);
        setStatus("ready");
      } catch {
        setStatus("error");
      }
    },
    [query, slug]
  );

  const readAround = useCallback(
    async (id: string) => {
      setContext(null);
      try {
        const response = await fetch(
          `/api/bots/${encodeURIComponent(slug)}/history?q=${encodeURIComponent(submittedQuery)}&around=${encodeURIComponent(id)}&limit=20`,
          { cache: "no-store" }
        );
        if (!response.ok) {
          throw new Error("context failed");
        }
        const body = (await response.json()) as SearchResponse;
        setContext(body.result ?? null);
      } catch {
        setStatus("error");
      }
    },
    [slug, submittedQuery]
  );

  const handleQueryChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
    []
  );
  const handleResultClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const id = event.currentTarget.dataset.resultId;
      if (id) {
        readAround(id).catch(() => undefined);
      }
    },
    [readAround]
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <form className="flex gap-2" onSubmit={search}>
        <label className="sr-only" htmlFor={`history-query-${slug}`}>
          Search history
        </label>
        <Input
          id={`history-query-${slug}`}
          onChange={handleQueryChange}
          placeholder="Search decisions, clients, files…"
          value={query}
        />
        <Button
          aria-label="Search history"
          disabled={status === "loading"}
          size="icon"
          type="submit"
        >
          {status === "loading" ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Search />
          )}
        </Button>
      </form>
      {status === "error" ? (
        <p className="text-destructive py-6 text-sm" role="alert">
          Couldn&apos;t search this chat. Try again.
        </p>
      ) : null}
      {status === "ready" && results.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 py-16 text-center text-sm">
          <History className="size-6" />
          <p>No messages matched that search.</p>
        </div>
      ) : null}
      {results.length ? (
        <ul
          aria-label="History results"
          className="divide-border mt-4 divide-y"
        >
          {results.map((result) => (
            <li className="py-3" key={result.id}>
              <button
                className="hover:bg-muted/50 w-full rounded-lg p-2 text-left"
                data-result-id={result.id}
                onClick={handleResultClick}
                type="button"
              >
                <span className="text-muted-foreground mb-1 block text-xs">
                  {result.role === "user" ? "You" : "Bot"} ·{" "}
                  {new Date(result.createdAt).toLocaleString()}
                </span>
                <span className="line-clamp-3 text-sm leading-6 whitespace-pre-wrap">
                  {result.text}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {context ? <HistoryContextView context={context} /> : null}
    </div>
  );
}

function HistoryContextView({ context }: { context: HistoryContext }) {
  const rows = [...context.before, context, ...context.after];
  return (
    <section
      aria-label="Nearby history"
      className="border-border mt-5 rounded-xl border p-3"
    >
      <h3 className="mb-2 text-sm font-medium">Nearby messages</h3>
      <div className="grid gap-3">
        {rows.map((row) => (
          <p className="text-sm leading-6" key={`${row.role}:${row.id}`}>
            <span className="text-muted-foreground mr-2 text-xs">
              {row.role === "user" ? "You" : "Bot"}
            </span>
            {row.text}
          </p>
        ))}
      </div>
    </section>
  );
}
