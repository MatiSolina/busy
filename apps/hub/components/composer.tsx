"use client";

import { ArrowUp, Loader2, Mic, Paperclip, Square, X } from "lucide-react";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useStore } from "@/components/chat-app";
import { SECOND_OPINION_COMMAND } from "@/lib/firesides/types";
import { cn } from "@/lib/utils";

interface Attachment {
  fileId?: string;
  localId: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
}
type ReadyAttachment = Attachment & { fileId: string; status: "ready" };

const MAX_FILES = 6;

// ponytail: the browser's own dictation (Web Speech API), no server. Firefox has none, so there the mic doesn't show.
interface Dictation {
  abort: () => void;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onresult: ((e: { results: SpeechRecognitionResultList }) => void) | null;
  start: () => void;
  stop: () => void;
}
function speech() {
  const w = window as unknown as Record<
    string,
    (new () => Dictation) | undefined
  >;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}
const noSubscribe = () => () => undefined;

/** Reserve → PUT straight to Blob → complete; the hub never carries the bytes (spec 4.4). */
async function upload(slug: string, file: File): Promise<string> {
  const contentType = file.type || "application/octet-stream";
  const reserved = await fetch("/api/files", {
    body: JSON.stringify({
      botSlug: slug,
      contentType,
      name: file.name,
      size: file.size,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!reserved.ok) {
    throw new Error("reserve failed");
  }
  const { fileId, uploadUrl } = (await reserved.json()) as {
    fileId: string;
    uploadUrl: string;
  };
  const put = await fetch(uploadUrl, {
    body: file,
    headers: { "content-type": contentType },
    method: "PUT",
  });
  if (!put.ok) {
    throw new Error("upload failed");
  }
  const done = await fetch(`/api/files/${fileId}/complete`, { method: "POST" });
  if (!done.ok) {
    throw new Error("complete failed");
  }
  return fileId;
}

export function useAttachments(slug: string) {
  const [items, setItems] = useState<Attachment[]>([]);
  const update = (localId: string, patch: Partial<Attachment>) =>
    setItems((list) =>
      list.map((a) => (a.localId === localId ? { ...a, ...patch } : a))
    );
  return {
    add(files: File[]) {
      for (const file of files.slice(
        0,
        Math.max(0, MAX_FILES - items.length)
      )) {
        const localId = crypto.randomUUID();
        setItems((list) => [
          ...list,
          { localId, name: file.name, size: file.size, status: "uploading" },
        ]);
        upload(slug, file).then(
          (fileId) => update(localId, { fileId, status: "ready" }),
          () => update(localId, { status: "error" })
        );
      }
    },
    clear: () => setItems([]),
    items,
    remove: (localId: string) =>
      setItems((list) => list.filter((a) => a.localId !== localId)),
  };
}

export function Composer({
  slug,
  attachments,
  working,
  turnId,
  onSecondOpinion,
}: {
  slug: string;
  attachments: ReturnType<typeof useAttachments>;
  working: boolean;
  turnId: string | null;
  onSecondOpinion?: () => void;
}) {
  const store = useStore();
  const text = useRef("");
  const message = useRef<HTMLTextAreaElement>(null);
  const [hasText, setHasText] = useState(false);
  // The browser owns keystrokes and selection. React only needs to know when
  // send availability changes, rather than rebuilding every control per key.
  const setText = useCallback((value: string) => {
    text.current = value;
    setHasText(value.trim().length > 0);
    if (message.current && message.current.value !== value) {
      message.current.value = value;
    }
  }, []);
  // eve cancels asynchronously: from the tap until the turn settles, the button says it's stopping.
  const [stopping, setStopping] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const ready = attachments.items.filter(
    (a): a is ReadyAttachment => a.status === "ready" && Boolean(a.fileId)
  );
  const uploading = attachments.items.some((a) => a.status === "uploading");
  const canSend = !uploading && (hasText || ready.length > 0);
  const canDictate = useSyncExternalStore(
    noSubscribe,
    () => Boolean(speech()),
    () => false
  );
  const dictation = useRef<Dictation | null>(null);
  const [listening, setListening] = useState(false);
  const isStopping = stopping === turnId;
  useEffect(() => () => dictation.current?.abort(), []);

  const dictate = useCallback(() => {
    if (dictation.current) {
      return dictation.current.stop();
    }
    const Speech = speech();
    if (!Speech) {
      return;
    }
    const rec = new Speech();
    rec.lang = navigator.language;
    rec.continuous = true;
    rec.interimResults = true;
    // What was typed stays; everything heard so far (interim included) is rewritten after it on each result.
    const before = text.current.trim() ? `${text.current.trimEnd()} ` : "";
    rec.onresult = (e) =>
      setText(
        before +
          Array.from(e.results, (r) => r[0].transcript)
            .join("")
            .trim()
      );
    rec.onend = () => {
      dictation.current = null;
      setListening(false);
    };
    dictation.current = rec;
    rec.start();
    setListening(true);
  }, [setText]);

  const send = useCallback(() => {
    if (!canSend) {
      return;
    }
    // Otherwise a late result would refill the box with what was just sent.
    dictation.current?.abort();
    if (onSecondOpinion && SECOND_OPINION_COMMAND.test(text.current.trim())) {
      onSecondOpinion();
      setText("");
      return;
    }
    store.send(slug, {
      files: ready.map((a) => ({ id: a.fileId, name: a.name })),
      id: crypto.randomUUID(),
      text: text.current.trim(),
    });
    setText("");
    attachments.clear();
  }, [attachments, canSend, ready, slug, store, setText, onSecondOpinion]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      send();
    },
    [send]
  );
  const handleRemove = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const { localId } = event.currentTarget.dataset;
      if (localId) {
        attachments.remove(localId);
      }
    },
    [attachments]
  );
  const handleTextChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      // Typing ends dictation: its next result would rewrite the box from where it started.
      dictation.current?.abort();
      setText(event.target.value);
      // A running turn already has flow awake, and a message now would steer it anyway.
      if (!working) {
        store.warm(slug);
      }
    },
    [setText, store, slug, working]
  );
  const handleFocus = useCallback(() => {
    if (!working) {
      store.warm(slug);
    }
  }, [store, slug, working]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault();
        send();
      }
    },
    [send]
  );
  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (event.clipboardData.files.length) {
        attachments.add([...event.clipboardData.files]);
      }
    },
    [attachments]
  );
  const handleFilesChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      attachments.add([...(event.target.files ?? [])]);
      event.target.value = "";
    },
    [attachments]
  );
  const handleAttachClick = useCallback(() => input.current?.click(), []);
  const handleStop = useCallback(async () => {
    if (!turnId) {
      return;
    }
    setStopping(turnId);
    if (!(await store.stop(slug, turnId))) {
      setStopping(null);
    }
  }, [slug, store, turnId]);

  return (
    <div className="relative shrink-0 px-6 pb-5">
      <form
        className="border-input bg-card mx-auto flex w-full flex-col gap-2 rounded-2xl border px-3 py-2 transition-colors"
        onSubmit={handleSubmit}
      >
        {attachments.items.length ? (
          <ul className="flex flex-wrap gap-1.5 pt-1">
            {attachments.items.map((a) => (
              <li
                className={cn(
                  "bg-secondary flex items-center gap-1.5 rounded-md py-1 pr-1 pl-2.5 text-[13px]",
                  a.status === "error" && "text-destructive"
                )}
                key={a.localId}
              >
                {a.status === "uploading" ? (
                  <Loader2
                    aria-hidden="true"
                    className="size-3.5 animate-spin"
                  />
                ) : null}
                <span className="max-w-48 truncate">{a.name}</span>
                {a.status === "error" ? <span>{"couldn't upload"}</span> : null}
                <button
                  aria-label={`Remove ${a.name}`}
                  className="text-muted-foreground hover:text-foreground rounded-sm p-0.5"
                  data-local-id={a.localId}
                  onClick={handleRemove}
                  type="button"
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <label className="sr-only" htmlFor={`composer-${slug}`}>
          Message
        </label>
        <textarea
          className="placeholder:text-muted-foreground [field-sizing:content] max-h-48 min-h-6 w-full resize-none bg-transparent px-1 py-1.5 text-base leading-6 outline-none sm:text-[15px]"
          defaultValue=""
          id={`composer-${slug}`}
          onChange={handleTextChange}
          onFocus={handleFocus}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Write a message"
          ref={message}
          rows={1}
        />
        <div className="flex items-center justify-between">
          <input
            hidden
            multiple
            onChange={handleFilesChange}
            ref={input}
            type="file"
          />
          <button
            aria-label="Attach files"
            className="text-muted-foreground hover:bg-accent hover:text-foreground grid size-8 place-items-center rounded-full transition-colors"
            onClick={handleAttachClick}
            type="button"
          >
            <Paperclip aria-hidden="true" className="size-4" />
          </button>
          <div className="flex items-center gap-1">
            {canDictate ? (
              <button
                aria-label={listening ? "Stop dictating" : "Dictate"}
                className={cn(
                  "text-muted-foreground hover:bg-accent hover:text-foreground grid size-8 place-items-center rounded-full transition-colors",
                  listening &&
                    "bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive"
                )}
                onClick={dictate}
                type="button"
              >
                <Mic
                  aria-hidden="true"
                  className={cn("size-4", listening && "animate-pulse")}
                />
              </button>
            ) : null}
            {working && !canSend && turnId ? (
              <button
                aria-label={isStopping ? "Stopping…" : "Stop"}
                className="bg-primary text-primary-foreground grid size-8 place-items-center rounded-full transition-opacity hover:opacity-90 disabled:opacity-60"
                disabled={isStopping}
                onClick={handleStop}
                type="button"
              >
                {isStopping ? (
                  <Loader2
                    aria-hidden="true"
                    className="size-3.5 animate-spin"
                  />
                ) : (
                  <Square aria-hidden="true" className="size-3 fill-current" />
                )}
              </button>
            ) : (
              <button
                aria-label="Send"
                className="bg-primary text-primary-foreground grid size-8 place-items-center rounded-full transition-opacity hover:opacity-90 disabled:opacity-30"
                disabled={!canSend}
                type="submit"
              >
                <ArrowUp aria-hidden="true" className="size-4" />
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
