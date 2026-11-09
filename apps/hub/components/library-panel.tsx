"use client";

import {
  Download,
  File,
  FileSpreadsheet,
  FileText,
  ImageIcon,
  Library,
  Loader2,
  Music2,
  Presentation,
  Video,
} from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type {
  LibraryFile,
  LibraryFileSource,
  LibraryResponse,
} from "@/lib/library-types";

let dateFormat: Intl.DateTimeFormat | undefined;

function formatDate(value: string) {
  dateFormat ??= new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return dateFormat.format(new Date(value));
}
const SPREADSHEET_TYPES = /spreadsheet|excel|csv/u;
const PRESENTATION_TYPES = /presentation|powerpoint/u;
const DOCUMENT_TYPES = /pdf|text|document|word/u;

function fileSize(bytes: number) {
  return bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toLocaleString("en", { maximumFractionDigits: 1 })} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function FileIcon({ contentType }: { contentType: string }) {
  let Icon = File;
  if (contentType.startsWith("image/")) {
    Icon = ImageIcon;
  } else if (contentType.startsWith("video/")) {
    Icon = Video;
  } else if (contentType.startsWith("audio/")) {
    Icon = Music2;
  } else if (SPREADSHEET_TYPES.test(contentType)) {
    Icon = FileSpreadsheet;
  } else if (PRESENTATION_TYPES.test(contentType)) {
    Icon = Presentation;
  } else if (DOCUMENT_TYPES.test(contentType)) {
    Icon = FileText;
  }
  return (
    <Icon
      aria-hidden="true"
      className="text-muted-foreground size-5 shrink-0"
    />
  );
}

export function LibrarySheet({
  slug,
  name,
  open,
  onOpenChange,
}: {
  slug: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-border border-b pr-12">
          <SheetTitle>Library</SheetTitle>
          <SheetDescription>Files shared by {name}</SheetDescription>
        </SheetHeader>
        {open ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <LibraryResults key={slug} slug={slug} />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

export function LibraryResults({ slug }: { slug: string }) {
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [source, setSource] = useState<LibraryFileSource | "all">("all");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading"
  );

  // `attempt` intentionally retriggers this effect after the user presses Retry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry state is a request trigger, not a request input
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ bot: slug, source });
    if (cursor) {
      params.set("cursor", cursor);
    }
    fetch(`/api/library?${params}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error("Could not load files");
        }
        const page = (await res.json()) as LibraryResponse;
        if (controller.signal.aborted) {
          return;
        }
        setFiles((previous) =>
          cursor
            ? [
                ...previous,
                ...page.files.filter(
                  (file) => !previous.some((item) => item.id === file.id)
                ),
              ]
            : page.files
        );
        setNextCursor(page.nextCursor);
        setStatus("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setStatus("error");
        }
      });
    return () => controller.abort();
  }, [slug, cursor, source, attempt]);

  const retry = useCallback(() => {
    setStatus("loading");
    setAttempt((n) => n + 1);
  }, []);

  const loadMore = useCallback(() => {
    if (!nextCursor) {
      return;
    }
    setStatus("loading");
    setCursor(nextCursor);
  }, [nextCursor]);

  const changeSource = useCallback((next: LibraryFileSource | "all") => {
    setFiles([]);
    setCursor(null);
    setNextCursor(null);
    setStatus("loading");
    setSource(next);
  }, []);

  const handleSourceChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      changeSource(event.target.value as LibraryFileSource | "all");
    },
    [changeSource]
  );

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <label
          className="text-muted-foreground text-sm"
          htmlFor={`library-source-${slug}`}
        >
          Show
        </label>
        <select
          aria-label="Filter library files"
          className="border-input bg-background rounded-md border px-2 py-1.5 text-sm"
          id={`library-source-${slug}`}
          onChange={handleSourceChange}
          value={source}
        >
          <option value="all">All files</option>
          <option value="bot">Generated by bot</option>
          <option value="user">Sent by me</option>
        </select>
      </div>
      {files.length ? (
        <ul
          aria-label="Library files"
          className="divide-border border-border divide-y border-b"
        >
          {files.map((file) => {
            const downloadUrl = `/api/files/${file.id}?download`;
            return (
              <li
                className="group flex min-w-0 items-center gap-3 py-4 sm:gap-4"
                key={file.id}
              >
                <FileIcon contentType={file.contentType} />
                <div className="min-w-0 flex-1">
                  <a
                    className="block max-w-full truncate rounded-sm text-left text-sm font-medium hover:underline"
                    download={file.name}
                    href={downloadUrl}
                    title={file.name}
                  >
                    {file.name}
                  </a>
                  <div className="text-muted-foreground mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span className="tabular-nums">{fileSize(file.size)}</span>
                    {file.source === "user" ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>Sent by you</span>
                      </>
                    ) : null}
                    {file.version > 1 ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>Version {file.version}</span>
                      </>
                    ) : null}
                    <time
                      className="basis-full sm:hidden"
                      dateTime={file.createdAt}
                      title={new Date(file.createdAt).toLocaleString()}
                    >
                      {formatDate(file.createdAt)}
                    </time>
                  </div>
                </div>
                <time
                  className="text-muted-foreground hidden shrink-0 text-xs sm:block"
                  dateTime={file.createdAt}
                  title={new Date(file.createdAt).toLocaleString()}
                >
                  {formatDate(file.createdAt)}
                </time>
                <a
                  aria-label={`Download ${file.name}`}
                  className="text-muted-foreground hover:bg-accent hover:text-foreground grid size-9 shrink-0 place-items-center rounded-md transition-colors"
                  download={file.name}
                  href={downloadUrl}
                >
                  <Download aria-hidden="true" className="size-4" />
                </a>
              </li>
            );
          })}
        </ul>
      ) : null}
      {files.length === 0 && status === "ready" ? (
        <div className="flex min-h-72 flex-col items-center justify-center px-4 text-center">
          <Library
            aria-hidden="true"
            className="text-muted-foreground mb-4 size-7"
          />
          <h3 className="text-base font-medium">Your library starts here</h3>
          <p className="text-muted-foreground mt-2 max-w-sm text-sm leading-6">
            Ask this bot to create a file. When it shares the result with you,
            it will appear here.
          </p>
        </div>
      ) : null}
      {status === "loading" ? (
        <p
          className="text-muted-foreground flex items-center justify-center gap-2 py-12 text-sm"
          role="status"
        >
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          Loading files…
        </p>
      ) : null}
      {status === "error" ? (
        <div
          className="flex flex-wrap items-center justify-center gap-3 py-10 text-sm"
          role="alert"
        >
          <p className="text-muted-foreground">
            Couldn’t load your files. Try again.
          </p>
          <Button onClick={retry} variant="outline">
            Try again
          </Button>
        </div>
      ) : null}
      {nextCursor && status === "ready" ? (
        <div className="flex justify-center pt-6">
          <Button onClick={loadMore} variant="outline">
            Load more files
          </Button>
        </div>
      ) : null}
    </>
  );
}
