"use client";

import { ArrowLeftRight } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { MessageList } from "@/components/messages";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Billing } from "@/lib/bots/models";
import { type ClientRow, toChatView } from "@/lib/chat/items";

type Person = {
  slug: string;
  name: string;
  avatar: string | null;
  billing?: Billing;
} | null;
interface Thread {
  from: Person;
  id: string;
  question: string | null;
  rows: ClientRow[];
  to: Person;
}

const EMPTY_DELTAS: ReadonlyMap<string, string> = new Map();
const EMPTY_CONSULTS: ReadonlyMap<string, { id: string; peerName: string }> =
  new Map();

const personName = (person: Person, fallback = "") =>
  person ? person.name : fallback;
const personSlug = (person: Person) => (person ? person.slug : "");

/** The private "A ⇄ B" consultation, read-only, as in Grok Bot (spec 2). */
export function ThreadSheet({
  consultationId,
  onClose,
}: {
  consultationId: string | null;
  onClose: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );

  return (
    <Sheet onOpenChange={handleOpenChange} open={consultationId !== null}>
      <SheetContent className="w-full gap-0 sm:max-w-xl">
        <ThreadContent
          consultationId={consultationId}
          key={`${consultationId ?? "closed"}:${attempt}`}
          onRetry={retry}
        />
      </SheetContent>
    </Sheet>
  );
}

function ThreadContent({
  consultationId,
  onRetry,
}: {
  consultationId: string | null;
  onRetry: () => void;
}) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [failed, setFailed] = useState(false);
  const [deltas, setDeltas] =
    useState<ReadonlyMap<string, string>>(EMPTY_DELTAS);

  useEffect(() => {
    if (!consultationId) {
      return;
    }
    const id = consultationId;
    let live = true;
    let es: EventSource | null = null;
    const onFact = (event: Event) => {
      if (!live) {
        return;
      }
      const row = JSON.parse((event as MessageEvent).data) as ClientRow;
      setThread((cur) =>
        !cur ||
        cur.rows.some((r) => r.line === row.line && r.index === row.index)
          ? cur
          : { ...cur, rows: [...cur.rows, row] }
      );
      if (row.type === "turn.settled") {
        setDeltas(EMPTY_DELTAS);
      }
    };
    const kinds = new Map<string, string>();
    const onProgress = (event: Event) => {
      if (!live) {
        return;
      }
      const p = JSON.parse((event as MessageEvent).data) as {
        type: string;
        data: { partId?: string; delta?: string; kind?: string };
      };
      const { partId, delta, kind } = p.data;
      if (p.type !== "content.delta" || !partId || !delta) {
        return;
      }
      if (kind && !kinds.has(partId)) {
        kinds.set(partId, kind);
      }
      if (kinds.get(partId) !== "text") {
        return; // reasoning is never shown
      }
      setDeltas((d) => new Map(d).set(partId, (d.get(partId) ?? "") + delta));
    };
    const onEnd = () => es?.close();

    fetch(`/api/consultations/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((t: Thread) => {
        if (!live) {
          return;
        }
        setThread(t);
        // Then follow it live: what it does now shows as it happens. EventSource reconnects on its own; rows dedup.
        const after = t.rows.reduce((m, r) => Math.max(m, r.line), -1);
        es = new EventSource(`/api/consultations/${id}/events?after=${after}`);
        es.addEventListener("fact", onFact);
        es.addEventListener("progress", onProgress);
        es.addEventListener("end", onEnd);
      })
      .catch(() => {
        if (live) {
          setFailed(true);
        }
      });
    return () => {
      live = false;
      es?.removeEventListener("fact", onFact);
      es?.removeEventListener("progress", onProgress);
      es?.removeEventListener("end", onEnd);
      es?.close();
    };
  }, [consultationId]);

  const view = useMemo(
    () =>
      thread
        ? toChatView(
            thread.rows,
            deltas,
            EMPTY_CONSULTS,
            undefined,
            thread.to?.billing
          )
        : null,
    [thread, deltas]
  );
  const items = view?.items ?? [];
  const title = thread
    ? `${personName(thread.from, "Unknown bot")} and ${personName(thread.to, "Unknown bot")}`
    : "Consultation";

  if (!consultationId) {
    return null;
  }

  let body: ReactNode;
  if (failed) {
    body = (
      <div className="flex flex-col items-start gap-3">
        <p className="text-muted-foreground text-sm" role="alert">
          {
            "Couldn't load the consultation. Check your connection and try again."
          }
        </p>
        <Button onClick={onRetry} size="sm" variant="outline">
          Retry
        </Button>
      </div>
    );
  } else if (thread === null) {
    body = (
      <p className="text-muted-foreground text-sm">Loading the consultation…</p>
    );
  } else {
    body = (
      <div className="flex flex-col gap-5">
        {thread.question ? (
          <div className="flex flex-col items-end gap-1">
            <span className="text-muted-foreground text-[13px]">
              {personName(thread.from)}
            </span>
            <p className="bg-secondary max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px] leading-6 whitespace-pre-wrap">
              {thread.question}
            </p>
          </div>
        ) : null}
        <span className="text-muted-foreground text-[13px]">
          {personName(thread.to)}
        </span>
        <MessageList
          items={items.filter((i) => i.kind !== "user")}
          pending={[]}
          slug={personSlug(thread.to)}
          working={view?.working}
        />
      </div>
    );
  }

  return (
    <>
      <SheetHeader className="border-border border-b">
        <SheetTitle className="flex items-center gap-2">
          {thread?.from ? (
            <BotAvatar
              avatar={thread.from.avatar}
              size={20}
              slug={thread.from.slug}
            />
          ) : null}
          <span>{thread?.from?.name ?? ""}</span>
          <ArrowLeftRight
            aria-label="and"
            className="text-muted-foreground size-4"
          />
          {thread?.to ? (
            <BotAvatar
              avatar={thread.to.avatar}
              size={20}
              slug={thread.to.slug}
            />
          ) : null}
          <span>{thread?.to?.name ?? ""}</span>
        </SheetTitle>
        <SheetDescription className="sr-only">
          {title}: private consultation between bots, read-only.
        </SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">{body}</div>
    </>
  );
}
