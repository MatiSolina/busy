"use client";

import {
  AlertCircle,
  Check,
  ChevronRight,
  Clock3,
  Copy,
  KeyRound,
  Loader2,
  MousePointer2,
  Paperclip,
} from "lucide-react";
import dynamic from "next/dynamic";
import {
  type AnimationEvent,
  Children,
  type ComponentProps,
  createContext,
  memo,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type CustomItemComponentProps,
  Virtualizer,
  type VirtualizerHandle,
} from "virtua";
import { AiIssueNotice } from "@/components/ai-issue-notice";
import { BotAvatar } from "@/components/bot-avatar";
import { useChat, useStore } from "@/components/chat-app";
import { FileCard } from "@/components/file-card";
import { FormCard } from "@/components/form-card";
import { MessageMarkdown } from "@/components/message-markdown";
import { PlanCard } from "@/components/plan-card";
import { Button } from "@/components/ui/button";
import type { Pending } from "@/lib/chat/client-store";
import {
  type ChatItem,
  isAwaitingInput,
  isWaitingForInput,
  waitingActivityIds,
} from "@/lib/chat/items";
import type { WaitStage } from "@/lib/chat/status";
import { cn } from "@/lib/utils";
import styles from "./messages.module.css";

const McpAppHost = dynamic(
  () => import("@/components/mcp-app-host").then((module) => module.McpAppHost),
  {
    loading: () => (
      <div className="text-muted-foreground p-4 text-sm">Loading app…</div>
    ),
    ssr: false,
  }
);
const InlineCodeTaskCard = dynamic(() =>
  import("@/components/inline-code-task-card").then((m) => m.InlineCodeTaskCard)
);
const InteractionCard = dynamic(() =>
  import("@/components/interaction-card").then((m) => m.InteractionCard)
);

type AnswerInteraction = (
  id: string,
  answer: { optionId?: string; text?: string }
) => Promise<boolean>;

type Activity = Extract<ChatItem, { kind: "activity" }>;
type Block =
  | { kind: "item"; item: Exclude<ChatItem, Activity> }
  | { kind: "steps"; id: string; steps: Activity[] };
interface DeliveryState {
  keys: Map<string, string>;
  pending: readonly Pending[];
}

function initialPendingKeys(pending: readonly Pending[]) {
  return new Map(
    pending.flatMap((p) =>
      p.deliveryId ? [[p.deliveryId, p.id] as const] : []
    )
  );
}

function reconcileDeliveries(
  previous: DeliveryState,
  pending: readonly Pending[],
  items: readonly ChatItem[]
): DeliveryState | undefined {
  if (
    previous.pending === pending ||
    (previous.pending.length === 0 && pending.length === 0)
  ) {
    return;
  }
  const keys = new Map(previous.keys);
  for (const p of pending) {
    if (p.deliveryId) {
      keys.set(p.deliveryId, p.id);
    }
  }
  const itemIds = new Set(items.map((item) => item.id));
  for (const [deliveryId] of keys) {
    if (
      !(
        itemIds.has(deliveryId) ||
        pending.some((p) => p.deliveryId === deliveryId)
      )
    ) {
      keys.delete(deliveryId);
    }
  }
  return { keys, pending };
}

// Consecutive tool calls read as one "steps" block, not a wall of lines.
function blocks(items: readonly ChatItem[]): Block[] {
  const out: Block[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (item.kind === "activity") {
      if (last?.kind === "steps") {
        last.steps.push(item);
      } else {
        out.push({ id: item.id, kind: "steps", steps: [item] });
      }
    } else {
      out.push({ item, kind: "item" });
    }
  }
  return out;
}

// ponytail: a block count, not pixels; tall pages just start loading a bit earlier.
const PREFETCH_BLOCKS = 40;
const blockId = (block: Block) =>
  block.kind === "steps" ? block.id : block.item.id;

export function MessageList({
  slug,
  items,
  pending,
  working = false,
  onOpenThread,
  onTakeControl,
  onAnswerInteraction,
  mcpContext,
  loginControlOpen = false,
  onConfigureBot,
  onRetryPending,
  onLoadEarlier,
  hasEarlier = false,
  earlierLoading = false,
  earlierError = false,
  wait,
  botName,
  status,
}: {
  slug: string;
  items: readonly ChatItem[];
  pending: readonly Pending[];
  /** A turn is running (not a message still on its way). */
  working?: boolean;
  onOpenThread?: (consultationId: string) => void;
  onTakeControl?: () => void;
  onAnswerInteraction?: AnswerInteraction;
  mcpContext?: string;
  loginControlOpen?: boolean;
  onConfigureBot?: () => void;
  onRetryPending?: (id: string) => void;
  onLoadEarlier?: () => void;
  hasEarlier?: boolean;
  earlierLoading?: boolean;
  earlierError?: boolean;
  /** The main chat's wait before the reply shows; without it the status says Working. */
  wait?: { id: string; stage: WaitStage } | null;
  botName?: string;
  status?: string | null;
}) {
  const all = blocks(items);
  const scroller = useContext(ChatScrollContext);
  const virtualizer = useRef<VirtualizerHandle>(null);
  const list = useRef<HTMLDivElement>(null);
  // The list starts below the scroller's padding and anything shown above it.
  // ponytail: measured once; a few px off only shifts virtua's 200px render buffer.
  const [startMargin, setStartMargin] = useState(0);
  useLayoutEffect(() => {
    const element = list.current;
    const root = scroller?.current;
    if (element && root) {
      setStartMargin(
        Math.round(
          element.getBoundingClientRect().top -
            root.getBoundingClientRect().top +
            root.scrollTop
        )
      );
    }
  }, [scroller]);
  // Earlier messages land above the reader. For that one render the virtualizer keeps the
  // distance to the end, so what the reader is looking at stays where it is.
  // It holds until the list changes again. A page can also complete the group of steps
  // that was first, so "earlier" means: the start changed and the end did not.
  const firstId = all[0] ? blockId(all[0]) : null;
  const lastBlock = all.at(-1);
  const lastId = lastBlock ? blockId(lastBlock) : null;
  const [front, setFront] = useState({
    count: all.length,
    first: firstId,
    last: lastId,
    shift: false,
  });
  if (
    front.first !== firstId ||
    front.last !== lastId ||
    front.count !== all.length
  ) {
    setFront({
      count: all.length,
      first: firstId,
      last: lastId,
      shift: front.first !== firstId && front.last === lastId,
    });
  }
  const canLoad = hasEarlier && !earlierLoading && !earlierError;
  // Pages are asked for while the reader is still well below the top, so they are
  // there before the reader gets there. A reader who waits at the top, or a chat too
  // short to scroll, keeps paging as each page lands.
  const loadIfNearTop = useCallback(() => {
    const handle = virtualizer.current;
    if (
      canLoad &&
      handle &&
      handle.findItemIndex(handle.scrollOffset) < PREFETCH_BLOCKS
    ) {
      onLoadEarlier?.();
    }
  }, [canLoad, onLoadEarlier]);
  useEffect(() => loadIfNearTop(), [loadIfNearTop]);
  const [deliveries, setDeliveries] = useState<DeliveryState>(() => ({
    keys: initialPendingKeys(pending),
    pending,
  }));
  // Keep the optimistic key when the server assigns a delivery id. This avoids an exit and a
  // second entrance if the delivery acknowledgement arrives before the persisted user row.
  const nextDeliveries = reconcileDeliveries(deliveries, pending, items);
  if (nextDeliveries) {
    setDeliveries(nextDeliveries);
  }
  const last = all.at(-1);
  const sending = pendingToSend(pending, items);
  // A message on its way is work too: the turn it starts just hasn't shown up yet.
  const busy = working || sending.some((p) => !p.failed);
  const waitingForInput = isWaitingForInput(items);
  const waitingActivities = waitingActivityIds(items);
  // While it thinks between steps nothing else moves: say it's working, unless a running step or
  // the reply being written already shows it, or it's waiting on the user's login rather than working.
  const showsWork = hasVisibleWork(last);
  // The text each turn ended on can be copied; the turn still being worked on has no last text yet.
  const copyable = copyableItemIds(all, working);
  const keys = all.map((block) => messageBlockKey(block, deliveries.keys));
  // What was on screen once never animates again, also when the virtualizer remounts it,
  // and neither do earlier pages: only what arrives after the newest seen message does.
  const [seen] = useState(
    () => new Set([...keys, ...pending.map((p) => p.id)])
  );
  useEffect(() => {
    for (const key of keys) {
      seen.add(key);
    }
    for (const p of sending) {
      seen.add(p.id);
    }
  });
  const newestSeen = keys.findLastIndex((key) => seen.has(key));
  const rows = all.map((block, index) =>
    renderMessageBlock({
      animate: index > newestSeen && !seen.has(keys[index] ?? ""),
      block,
      copyable,
      deliveryKey: keys[index] ?? blockId(block),
      loginControlOpen,
      mcpContext,
      onAnswerInteraction,
      onConfigureBot,
      onOpenThread,
      onTakeControl,
      slug,
      waitingActivities,
    })
  );
  // A question waiting on the reader, and the newest message, keep their state off screen.
  const keepMounted = all.flatMap((block, index) =>
    block.kind === "item" && isAwaitingInput(block.item) ? [index] : []
  );
  for (const p of sending) {
    rows.push(
      <MessageEntry animate={!seen.has(p.id)} key={p.id}>
        <PendingMessage
          onConfigureBot={onConfigureBot}
          onRetry={onRetryPending}
          pending={p}
        />
      </MessageEntry>
    );
  }
  if (waitingForInput || (busy && !showsWork)) {
    rows.push(
      <MessageEntry animate={false} key="working-status">
        <ChatActivityStatus
          botName={botName}
          status={status}
          waitId={wait?.id}
          waitingForInput={waitingForInput}
          waitStage={wait?.stage}
        />
      </MessageEntry>
    );
  }
  if (rows.length) {
    keepMounted.push(rows.length - 1);
  }
  return (
    <div ref={list}>
      {hasEarlier ? (
        // Takes no room, so showing or hiding it never moves the messages. Only a reader at the top sees it.
        <div className="relative z-10 h-0" data-chat-earlier="">
          <div className="text-muted-foreground absolute inset-x-0 -top-5 flex justify-center text-[13px]">
            {earlierLoading ? (
              <Loader2
                aria-label="Loading earlier messages"
                className="size-4 animate-spin"
              />
            ) : null}
            {earlierError ? (
              <span
                className="bg-background flex items-center gap-1 rounded-md px-2"
                role="status"
              >
                Couldn&apos;t load earlier messages.
                <Button onClick={onLoadEarlier} size="sm" variant="ghost">
                  Retry
                </Button>
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      {scroller ? (
        <Virtualizer
          as="ol"
          item={VirtualRow}
          keepMounted={keepMounted}
          onScroll={loadIfNearTop}
          ref={virtualizer}
          scrollRef={scroller}
          shift={front.shift}
          startMargin={startMargin}
        >
          {rows}
        </Virtualizer>
      ) : (
        <ol className="flex flex-col gap-5">
          {Children.map(rows, (row) => (
            <li>{row}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** The chat pane's scroller. Lists inside it are virtualized; lists elsewhere render whole. */
export const ChatScrollContext =
  createContext<RefObject<HTMLElement | null> | null>(null);

function VirtualRow({ children, ref, style }: CustomItemComponentProps) {
  return (
    <li className="pb-5" ref={ref} style={style}>
      {children}
    </li>
  );
}

function MessageEntry({
  animate,
  children,
  className,
  ...props
}: ComponentProps<"div"> & { animate: boolean }) {
  // Only the first render decides: an entrance plays once, to its end.
  const [enter, setEnter] = useState(animate);
  const finish = useCallback((event: AnimationEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      setEnter(false);
    }
  }, []);
  return (
    <div
      {...props}
      className={cn(className, enter && styles.enter)}
      onAnimationEnd={enter ? finish : undefined}
      style={{ opacity: 1, transform: "none" }}
    >
      {children}
    </div>
  );
}

const WAKE_AFTER_MS = 1000;

const ChatActivityStatus = memo(function ActivityStatusLine({
  waitingForInput,
  waitStage,
  waitId,
  botName,
  status,
}: {
  waitingForInput: boolean;
  waitStage?: WaitStage;
  waitId?: string;
  botName?: string;
  /** What the bot said it is about to do (the fast path's escalation), shown instead of a stage. */
  status?: string | null;
}) {
  // One timer per message, not per event: past it, a message the bot hasn't admitted is waiting on
  // the bot to start (its function or computer), which is the slow part of a cold first reply.
  // Only once the hub handed it over: while "sending", the hub itself (the fast path) is answering.
  const [lateFor, setLateFor] = useState<string | null>(null);
  const waking = waitStage === "received";
  useEffect(() => {
    if (!(waking && waitId)) {
      return;
    }
    const timer = setTimeout(() => setLateFor(waitId), WAKE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [waking, waitId]);
  let text = "Working…";
  if (waitingForInput) {
    text = "Waiting for you…";
  } else if (status) {
    text = `${status}…`;
  } else if (waking && lateFor === waitId) {
    text = `Waking up ${botName ?? "the bot"}…`;
  } else if (waitStage) {
    // Delivery stays behind the scenes: once sent, the message reads as sent.
    text = "Thinking…";
  }
  return (
    <p className="text-muted-foreground text-[15px] leading-7" role="status">
      <span className={waitingForInput ? undefined : "text-shimmer"}>
        {text}
      </span>
    </p>
  );
});

function pendingToSend(
  pending: readonly Pending[],
  items: readonly ChatItem[]
): Pending[] {
  return pending.filter(
    (p) => !items.some((i) => i.kind === "user" && i.id === p.deliveryId)
  );
}

function PendingMessage({
  pending,
  onConfigureBot,
  onRetry,
}: {
  pending: Pending;
  onConfigureBot?: () => void;
  onRetry?: (id: string) => void;
}) {
  const retry = useCallback(() => {
    if (onRetry === undefined) {
      return;
    }
    onRetry(pending.id);
  }, [onRetry, pending.id]);
  const canRetry =
    !pending.issue ||
    pending.issue.retryable ||
    pending.issue.code === "unauthorized" ||
    pending.issue.code === "connection_not_connected";
  return (
    <>
      <UserBubble
        error={pending.issue ? undefined : pending.error}
        files={pending.files}
        hideError={Boolean(pending.issue)}
        state={pending.failed ? "failed" : undefined}
        text={pending.text}
      />
      {pending.failed && pending.issue ? (
        <AiIssueNotice issue={pending.issue} onConfigureBot={onConfigureBot} />
      ) : null}
      {pending.failed && onRetry && canRetry ? (
        <Button
          className="mt-2 ml-auto flex"
          onClick={retry}
          size="sm"
          type="button"
          variant="outline"
        >
          Retry message
        </Button>
      ) : null}
    </>
  );
}

function hasVisibleWork(block: Block | undefined): boolean {
  if (block?.kind === "steps") {
    return block.steps.some((step) => step.state === "running");
  }
  if (block?.kind !== "item") {
    return false;
  }
  if (block.item.kind === "bot") {
    return block.item.streaming;
  }
  return block.item.kind === "login" && block.item.state === "open";
}

function copyableItemIds(
  blocksToInspect: readonly Block[],
  working: boolean
): Set<string> {
  const copyable = new Set<string>();
  let ended = !working;
  for (const block of blocksToInspect.toReversed()) {
    if (block.kind !== "item") {
      continue;
    }
    if (block.item.kind === "user") {
      ended = true;
    } else if (ended && block.item.kind === "bot") {
      copyable.add(block.item.id);
      ended = false;
    }
  }
  return copyable;
}

function messageBlockKey(
  block: Block,
  deliveryKeys: ReadonlyMap<string, string>
): string {
  if (block.kind === "steps") {
    return block.id;
  }
  return deliveryKeys.get(block.item.id) ?? block.item.id;
}

function renderMessageBlock({
  block,
  copyable,
  deliveryKey,
  loginControlOpen,
  onConfigureBot,
  onOpenThread,
  onTakeControl,
  onAnswerInteraction,
  mcpContext,
  animate,
  slug,
  waitingActivities,
}: {
  block: Block;
  copyable: ReadonlySet<string>;
  deliveryKey: string;
  loginControlOpen: boolean;
  onConfigureBot?: () => void;
  onOpenThread?: (consultationId: string) => void;
  onTakeControl?: () => void;
  onAnswerInteraction?: AnswerInteraction;
  mcpContext?: string;
  animate: boolean;
  slug: string;
  waitingActivities: ReadonlySet<string>;
}) {
  if (block.kind === "steps") {
    return (
      <MessageEntry animate={animate} data-chat-block="" key={deliveryKey}>
        <Steps steps={block.steps} waitingActivities={waitingActivities} />
      </MessageEntry>
    );
  }
  return (
    <MessageEntry animate={animate} data-chat-block="" key={deliveryKey}>
      <Item
        copyable={copyable.has(block.item.id)}
        item={block.item}
        loginControlOpen={loginControlOpen}
        mcpContext={mcpContext}
        onAnswerInteraction={onAnswerInteraction}
        onConfigureBot={onConfigureBot}
        onOpenThread={onOpenThread}
        onTakeControl={onTakeControl}
        slug={slug}
      />
    </MessageEntry>
  );
}

const Item = memo(function MessageItem({
  slug,
  item,
  copyable = false,
  onOpenThread,
  onTakeControl,
  onAnswerInteraction,
  mcpContext,
  loginControlOpen,
  onConfigureBot,
}: {
  slug: string;
  item: Exclude<ChatItem, Activity>;
  copyable?: boolean;
  onOpenThread?: (id: string) => void;
  onTakeControl?: () => void;
  onAnswerInteraction?: AnswerInteraction;
  mcpContext?: string;
  loginControlOpen?: boolean;
  onConfigureBot?: () => void;
}) {
  switch (item.kind) {
    case "user":
      return (
        <UserBubble
          files={item.files}
          reaction={item.reaction}
          routineName={item.routineName}
          text={item.text}
        />
      );
    case "bot":
      return (
        <>
          <div className="prose-chat text-[15px] leading-7">
            <MessageMarkdown
              prepared={item.markdown}
              streaming={item.streaming}
              text={item.text}
            />
          </div>
          {copyable ? <CopyButton text={item.text} /> : null}
        </>
      );
    case "file":
      return (
        <FileCard
          contentType={item.contentType}
          fileId={item.fileId}
          name={item.name}
          size={item.size}
        />
      );
    case "interaction":
      return (
        <InteractionCard
          item={item}
          onAnswer={onAnswerInteraction}
          slug={slug}
        />
      );
    case "code-task":
      return <InlineCodeTaskCard slug={slug} taskId={item.taskId} />;
    case "plan":
      return <PlanCard paused={item.paused} plan={item.plan} />;
    case "consult":
      return <ConsultDivider item={item} onOpen={onOpenThread} slug={slug} />;
    case "login":
      return (
        <LoginCard
          controlOpen={loginControlOpen}
          item={item}
          onAnswerInteraction={onAnswerInteraction}
          onTakeControl={onTakeControl}
          slug={slug}
        />
      );
    case "mcp-app":
      return (
        <McpAppHost
          callId={item.callId}
          context={mcpContext}
          slug={slug}
          toolName={item.toolName}
        />
      );
    case "error":
      if (item.issue) {
        return (
          <AiIssueNotice issue={item.issue} onConfigureBot={onConfigureBot} />
        );
      }
      return (
        <div
          className="text-destructive flex items-start gap-2 text-sm"
          role="alert"
        >
          <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <div className="flex min-w-0 flex-col gap-1">
            <p>{item.text}</p>
            {item.detail ? (
              <details className="text-muted-foreground text-xs">
                <summary className="cursor-pointer select-none">
                  Details
                </summary>
                <p className="mt-1 font-mono break-words whitespace-pre-wrap">
                  {item.detail}
                </p>
              </details>
            ) : null}
          </div>
        </div>
      );
    case "stopped":
      return <p className="text-muted-foreground text-sm">Stopped.</p>;
    default:
      return null;
  }
});

// ponytail: copies the markdown as written, like ai-elements; rich HTML for Word/Gmail if users ask.
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  }, [text]);
  return (
    <button
      aria-label={copied ? "Copied" : "Copy reply"}
      className="text-muted-foreground hover:bg-accent hover:text-foreground mt-1 -ml-1.5 grid size-7 place-items-center rounded-md transition-colors"
      onClick={handleCopy}
      type="button"
    >
      {copied ? (
        <Check aria-hidden="true" className="size-3.5" />
      ) : (
        <Copy aria-hidden="true" className="size-3.5" />
      )}
    </button>
  );
}

function UserBubble({
  text,
  files,
  state,
  routineName,
  reaction,
  error,
  hideError,
}: {
  text: string;
  files: string[];
  state?: "failed";
  routineName?: string;
  reaction?: string;
  error?: string;
  hideError?: boolean;
}) {
  return (
    <div className="ml-auto flex max-w-[80%] flex-col items-end gap-1.5">
      {routineName ? (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Clock3 aria-hidden="true" className="size-3.5" />
          Routine · {routineName}
        </p>
      ) : null}
      {files.length ? (
        <ul className="flex flex-wrap justify-end gap-1.5">
          {files.map((f) => (
            <li
              className="bg-secondary text-muted-foreground flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px]"
              key={f}
            >
              <Paperclip aria-hidden="true" className="size-3.5" />
              {f}
            </li>
          ))}
        </ul>
      ) : null}
      {text ? (
        <p className="bg-secondary rounded-2xl px-4 py-2.5 text-[15px] leading-6 whitespace-pre-wrap">
          {text}
        </p>
      ) : null}
      {reaction ? (
        <span
          aria-label={`The bot reacted ${reaction}`}
          className="bg-background -mt-3 mr-2 rounded-full border px-1.5 text-sm leading-6 shadow-xs"
          role="img"
        >
          {reaction}
        </span>
      ) : null}
      {state === "failed" && !hideError ? (
        <p className="text-destructive text-[13px]" role="alert">
          {error ??
            "Busy couldn't confirm delivery. Check the chat before retrying."}
        </p>
      ) : null}
    </div>
  );
}

const TOOL_LABELS: Record<string, string> = {
  bash: "Terminal",
  cancel_code_task: "Requested a task stop",
  get_code_task: "Checked a coding task",
  glob: "Searched for files",
  grep: "Searched in files",
  memoria__remove_memory: "Deleted a memory",
  // The memory tools' names before the bot spoke English: old events are stored in the DB.
  memoria__save_memory: "Saved a memory",
  memory__remove_memory: "Deleted a memory",
  memory__save_memory: "Saved a memory",
  prepare_code_repository: "Set up GitHub",
  propose_skill: "Offered to save a skill",
  read_file: "Read a file",
  start_code_task: "Started a coding task",
  update_code_task: "Updated a coding task",
  web_fetch: "Read a web page",
  web_search: "Searched the web",
  write_file: "Wrote a file",
};
const label = (tool: string) => TOOL_LABELS[tool] ?? tool;

// One line, cut at the edge; the whole command on hover.
const Detail = ({ text }: { text: string }) => (
  <span className="min-w-0 truncate font-mono text-xs opacity-70" title={text}>
    {text}
  </span>
);

function taskLabel(task: Activity): string {
  if (task.tool === "agent") {
    return "Background work";
  }
  return `${task.taskKind === "agent" ? "Agent" : "Background work"}: ${task.tool}`;
}

function stepSummary(
  steps: Activity[],
  running: Activity | undefined
): React.ReactNode {
  let task: Activity | undefined;
  if (running?.taskId) {
    task = running;
  } else if (!running) {
    task = steps.findLast((s) => s.taskId);
  }
  const end = steps.at(-1)?.state;
  if (running) {
    return (
      <>
        {task ? taskLabel(task) : label(running.tool)}
        {running.detail ? <Detail text={running.detail} /> : null}
      </>
    );
  }
  if (task) {
    let endLabel = "complete";
    if (end === "error") {
      endLabel = "failed";
    } else if (end === "stopped") {
      endLabel = "stopped";
    }
    return `${taskLabel(task)} ${endLabel}`;
  }
  const countLabel = steps.length === 1 ? "step" : "steps";
  let suffix = "";
  if (end === "error") {
    suffix = ", the last one failed";
  } else if (end === "stopped") {
    suffix = ", stopped";
  }
  return `${steps.length} ${countLabel} on its computer${suffix}`;
}

function Steps({
  steps,
  waitingActivities,
}: {
  steps: Activity[];
  waitingActivities: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const running = steps.find(
    (s) => s.state === "running" && !waitingActivities.has(s.id)
  );
  const waiting = steps.find(
    (s) => s.state === "running" && waitingActivities.has(s.id)
  );
  // A failed step followed by more work is one the bot got past (a photo too big to read, resized and
  // read again): only a failure it ended on is an error.
  const summary = stepSummary(steps, running ?? waiting);
  let indicator = (
    <ChevronRight
      aria-hidden="true"
      className={cn("size-4 transition-transform", open && "rotate-90")}
    />
  );
  if (running) {
    indicator = <Loader2 aria-hidden="true" className="size-4 animate-spin" />;
  } else if (waiting) {
    indicator = <Clock3 aria-hidden="true" className="size-4" />;
  }
  return (
    <div className="text-muted-foreground text-[15px] leading-7">
      <button
        aria-expanded={open}
        className="hover:text-foreground flex max-w-full min-w-0 items-center gap-2 rounded-sm transition-colors"
        onClick={toggle}
        type="button"
      >
        {indicator}
        <span
          className={cn(
            "flex min-w-0 items-baseline gap-1.5",
            running && "text-shimmer"
          )}
        >
          {summary}
        </span>
      </button>
      {open ? (
        <ul
          className={cn(
            "border-border mt-2 flex flex-col gap-1 overflow-hidden border-l pl-4",
            styles.steps
          )}
        >
          {steps.map((s, i) => {
            const last = i === steps.length - 1;
            return (
              <li
                className={cn(
                  "flex min-w-0 items-baseline gap-1.5",
                  s.state === "error" && last && "text-destructive"
                )}
                key={s.id}
              >
                <span className="shrink-0">{label(s.tool)}</span>{" "}
                {s.detail ? (
                  <Detail text={s.detail} />
                ) : (
                  <span className="font-mono text-xs opacity-70">{s.tool}</span>
                )}
                {s.state === "error" || s.state === "stopped" ? (
                  <span className="shrink-0">
                    {` ${stepStatusLabel(s.state, last)}`}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function stepStatusLabel(state: Activity["state"], isLast: boolean): string {
  if (state === "stopped") {
    return "stopped";
  }
  return isLast ? "failed" : "failed, kept going";
}

function loginClosedText(item: Extract<ChatItem, { kind: "login" }>) {
  if (item.state !== "done") {
    return "No longer needed.";
  }
  return item.form
    ? "Sent. It goes on from there."
    : "You logged in. It goes on from there.";
}

/** The bot stopped at a login: the user logs in on its screen, then tells it to go on. */
function LoginCard({
  slug,
  item,
  onTakeControl,
  onAnswerInteraction,
  controlOpen = false,
}: {
  slug: string;
  item: Extract<ChatItem, { kind: "login" }>;
  onTakeControl?: () => void;
  onAnswerInteraction?: AnswerInteraction;
  controlOpen?: boolean;
}) {
  const store = useStore();
  // The form fills through the bot's own chat session; a fireside answers elsewhere, so it falls
  // back to the plain login (take control, type it, Done).
  const form = onAnswerInteraction ? undefined : item.form;
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const done = useCallback(async () => {
    setSending(true);
    setFailed(false);
    const ok = await (onAnswerInteraction
      ? onAnswerInteraction(item.interactionId, { optionId: "done" })
      : store.answer(slug, item.interactionId, "done"));
    // On success the card stays busy until the question settles and turns it to "done".
    if (!ok) {
      setSending(false);
      setFailed(true);
    }
  }, [item.interactionId, slug, store, onAnswerInteraction]);
  return (
    <div className="border-border flex w-full max-w-md flex-col gap-3 rounded-lg border px-4 py-3">
      <p className="flex items-start gap-2.5 text-[15px] leading-6">
        <KeyRound
          aria-hidden="true"
          className="text-muted-foreground mt-1 size-4 shrink-0"
        />
        {item.text}
      </p>
      {item.state === "open" && form ? (
        <FormCard
          fields={form.fields}
          interactionId={item.interactionId}
          onTakeControl={onTakeControl}
          slug={slug}
        />
      ) : null}
      {item.state === "open" && !form ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={onTakeControl} variant="outline">
            <MousePointer2 aria-hidden="true" />
            Take control
          </Button>
          <Button disabled={sending || controlOpen} onClick={done}>
            {sending ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <Check aria-hidden="true" />
            )}
            Done
          </Button>
        </div>
      ) : null}
      {item.state === "open" ? null : (
        <p className="text-muted-foreground flex items-center gap-1.5 text-[13px]">
          {item.state === "done" ? (
            <Check aria-hidden="true" className="size-3.5" />
          ) : null}
          {loginClosedText(item)}
        </p>
      )}
      {item.state === "open" && controlOpen ? (
        <p className="text-muted-foreground text-[13px]">
          Use “Done logging in” in Live to release control first.
        </p>
      ) : null}
      {failed ? (
        <p className="text-destructive text-[13px]" role="alert">
          {"Couldn't let it know. Try again."}
        </p>
      ) : null}
    </div>
  );
}

function ConsultDivider({
  slug,
  item,
  onOpen,
}: {
  slug: string;
  item: Extract<ChatItem, { kind: "consult" }>;
  onOpen?: (id: string) => void;
}) {
  const peer = useChat(
    (s) => Object.values(s.bots).find((b) => b.bot.name === item.peerName)?.bot
  );
  const { consultationId } = item;
  const handleOpen = useCallback(() => {
    if (consultationId && onOpen) {
      onOpen(consultationId);
    }
  }, [consultationId, onOpen]);
  const content = (
    <>
      {item.direction === "to" ? "Wrote to" : "Message from"}
      <BotAvatar
        avatar={peer?.avatar}
        size={16}
        slug={peer?.slug ?? item.peerName}
      />
      <span className="text-foreground/80">{item.peerName}</span>
    </>
  );
  return (
    <div className="flex justify-center" data-from={slug}>
      {consultationId && onOpen ? (
        <button
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] transition-colors"
          onClick={handleOpen}
          type="button"
        >
          {content}
        </button>
      ) : (
        <p className="text-muted-foreground flex items-center gap-1.5 px-2 py-1 text-[13px]">
          {content}
        </p>
      )}
    </div>
  );
}
