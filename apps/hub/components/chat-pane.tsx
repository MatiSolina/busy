"use client";

import { ArrowDown, Settings2 } from "lucide-react";
import dynamic from "next/dynamic";
import {
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { AiIssueNotice } from "@/components/ai-issue-notice";
import { BotAvatar, BotBooting } from "@/components/bot-avatar";
import { useChat, useStore } from "@/components/chat-app";
import { Composer, useAttachments } from "@/components/composer";
import { DeploySteps } from "@/components/deploy-steps";
import { LiveView } from "@/components/live-view";
import { ChatScrollContext, MessageList } from "@/components/messages";
import { MountOnOpen } from "@/components/mount-on-open";
import { QuickReplies } from "@/components/quick-replies";
import { MobileMenu } from "@/components/sidebar";
import { Button } from "@/components/ui/button";
import { type AiIssue, aiIssueFromResponse } from "@/lib/ai/errors";
import { type BotLite, consultedBy } from "@/lib/chat/client-store";
import {
  type ChatItem,
  createChatViewProjector,
  isWaitingForInput,
} from "@/lib/chat/items";
import { projectArchivedItems } from "@/lib/chat/projection";
import { waitStage } from "@/lib/chat/status";

const FiresideDialog = dynamic(() =>
  import("@/components/fireside-dialog").then((m) => m.FiresideDialog)
);

const BotSettings = dynamic(() =>
  import("@/components/bot-settings").then((m) => m.BotSettings)
);
const ThreadSheet = dynamic(() =>
  import("@/components/thread-sheet").then((m) => m.ThreadSheet)
);

function visibleBusy(
  waitingForInput: boolean,
  turnWorking: boolean,
  askerSlug: string | null
): boolean {
  if (waitingForInput) {
    return false;
  }
  return turnWorking || askerSlug !== null;
}

export function ChatPane({ slug }: { slug: string }) {
  const store = useStore();
  // biome-ignore lint/style/noNonNullAssertion: ChatApp only renders registered bot slugs from its store order
  const state = useChat((s) => s.bots[slug]!);
  const { bot } = state;
  const [editing, setEditing] = useState(false);
  const [thread, setThread] = useState<string | null>(null);
  const [live, setLive] = useState<"observe" | "control" | null>(null);
  const attachments = useAttachments(slug);
  const loadEarlier = useCallback(() => store.loadEarlier(slug), [slug, store]);
  const [fireside, setFireside] = useState<{
    id?: string;
    originId?: string;
  } | null>(null);
  const [firesideRefresh, setFiresideRefresh] = useState(0);
  const openFireside = useCallback(
    () => setFireside({ originId: crypto.randomUUID() }),
    []
  );
  const openSavedFireside = useCallback(
    (id: string) => setFireside({ id }),
    []
  );
  const closeFireside = useCallback(() => {
    setFireside(null);
    setFiresideRefresh((value) => value + 1);
  }, []);
  const [dragging, setDragging] = useState(false);

  // The bot's directory: other ready bots in creation order (same as /api/bot/directory).
  const peers = useChat((s) =>
    s.order
      .filter((o) => o !== slug && s.bots[o]?.bot.status === "ready")
      .map((o) => s.bots[o]?.bot.name)
      .filter((name): name is string => Boolean(name))
      .join("\u0000")
  );
  const currentProjector = useMemo(() => {
    const names = peers.split("\u0000");
    const slot = (n: number) => names[n - 1];
    return createChatViewProjector(
      state.rows,
      state.consults,
      slot,
      bot.billing
    );
  }, [state.rows, state.consults, peers, bot.billing]);
  const current = useMemo(
    () => currentProjector.project(state.deltas),
    [currentProjector, state.deltas]
  );
  // Replaced sessions are immutable while the current session streams. Keep their projection out
  // of the live-delta dependency so a partial reply does not replay archived rows.
  const past = useMemo(
    () => projectArchivedItems(state.past, state.consults, peers, bot.billing),
    [state.past, state.consults, peers, bot.billing]
  );
  const view = useMemo(
    () => ({ ...current, items: [...past, ...current.items] }),
    [current, past]
  );
  const waitingForInput = useMemo(
    () => isWaitingForInput(view.items),
    [view.items]
  );
  // An acknowledgement only queues the message; keep showing work until the stream consumes it.
  const working = view.working || state.pending.some((p) => !p.failed);
  // Rows and pending change per fact, never per delta: the status line doesn't follow the stream.
  const wait = useMemo(
    () => waitStage(state.rows, state.pending, view.working),
    [state.rows, state.pending, view.working]
  );
  // Answering another bot: that work lives in the consultation, not in this chat; point there.
  const askerSlug = useChat((s) => consultedBy(s, slug)?.from ?? null);
  const asker = useChat(
    (s) => (askerSlug ? s.bots[askerSlug]?.bot.name : null) ?? null
  );
  const askId = useChat((s) => {
    const c = consultedBy(s, slug);
    return c ? (s.bots[c.from]?.consults.get(c.callId)?.id ?? null) : null;
  });
  const busy = visibleBusy(waitingForInput, view.working, askerSlug);
  const loggingIn = view.items.some(
    (i) => i.kind === "login" && i.state === "open"
  );
  // Offered only when nothing is under way: no turn, no consultation, no message still on its way.
  const replies = offeredReplies(
    working || askerSlug !== null,
    state.pending.length,
    view.replies
  );
  const pickReply = useCallback(
    (text: string) => {
      store
        .send(slug, { files: [], id: crypto.randomUUID(), text })
        .catch(() => undefined);
    },
    [store, slug]
  );
  const loginInteraction = view.items.find(
    (i): i is Extract<ChatItem, { kind: "login" }> =>
      i.kind === "login" && i.state === "open"
  );
  const onLoginDone = useCallback(
    () =>
      loginInteraction
        ? store.answer(slug, loginInteraction.interactionId, "done")
        : false,
    [loginInteraction, slug, store]
  );
  const handleEditingOpen = useCallback(() => setEditing(true), []);
  const loginDone = loginInteraction ? onLoginDone : undefined;
  const retryMessage = useCallback(
    (id: string) => {
      store.retry(slug, id).catch(() => undefined);
    },
    [store, slug]
  );
  const handleTakeControl = useCallback(() => setLive("control"), []);
  const handleThreadOpen = useCallback((id: string) => setThread(id), []);
  const handleThreadClose = useCallback(() => setThread(null), []);
  const handleAskThread = useCallback(() => {
    if (askId) {
      handleThreadOpen(askId);
    }
  }, [askId, handleThreadOpen]);
  const handleDragLeave = useCallback((e: DragEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragging(false);
    }
  }, []);
  const handleDragOver = useCallback(
    (e: DragEvent<HTMLElement>) => {
      if (bot.status !== "ready" || !e.dataTransfer.types.includes("Files")) {
        return;
      }
      e.preventDefault();
      setDragging(true);
    },
    [bot.status]
  );
  const handleDrop = useCallback(
    (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      setDragging(false);
      attachments.add([...e.dataTransfer.files]);
    },
    [attachments]
  );

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: chat surface is the intentional file-drop target
    <section
      aria-label={`Chat with ${bot.name}`}
      className="relative flex h-dvh flex-col"
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <header className="busy-titlebar flex h-14 shrink-0 items-center gap-2 px-3 sm:gap-3 md:px-6">
        <MobileMenu />
        <BotAvatar avatar={bot.avatar} size={24} slug={slug} working={busy} />
        <div className="flex min-w-0 flex-1 items-baseline gap-3">
          <h1 className="truncate text-[15px] font-semibold">{bot.name}</h1>
        </div>
        <Button
          aria-label="Bot settings"
          className="text-muted-foreground"
          onClick={handleEditingOpen}
          size="icon-sm"
          variant="ghost"
        >
          <Settings2 aria-hidden="true" />
        </Button>
      </header>

      {bot.status === "ready" ? (
        <>
          <Scroller>
            {state.snapshotStatus === "ready" ? null : (
              <ConversationLoading slug={slug} status={state.snapshotStatus} />
            )}
            {view.items.length || state.pending.length ? (
              <MessageList
                botName={bot.name}
                earlierError={earlierIs(state, "error")}
                earlierLoading={earlierIs(state, "loading")}
                hasEarlier={state.historyHasMore || state.pastHasMore}
                items={view.items}
                loginControlOpen={live === "control"}
                onConfigureBot={handleEditingOpen}
                onLoadEarlier={loadEarlier}
                onOpenThread={handleThreadOpen}
                onRetryPending={retryMessage}
                onTakeControl={handleTakeControl}
                pending={state.pending}
                slug={slug}
                status={state.status}
                wait={wait}
                working={view.working}
              />
            ) : (
              <>
                {/* With messages on screen, "Show earlier messages" reaches the archive too. */}
                <EarlierConversations slug={slug} />
                <EmptyChat bot={bot} ready={state.snapshotStatus === "ready"} />
              </>
            )}
            <FiresideLinks
              key={`${slug}:${firesideRefresh}`}
              onOpen={openSavedFireside}
              slug={slug}
            />
          </Scroller>
          {askerSlug ? (
            <div className="text-muted-foreground mx-auto flex w-full shrink-0 items-center gap-2 px-6 pb-2 text-[13px]">
              <span className="text-shimmer">
                Answering {asker ?? "another bot"}…
              </span>
              {askId ? (
                <button
                  className="hover:text-foreground underline underline-offset-2"
                  onClick={handleAskThread}
                  type="button"
                >
                  See the conversation
                </button>
              ) : null}
            </div>
          ) : null}
          <QuickReplies onPick={pickReply} replies={replies} />
          {/* While the next message is on its way, the last turn is already over: nothing to stop yet. */}
          <Composer
            attachments={attachments}
            onSecondOpinion={openFireside}
            slug={slug}
            turnId={view.working ? view.turnId : null}
            working={working}
          />
        </>
      ) : (
        <Preparing bot={bot} onConfigureBot={handleEditingOpen} />
      )}

      {dragging ? (
        <div className="animate-enter border-foreground/30 bg-background/80 pointer-events-none absolute inset-3 z-10 grid place-items-center rounded-xl border border-dashed">
          <p className="text-sm">Drop the files to send them to {bot.name}</p>
        </div>
      ) : null}

      <MountOnOpen open={fireside !== null}>
        <FiresideDialog onClose={closeFireside} slug={slug} target={fireside} />
      </MountOnOpen>
      {bot.status === "ready" ? (
        <MountOnOpen open={live !== null}>
          <LiveView
            avatar={bot.avatar}
            hideTrigger
            loggingIn={loggingIn}
            name={bot.name}
            onLoginDone={loginDone}
            onOpenChange={setLive}
            onTeachDone={pickReply}
            open={live}
            slug={slug}
            working={busy}
          />
        </MountOnOpen>
      ) : null}
      <MountOnOpen open={editing}>
        <BotSettings
          bot={bot}
          loggingIn={loggingIn}
          onLoginDone={loginDone}
          onOpenChange={setEditing}
          onTeachDone={pickReply}
          open={editing}
          working={busy}
        />
      </MountOnOpen>
      <MountOnOpen open={thread !== null}>
        <ThreadSheet consultationId={thread} onClose={handleThreadClose} />
      </MountOnOpen>
    </section>
  );
}

// One control pages the active session and then the archive, so either side's status shows on it.
function earlierIs(
  state: { historyStatus: string; pastStatus: string },
  status: "error" | "loading"
) {
  return state.historyStatus === status || state.pastStatus === status;
}

function EarlierConversations({ slug }: { slug: string }) {
  const store = useStore();
  const status = useChat((s) => s.bots[slug]?.pastStatus);
  const load = useCallback(() => store.loadPast(slug), [slug, store]);
  // This is the one-time archive-session bootstrap. Once it has returned, the
  // flat message-list control owns the remaining active/archive frontier.
  if (status === "ready") {
    return null;
  }
  return (
    <div className="mb-5 flex flex-col items-center gap-2">
      <Button
        disabled={status === "loading"}
        onClick={load}
        size="sm"
        variant="ghost"
      >
        {status === "loading"
          ? "Loading earlier conversations…"
          : "Load earlier conversations"}
      </Button>
      {status === "error" ? (
        <span role="status">
          Couldn&apos;t load earlier conversations. Try again.
        </span>
      ) : null}
    </div>
  );
}

const NO_REPLIES: readonly string[] = [];

function ConversationLoading({
  slug,
  status,
}: {
  slug: string;
  status: string;
}) {
  const store = useStore();
  const retry = useCallback(() => store.loadSnapshot(slug), [slug, store]);
  return status === "error" ? (
    <div role="alert">
      Couldn&apos;t load this conversation.{" "}
      <Button onClick={retry} variant="ghost">
        Retry conversation
      </Button>
    </div>
  ) : (
    <p className="text-muted-foreground py-6 text-sm" role="status">
      Loading conversation…
    </p>
  );
}

function offeredReplies(
  busy: boolean,
  pending: number,
  replies: readonly string[]
): readonly string[] {
  return busy || pending > 0 ? NO_REPLIES : replies;
}

/**
 * Sticks to the bottom while the user is there, also when content grows on its own (a file preview
 * loading); leaves them alone when they scrolled up, with a way back down.
 */
function Scroller({ children }: { children: React.ReactNode }) {
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } =
    useStickToBottom({ initial: "instant", resize: "smooth" });
  const handleScrollToBottom = useCallback(
    () => scrollToBottom(),
    [scrollToBottom]
  );
  return (
    <div className="relative min-h-0 flex-1">
      <div
        className="h-full overflow-y-auto [overflow-anchor:none]"
        data-chat-scroll=""
        ref={scrollRef}
      >
        <div className="mx-auto w-full px-6 pt-6 pb-10" ref={contentRef}>
          <ChatScrollContext value={scrollRef}>{children}</ChatScrollContext>
        </div>
      </div>
      {isAtBottom ? null : (
        <Button
          aria-label="Scroll to bottom"
          className="animate-enter text-muted-foreground dark:bg-background dark:hover:bg-background absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md"
          onClick={handleScrollToBottom}
          size="icon-sm"
          variant="outline"
        >
          <ArrowDown aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

function EmptyChat({ bot, ready }: { bot: BotLite; ready: boolean }) {
  if (!ready) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2 pt-[18vh] text-center">
      <p className="text-xl font-semibold tracking-tight">Message {bot.name}</p>
      <p className="text-muted-foreground mx-auto max-w-md text-sm">
        Send it files, ask for an Excel or Word file, or have it consult another
        bot. It works on its own computer.
      </p>
    </div>
  );
}

/** While the bot deploys (ChatApp polls it); the store swaps in the chat when it's ready. */
function Preparing({
  bot,
  onConfigureBot,
}: {
  bot: BotLite;
  onConfigureBot: () => void;
}) {
  if (bot.status === "failed") {
    return <Failed bot={bot} onConfigureBot={onConfigureBot} />;
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-8 text-center">
      <BotBooting
        avatar={bot.avatar}
        phrase={
          bot.status === "creating"
            ? "Clanker assembling…"
            : "Clanker deploying…"
        }
        slug={bot.slug}
      />
      {bot.progress ? <DeploySteps steps={bot.progress} /> : null}
    </div>
  );
}

/** A failed deploy retries on any save (patchBot), so Try again is an empty one; DeployWatcher takes it from there. */
function Failed({
  bot,
  onConfigureBot,
}: {
  bot: BotLite;
  onConfigureBot: () => void;
}) {
  const store = useStore();
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const [issue, setIssue] = useState<AiIssue | null>(null);
  const retry = useCallback(async () => {
    setState("busy");
    setIssue(null);
    const res = await fetch(`/api/bots/${encodeURIComponent(bot.slug)}`, {
      body: "{}",
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    }).catch(() => null);
    const body: unknown = await res?.json().catch(() => null);
    if (!res?.ok) {
      setIssue(
        aiIssueFromResponse(body, {
          provider: bot.billing,
          status: res?.status,
        })
      );
      return setState("error");
    }
    if (!body || typeof body !== "object" || !("slug" in body)) {
      return setState("error");
    }
    store.upsertBot(body as BotLite);
  }, [bot.slug, bot.billing, store]);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-xl font-semibold tracking-tight">{`Couldn't start ${bot.name}`}</p>
      {issue ? (
        <AiIssueNotice issue={issue} />
      ) : (
        <p
          className="text-muted-foreground max-w-md text-sm"
          role={state === "error" ? "alert" : undefined}
        >
          {state === "error"
            ? "Can't reach Busy. Try again."
            : (bot.error ?? "The deploy failed. Check it in Vercel.")}
        </p>
      )}
      {bot.progress ? (
        <div className="my-4 flex w-full justify-center">
          <DeploySteps steps={bot.progress} />
        </div>
      ) : null}
      <Button onClick={onConfigureBot} size="sm" variant="outline">
        Open bot settings
      </Button>
      <Button className="mt-2" disabled={state === "busy"} onClick={retry}>
        {state === "busy" ? "Trying again…" : "Try again"}
      </Button>
    </div>
  );
}

interface FiresideReference {
  createdAt: string;
  id: string;
  names: string[];
}
function FiresideLinks({
  slug,
  onOpen,
}: {
  slug: string;
  onOpen: (id: string) => void;
}) {
  const [rows, setRows] = useState<FiresideReference[]>([]);
  const enabled = useChat(
    (s) => s.selected === slug && s.bots[slug]?.snapshotStatus === "ready"
  );
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    async function loadReferences() {
      try {
        const response = await fetch(
          `/api/bots/${encodeURIComponent(slug)}/firesides`,
          { signal: controller.signal }
        );
        if (!response.ok) {
          return;
        }
        const references = (await response.json()) as FiresideReference[];
        if (!cancelled) {
          setRows(references);
        }
      } catch {
        /* The chat remains usable; selecting it again retries the references. */
      }
    }
    loadReferences();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [slug, enabled]);
  const open = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const id = event.currentTarget.dataset.fireside;
      if (id) {
        onOpen(id);
      }
    },
    [onOpen]
  );
  return rows.length ? (
    <div className="mx-auto flex w-full flex-col gap-2 pt-4">
      {rows.map((row) => (
        <button
          className="text-muted-foreground hover:text-foreground flex items-center gap-2 py-2 text-left text-sm"
          data-fireside={row.id}
          key={row.id}
          onClick={open}
          type="button"
        >
          <span>↗ Fireside · {row.names.join(" + ")}</span>
          <time className="ml-auto text-xs" dateTime={row.createdAt}>
            {row.createdAt.slice(0, 10)}
          </time>
        </button>
      ))}
    </div>
  ) : null;
}
