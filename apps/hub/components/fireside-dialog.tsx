"use client";

import { ArrowUp, Loader2, Square, X } from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { BotAvatar } from "@/components/bot-avatar";
import { LiveView } from "@/components/live-view";
import { MessageList } from "@/components/messages";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ChatItem } from "@/lib/chat/items";
import type {
  FiresideCommand,
  FiresideView,
  PublicParticipant,
} from "@/lib/firesides/types";

class FiresideRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request(url: string, body?: unknown): Promise<FiresideView> {
  const response = await fetch(url, {
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    method: body ? "POST" : "GET",
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new FiresideRequestError(
      result?.error ?? "Couldn't open the fireside. Try again.",
      response.status
    );
  }
  return result as FiresideView;
}

function openRoom(slug: string, target: { id?: string; originId?: string }) {
  return target.id
    ? request(`/api/firesides/${target.id}`)
    : request(`/api/bots/${encodeURIComponent(slug)}/firesides`, {
        id: target.originId,
      });
}

export function FiresideDialog(props: {
  slug: string;
  target: { id?: string; originId?: string } | null;
  onClose: () => void;
}) {
  return props.target ? (
    <FiresideRoom
      key={props.target.id ?? props.target.originId}
      {...props}
      target={props.target}
    />
  ) : null;
}

function FiresideRoom({
  slug,
  target,
  onClose,
}: {
  slug: string;
  target: { id?: string; originId?: string };
  onClose: () => void;
}) {
  const [room, setRoom] = useState<FiresideView | null>(null);
  const current = useRef<FiresideView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [closing, setClosing] = useState(false);
  const closeRequested = useRef<boolean>(false);
  const openingError = useRef<Error | null>(null);
  const inFlight = useRef(false);
  const retryCommand = useRef<{
    kind: FiresideCommand["kind"];
    text?: string;
    body: Record<string, unknown>;
  } | null>(null);
  const [live, setLive] = useState<"observe" | "control" | null>(null);
  const { scrollRef, contentRef } = useStickToBottom({
    initial: "instant",
    resize: "smooth",
  });
  const apply = useCallback((value: FiresideView) => {
    current.current = value;
    setRoom(value);
  }, []);
  const closeRoom = useCallback(
    async (value: FiresideView) => {
      if (value.status !== "closed") {
        await request(`/api/firesides/${value.id}`, {
          id: crypto.randomUUID(),
          kind: "close",
          revision: value.revision,
        });
      }
      onClose();
    },
    [onClose]
  );
  useEffect(() => {
    let mounted = true;
    const opening = openRoom(slug, target);
    opening
      .then(async (value) => {
        if (!mounted) {
          return;
        }
        apply(value);
        if (closeRequested.current) {
          await closeRoom(value);
        }
      })
      .catch((failure: Error) => {
        if (mounted) {
          openingError.current = failure;
          setError(failure.message);
          setClosing(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, [apply, closeRoom, slug, target]);
  const id = room?.id;
  useEffect(() => {
    if (!id) {
      return;
    }
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await request(`/api/firesides/${id}`);
        if (
          mounted &&
          !inFlight.current &&
          value.revision >= (current.current?.revision ?? 0)
        ) {
          apply(value);
        }
      } catch {
        /* A failed poll keeps the transcript; the next poll retries. */
      }
      if (mounted) {
        timer = setTimeout(
          poll,
          current.current?.status === "running" ||
            current.current?.status === "closing"
            ? 1200
            : 4000
        );
      }
    };
    timer = setTimeout(poll, 500);
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [apply, id]);
  const command = useCallback(
    async (kind: FiresideCommand["kind"], text?: string) => {
      const value = current.current;
      if (!value || inFlight.current) {
        return false;
      }
      inFlight.current = true;
      setPending(true);
      setError(null);
      try {
        const previous = retryCommand.current;
        const body =
          previous?.kind === kind && previous.text === text
            ? previous.body
            : {
                id: crypto.randomUUID(),
                kind,
                revision: value.revision,
                ...(text ? { text } : {}),
              };
        retryCommand.current = { body, kind, text };
        apply(await request(`/api/firesides/${value.id}`, body));
        retryCommand.current = null;
        return true;
      } catch (failure) {
        if (failure instanceof FiresideRequestError && failure.status < 500) {
          retryCommand.current = null;
        }
        setError(
          failure instanceof Error ? failure.message : "Please try again."
        );
        return false;
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [apply]
  );
  const close = useCallback(async () => {
    closeRequested.current = true;
    setClosing(true);
    setLive(null);
    if (!(current.current || error)) {
      return;
    }
    try {
      const initialFailure = openingError.current;
      if (
        !current.current &&
        initialFailure instanceof FiresideRequestError &&
        initialFailure.status < 500
      ) {
        onClose();
        return;
      }
      await closeRoom(current.current ?? (await openRoom(slug, target)));
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Couldn't close. Try again."
      );
      setClosing(false);
    }
  }, [closeRoom, error, onClose, slug, target]);
  const openChange = useCallback(
    (open: boolean) => {
      if (!open) {
        close();
      }
    },
    [close]
  );
  const continueChat = useCallback(() => command("continue"), [command]);
  const pause = useCallback(() => command("pause"), [command]);
  const intervene = useCallback(
    (text: string) => command("intervene", text),
    [command]
  );
  const takeControl = useCallback(() => setLive("control"), []);
  const answer = useCallback(
    async (
      interactionId: string,
      value: { optionId?: string; text?: string }
    ) => {
      const latest = current.current;
      if (!latest?.active) {
        return false;
      }
      const response = await fetch(`/api/firesides/${latest.id}/answer`, {
        body: JSON.stringify({
          interactionId,
          ...value,
          participantId: latest.participants[latest.active.speaker].id,
          revision: latest.revision,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }).catch(() => null);
      return response?.ok ?? false;
    },
    []
  );
  const login = room?.active?.items.find(
    (item): item is Extract<ChatItem, { kind: "login" }> =>
      item.kind === "login" && item.state === "open"
  );
  const loginDone = useCallback(
    () =>
      login
        ? answer(login.interactionId, { optionId: "done" })
        : Promise.resolve(true),
    [answer, login]
  );
  const active = room?.active;
  const participant = active && room.participants[active.speaker];
  const working = room?.status === "running";
  return (
    <Dialog onOpenChange={openChange} open>
      <DialogContent
        className="flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 rounded-none p-0 sm:h-[min(820px,90dvh)] sm:max-w-4xl sm:rounded-xl"
        initialFocus={false}
        showCloseButton={false}
      >
        <header className="border-border flex shrink-0 items-center gap-3 border-b px-5 py-4">
          <div className="min-w-0 flex-1">
            <DialogTitle>Fireside</DialogTitle>
            <DialogDescription className="mt-1 truncate">
              {room
                ? `${room.participants.primary.name} + ${room.participants.guest.name}`
                : "Second opinion"}
            </DialogDescription>
          </div>
          {participant ? (
            <LiveView
              avatar={participant.avatar}
              endpoint={`/api/firesides/${room.id}/live`}
              key={participant.id}
              loggingIn={Boolean(login)}
              name={participant.name}
              onLoginDone={loginDone}
              onOpenChange={setLive}
              open={live}
              slug={participant.slug}
              working={working}
            />
          ) : null}
          <Button
            aria-label="Close fireside"
            disabled={closing}
            onClick={close}
            size="icon-sm"
            variant="ghost"
          >
            {closing ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <X aria-hidden="true" />
            )}
          </Button>
        </header>
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          data-chat-scroll=""
          ref={scrollRef}
        >
          <div
            className="mx-auto flex max-w-[760px] flex-col gap-7 px-6 py-6"
            ref={contentRef}
          >
            {room?.messages.map((message) => (
              <div key={message.id}>
                {message.speaker === "user" ? null : (
                  <ParticipantName
                    participant={room.participants[message.speaker]}
                  />
                )}
                <MessageList
                  items={
                    message.speaker === "user"
                      ? [
                          {
                            files: [],
                            id: message.id,
                            kind: "user",
                            text: message.text,
                          },
                        ]
                      : (message.items ?? [
                          {
                            id: message.id,
                            kind: "bot",
                            streaming: false,
                            text: message.text,
                          },
                        ])
                  }
                  mcpContext={`${room.id}/${message.id}`}
                  pending={[]}
                  slug={
                    message.speaker === "user"
                      ? slug
                      : room.participants[message.speaker].slug
                  }
                />
              </div>
            ))}
            {active && participant ? (
              <div>
                <ParticipantName participant={participant} />
                <MessageList
                  items={active.items}
                  loginControlOpen={live === "control"}
                  mcpContext={`${room.id}/${active.messageId}`}
                  onAnswerInteraction={answer}
                  onTakeControl={takeControl}
                  pending={[]}
                  slug={participant.slug}
                  working
                />
              </div>
            ) : null}
            {room ? null : (
              <Loader2
                aria-label="Opening fireside"
                className="text-muted-foreground size-4 animate-spin"
              />
            )}
          </div>
        </div>
        {(error ?? room?.error) ? (
          <p className="text-destructive px-6 pb-3 text-sm" role="alert">
            {error ?? room?.error}
          </p>
        ) : null}
        <div className="shrink-0">
          {room && !working ? (
            <div className="mx-auto flex max-w-[760px] justify-end px-6 pb-2">
              <Button
                disabled={pending || closing || room.status === "closing"}
                onClick={continueChat}
                size="sm"
                variant="ghost"
              >
                Continue
              </Button>
            </div>
          ) : null}
          <FiresideComposer
            disabled={!room || pending || closing || room.status === "closing"}
            onPause={pause}
            onSend={intervene}
            working={working}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ParticipantName({ participant }: { participant: PublicParticipant }) {
  return (
    <div
      className="text-muted-foreground mb-3 flex items-center gap-2 text-sm"
      title={participant.model}
    >
      <BotAvatar
        avatar={participant.avatar}
        size={22}
        slug={participant.slug}
      />
      <span>{participant.name}</span>
    </div>
  );
}
function FiresideComposer({
  disabled,
  working,
  onSend,
  onPause,
}: {
  disabled: boolean;
  working: boolean;
  onSend: (text: string) => Promise<boolean>;
  onPause: () => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const send = useCallback(async () => {
    if (text.trim() && !disabled && (await onSend(text.trim()))) {
      setText("");
    }
  }, [disabled, onSend, text]);
  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      send();
    },
    [send]
  );
  const keyDown = useCallback(
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
  const change = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value),
    []
  );
  return (
    <form
      className="border-input bg-card mx-6 mb-5 flex flex-col gap-2 rounded-2xl border px-3 py-2 sm:mx-auto sm:w-[calc(100%-3rem)] sm:max-w-[712px]"
      onSubmit={submit}
    >
      <label className="sr-only" htmlFor="fireside-message">
        Message
      </label>
      <textarea
        className="placeholder:text-muted-foreground [field-sizing:content] max-h-40 min-h-6 w-full resize-none bg-transparent px-1 py-1.5 text-base leading-6 outline-none sm:text-[15px]"
        disabled={disabled}
        id="fireside-message"
        onChange={change}
        onKeyDown={keyDown}
        placeholder="Write a message"
        rows={1}
        value={text}
      />
      <div className="flex justify-end">
        {working && !text.trim() ? (
          <button
            aria-label="Stop"
            className="bg-primary text-primary-foreground grid size-8 place-items-center rounded-full disabled:opacity-30"
            disabled={disabled}
            onClick={onPause}
            type="button"
          >
            <Square aria-hidden="true" className="size-3 fill-current" />
          </button>
        ) : (
          <button
            aria-label="Send"
            className="bg-primary text-primary-foreground grid size-8 place-items-center rounded-full disabled:opacity-30"
            disabled={disabled || !text.trim()}
            type="submit"
          >
            <ArrowUp aria-hidden="true" className="size-4" />
          </button>
        )}
      </div>
    </form>
  );
}
