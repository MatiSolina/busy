// eve stream facts → what the chat shows. Pure, shared by the app and its tests.

import {
  parseTaskPlan,
  type TaskPlan,
} from "../../../../templates/bot/agent/lib/task-plan";
import type { Billing } from "../bots/models";
import { mcpAppSnapshotId } from "../mcp/tool-ui";
import {
  type AiIssue,
  aiIssueFromEvent,
  aiIssueText,
  hasAiIssueSignal,
} from "./model-errors";
import { parseQuickReplies } from "./quick-replies";
import { parseReaction, REACT_TOOL } from "./reactions";

const MCP_CONNECTION_TOOL_PREFIX = /^mcp[-_]/u;

export const FORM_FIELD_KINDS = [
  "text",
  "email",
  "password",
  "otp",
  "tel",
  "card-number",
  "card-expiry",
  "card-cvc",
  "address",
] as const;
export type FormFieldKind = (typeof FORM_FIELD_KINDS)[number];
/** One field of request_form: what the card asks for and where the hub types it. Never a value. */
export interface FormField {
  id: string;
  kind: FormFieldKind;
  label: string;
  target: string;
}

/** request_form's fields from its call input; anything malformed is dropped. */
export function formFieldsOf(input: unknown): FormField[] {
  const fields = (input as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) {
    return [];
  }
  return fields.flatMap((f) => {
    const { id, label, kind, target } = (f ?? {}) as Record<string, unknown>;
    return typeof id === "string" &&
      typeof label === "string" &&
      typeof target === "string" &&
      FORM_FIELD_KINDS.includes(kind as FormFieldKind)
      ? [{ id, kind: kind as FormFieldKind, label, target }]
      : [];
  });
}

export interface Fact {
  data: Record<string, unknown>;
  scope?: Record<string, unknown>;
  type: string;
}
export interface ClientRow {
  data: Fact;
  index: number;
  line: number;
  /**
   * Prepared Markdown (markdown-transport), decoded against `data.data.value`.
   * Renamed from `markdown` when the format changed: clients from an older
   * deploy ignore it and use the Markdown worker instead of misreading it.
   */
  md?: string;
  type: string;
}

export type ChatItem =
  | {
      kind: "user";
      id: string;
      text: string;
      files: string[];
      routineName?: string;
      /** The bot's emoji on this message (its react tool). */
      reaction?: string;
    }
  | {
      kind: "bot";
      id: string;
      text: string;
      streaming: boolean;
      markdown?: string;
    }
  | { kind: "code-task"; id: string; taskId: string }
  | { kind: "plan"; id: string; plan: TaskPlan; paused?: boolean }
  | { kind: "mcp-app"; id: string; callId: string; toolName: string }
  | {
      kind: "activity";
      id: string;
      tool: string;
      state: "running" | "done" | "error" | "stopped";
      detail?: string;
      taskId?: string;
      taskKind?: "agent" | "tool" | string;
      error?: string;
    }
  | {
      kind: "file";
      id: string;
      fileId: string;
      name: string;
      contentType: string;
      size: number;
    }
  | {
      kind: "consult";
      id: string;
      direction: "to" | "from";
      peerName: string;
      consultationId: string | null;
    }
  // The bot paused on a login (its request_login tool): open until the user answers Done or the call ends.
  // request_form adds `form`: fields the user types into the card, which the hub fills on the page.
  | {
      kind: "login";
      id: string;
      text: string;
      interactionId: string;
      state: "open" | "done" | "closed";
      form?: { fields: readonly FormField[] };
    }
  | {
      kind: "interaction";
      id: string;
      interactionId: string;
      type: "question" | "approval";
      prompt: string;
      options: readonly {
        id: string;
        label: string;
        style?: "primary" | "danger" | "secondary";
      }[];
      allowFreeform: boolean;
      /** The displayed call or task paused on this interaction. */
      activityId?: string;
      setup?: "code-repository";
      link?: { url: string; label?: string };
      origin?: {
        sessionId: string;
        interactionId: string;
        callId?: string;
        callName?: string;
      };
      state?:
        | "open"
        | "accepted"
        | "answered"
        | "rejected"
        | "withdrawn"
        | "closed"
        | "failed";
      outcome?: string;
      error?: string;
      pending?: boolean;
    }
  /** `detail`: the provider's raw message, behind a disclosure for whoever debugs it. */
  | {
      kind: "error";
      id: string;
      text: string;
      detail?: string;
      issue?: AiIssue;
    }
  // The user tapped Stop: the reply above ends where it was cut.
  | { kind: "stopped"; id: string };

export interface ChatView {
  items: ChatItem[];
  /** The one-tap answers the bot offered at the end of its last turn (its suggest_replies tool). */
  replies: string[];
  turnId: string | null;
  working: boolean;
}

/** Presentation only: an open turn still needs its stream and Stop control. */
export function isWaitingForInput(items: readonly ChatItem[]): boolean {
  return items.some(isAwaitingInput);
}

export function isAwaitingInput(item: ChatItem): boolean {
  if (item.kind === "login") {
    return item.state === "open";
  }
  return (
    item.kind === "interaction" &&
    (item.state ?? "open") === "open" &&
    !item.pending
  );
}

/** Pause only the activity that owns a prompt; other tasks can keep running. */
export function waitingActivityIds(
  items: readonly ChatItem[]
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (!isAwaitingInput(item)) {
      continue;
    }
    if (item.kind === "login") {
      ids.add(item.id);
    } else if (item.kind === "interaction" && item.activityId) {
      ids.add(item.activityId);
    }
  }
  return ids;
}

const PEER = /^peer-\d+$/u;
const CODE_TASK_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// Plumbing the user doesn't need to see.
const HIDDEN_TOOLS = new Set([
  "eve__task_wait",
  "eve__skill",
  "eve__search",
  "eve__tool",
]);
const CANCEL_REASON = /cancel/iu;

interface Part {
  filename?: string;
  kind?: string;
  name?: string;
  text?: string;
}

// What a step acted on, shown next to its name: the command it ran, the file, the pattern, the page.
const detailOf = (input: unknown) => {
  const i = (input ?? {}) as Record<string, unknown>;
  const v = i.command ?? i.filePath ?? i.pattern ?? i.url ?? i.query;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

function taskIdFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const { taskId } = input as { taskId?: unknown };
  return typeof taskId === "string" ? taskId : undefined;
}

/**
 * The hub's hidden first message when the live screen finds no computer yet (app/api/bots/[slug]/live):
 * the bot boots its computer and answers "ok". The chat never shows that turn.
 */
export const WAKE_MESSAGE = "<wake_computer/>";
/** What WAKE_MESSAGE was before the hub spoke English: old turns stored in the DB still carry it. */
const LEGACY_WAKE_MESSAGE = "<encender_computadora/>";
const WAKE_MESSAGES = new Set([WAKE_MESSAGE, LEGACY_WAKE_MESSAGE]);

/** The history the hub seeds into a replacement session (send.ts), under its current or legacy tag. */
const SEEDED_HISTORY =
  /^<(?<historyTag>prior_history|historial_previo)>[\s\S]*?<\/(?<closingHistoryTag>\k<historyTag>)>\n*/u;

// Routine instructions are transport metadata for the bot, not text the user wrote. Keep this
// anchored after seeded history so an ordinary message containing similar strings is untouched.
const ROUTINE_ENVELOPE =
  /^<routine_execution>\r?\nScheduled task: (?<routineName>[^\r\n]+)\r?\nScheduled for:[^\r\n]*\r?\n[\s\S]*?\r?\n<\/routine_execution>(?:\r?\n)*/u;

function visibleDeliveryText(raw: string): {
  text: string;
  routineName?: string;
} {
  const text = raw.replace(SEEDED_HISTORY, "");
  // The completion service queues this transport message under its own principal;
  // its answer is visible in the code-task widget, not as a user-authored message.
  if (text.startsWith("<code_task_result>\n")) {
    return { text: "" };
  }
  const routine = ROUTINE_ENVELOPE.exec(text);
  if (!routine) {
    return { text };
  }
  return {
    routineName: routine.groups?.routineName?.trim(),
    text: text.slice(routine[0].length),
  };
}

function hasTurnError(
  items: readonly ChatItem[],
  turnId: string | null
): boolean {
  return items.some(
    (item) => item.kind === "error" && item.id.startsWith(`${turnId}:`)
  );
}

/** The bot's tool that hands the user a file, and its legacy name (old events are stored in the DB). */
const FILE_TOOLS = new Set(["send_file", "enviar_archivo"]);
const QUICK_REPLIES_TOOL = "suggest_replies";

function safeLink(value: unknown): { url: string; label?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const link = value as { url?: unknown; label?: unknown };
  if (typeof link.url !== "string") {
    return undefined;
  }
  try {
    const url = new URL(link.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return undefined;
    }
    return {
      url: url.href,
      ...(typeof link.label === "string" && link.label
        ? { label: link.label }
        : {}),
    };
  } catch {
    return undefined;
  }
}

// The reducer intentionally keeps the full eve protocol state machine in one pass so stored rows,
// streaming deltas, and task lifecycles stay ordered. The row snapshot and delta overlay are split
// only after that pass, so the overlay never has to reconstruct protocol state.
export interface ChatViewProjector {
  project: (deltas: ReadonlyMap<string, string>) => ChatView;
}

export function toChatView(
  rows: readonly ClientRow[],
  deltas: ReadonlyMap<string, string>,
  consults: ReadonlyMap<string, { id: string; peerName: string }>,
  // Same order as the bot's directory, so a slot names its peer before the hub records the consultation.
  slotPeer: (slot: number) => string | undefined = () => undefined,
  provider?: Billing
): ChatView {
  return createChatViewProjector(rows, consults, slotPeer, provider).project(
    deltas
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: protocol reducer must preserve event order
export function createChatViewProjector(
  rows: readonly ClientRow[],
  consults: ReadonlyMap<string, { id: string; peerName: string }>,
  // Same order as the bot's directory, so a slot names its peer before the hub records the consultation.
  slotPeer: (slot: number) => string | undefined = () => undefined,
  provider?: Billing
): ChatViewProjector {
  const items: ChatItem[] = [];
  const byId = new Map<string, number>();
  const completedParts = new Set<string>();
  const logins = new Set<string>();
  const forms = new Map<string, FormField[]>();
  const taskIndexes = new Map<string, number>();
  const taskCalls = new Map<string, string>();
  const taskActiveCalls = new Map<string, Set<string>>();
  // `task.ended` is the authoritative terminal fact for delegated work. Eve can
  // emit it after the last `call.settled`, and a late/replayed call must not
  // move the task back to running or replace its terminal outcome.
  const terminalTasks = new Set<string>();
  const mcpCalls = new Map<string, string>();
  const interactionIndexes = new Map<string, number>();
  const responseInteractions = new Map<string, string>();
  const suggestedReplyTurns = new Set<string>();
  const narrations = new Map<string, Array<{ id: string; text: string }>>();
  const suppressedNarrations = new Set<string>();
  const codeTaskIds = new Set<string>();
  const planCalls = new Set<string>();
  const planIndexes = new Map<string, number>();
  const hiddenPlanCalls = new Set<string>();
  const seen = new Set<string>();
  let working = false;
  let turnId: string | null = null;
  let waking = false;
  let replies: string[] = [];

  const push = (item: ChatItem, allowDuringWake = false) => {
    if (waking && !allowDuringWake) {
      return;
    }
    byId.set(item.id, items.length);
    items.push(item);
  };
  const replace = (index: number, item: ChatItem) => {
    if (!waking) {
      items[index] = item;
    }
  };
  const peerOf = (callId: string) => consults.get(callId);
  const nameOf = (callId: string, name: string) =>
    peerOf(callId)?.peerName ??
    slotPeer(Number(name.slice(5))) ??
    "another bot";
  const turnKeyOf = (row: ClientRow) => {
    const scoped = row.data.scope?.turnId;
    return typeof scoped === "string" && scoped ? scoped : turnId || null;
  };
  const suppressProvisionalNarration = (row: ClientRow, text: string) => {
    const turnKey = turnKeyOf(row);
    if (!(turnKey && suggestedReplyTurns.has(turnKey))) {
      return;
    }
    const entries = narrations.get(turnKey);
    if (!entries) {
      return;
    }
    let atEntry = -1;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i]?.text === text) {
        atEntry = i;
        break;
      }
    }
    if (atEntry < 0) {
      return;
    }
    suppressedNarrations.add(entries[atEntry].id);
    entries.splice(atEntry, 1);
  };

  const sorted = rows.toSorted((a, b) => a.line - b.line || a.index - b.index);
  for (const row of sorted) {
    const key = `${row.line}:${row.index}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const d = row.data.data ?? {};

    switch (row.type) {
      case "delivery.consumed": {
        // A fast-path ack already showed this delivery above its line (docs/fast-path.md).
        if (d.deliveryId && byId.has(String(d.deliveryId))) {
          break;
        }
        const parts = (d.parts as Part[] | undefined) ?? [];
        // The history the hub seeds into a replacement session (send.ts) is for the bot, not for the chat.
        const rawText = parts
          .filter((p) => p.kind === "text")
          .map((p) => p.text ?? "")
          .join("\n");
        const visible = visibleDeliveryText(rawText);
        const { text, routineName } = visible;
        const files = parts
          .filter((p) => p.kind === "file")
          .map((p) => p.filename ?? p.name ?? "file");
        if (WAKE_MESSAGES.has(text.trim()) && !files.length) {
          // Nothing in this turn is the user's: hide it, and don't show the bot as busy.
          waking = true;
          working = false;
          break;
        }
        if (text || files.length || routineName) {
          replies = [];
          push({
            files,
            id: String(d.deliveryId ?? key),
            kind: "user",
            text,
            ...(routineName ? { routineName } : {}),
          });
        }
        break;
      }
      case "turn.started":
        replies = [];
        working = true;
        turnId = String(d.turnId ?? "");
        break;
      case "turn.settled": {
        working = false;
        // A quick-reply reaction rides on its settle (fast-path.ts fastClosingRows).
        const settledReaction = parseReaction({ emoji: d.reaction });
        const reacted = items.findLastIndex((i) => i.kind === "user");
        const reactedItem = items[reacted];
        if (settledReaction && reactedItem?.kind === "user") {
          items[reacted] = { ...reactedItem, reaction: settledReaction };
        }
        // Stop: what was still running stopped, it didn't fail.
        if (d.outcome === "cancelled" || d.outcome === "failed") {
          // The chips belonged to a reply that didn't finish, whatever the last item shows.
          replies = [];
          for (const [i, item] of items.entries()) {
            if (
              item.kind === "plan" &&
              item.plan.steps.some((step) => step.status === "in_progress")
            ) {
              items[i] = { ...item, paused: true };
            }
            if (item.kind === "activity" && item.state === "running") {
              items[i] = {
                ...item,
                state:
                  d.outcome === "cancelled" || item.taskId
                    ? "stopped"
                    : "error",
              };
            }
            if (item.kind === "login" && item.state === "open") {
              items[i] = { ...item, state: "closed" };
            }
            if (item.kind === "interaction" && item.state === "open") {
              items[i] = {
                ...item,
                outcome:
                  d.outcome === "cancelled"
                    ? "superseded-by-message"
                    : "turn-failed",
                pending: false,
                state: d.outcome === "cancelled" ? "withdrawn" : "closed",
              };
            }
          }
          // Cut mid-reply or mid-thought, the chat would just end there. Stopped steps already say so.
          if (d.outcome === "cancelled") {
            const last = items.at(-1);
            const id = `${turnId}:stopped`;
            if (
              !(
                (last?.kind === "activity" && last.state === "stopped") ||
                byId.has(id)
              )
            ) {
              push({ id, kind: "stopped" });
            }
          }
        }
        if (d.outcome === "failed" && !hasTurnError(items, turnId)) {
          const issue = hasAiIssueSignal(d)
            ? aiIssueFromEvent(d, provider)
            : undefined;
          push(
            {
              id: `${turnId}:turn`,
              kind: "error",
              text: issue
                ? aiIssueText(issue)
                : "Couldn't finish this reply. Try again.",
              ...(issue ? { issue } : {}),
            },
            true
          );
        }
        waking = false;
        break;
      }
      case "model.settled":
        if (d.outcome === "failed") {
          const issue = aiIssueFromEvent(d, provider);
          push(
            {
              id: `${turnId}:${key}`,
              issue,
              kind: "error",
              text: aiIssueText(issue),
            },
            true
          );
        }
        break;
      case "content.completed":
        if (
          d.kind === "text" &&
          (d.phase === "reply" || d.phase === "narration")
        ) {
          const id = String(d.partId);
          const text = String(d.value ?? "");
          completedParts.add(id);
          if (d.phase === "reply") {
            suppressProvisionalNarration(row, text);
          }
          push({
            id,
            kind: "bot",
            streaming: false,
            text,
            ...(row.md ? { markdown: row.md } : {}),
          });
          if (d.phase === "narration") {
            const turnKey = turnKeyOf(row);
            if (turnKey) {
              const entries = narrations.get(turnKey) ?? [];
              entries.push({
                id,
                text,
              });
              narrations.set(turnKey, entries);
            }
          }
        }
        break;
      case "task.started": {
        const taskId = String(d.taskId ?? "");
        if (!taskId || taskIndexes.has(taskId)) {
          break;
        }
        const callId = (d.startedBy as { callId?: string } | undefined)?.callId;
        const existing = callId ? byId.get(callId) : undefined;
        const existingItem =
          existing === undefined ? undefined : items[existing];
        if (
          existingItem?.kind === "consult" ||
          PEER.test(String(d.name ?? ""))
        ) {
          if (callId) {
            taskCalls.set(callId, taskId);
          }
          taskIndexes.set(taskId, -1);
          break;
        }
        const taskItem: ChatItem = {
          id: taskId,
          kind: "activity",
          state: "running",
          taskId,
          taskKind: String(d.kind ?? "tool"),
          tool: String(d.name ?? "Background work"),
        };
        if (existing !== undefined && items[existing]?.kind === "activity") {
          replace(existing, taskItem);
          taskIndexes.set(taskId, existing);
        } else {
          push(taskItem);
          taskIndexes.set(taskId, items.length - 1);
        }
        if (callId) {
          taskCalls.set(callId, taskId);
        }
        taskActiveCalls.set(taskId, new Set());
        break;
      }
      case "task.ended": {
        const taskId = String(d.taskId ?? "");
        const at = taskIndexes.get(taskId);
        const task = at === undefined ? undefined : items[at];
        if (
          at !== undefined &&
          at >= 0 &&
          task?.kind === "activity" &&
          task.taskId === taskId
        ) {
          const outcome = String(d.outcome ?? "failed");
          let state: "done" | "error" | "stopped";
          if (outcome === "completed") {
            state = "done";
          } else if (outcome === "cancelled") {
            state = "stopped";
          } else {
            state = "error";
          }
          const issue = hasAiIssueSignal(d)
            ? aiIssueFromEvent(d, provider)
            : undefined;
          const error = issue
            ? aiIssueText(issue)
            : (d.reason ??
              (d.error as { message?: unknown } | undefined)?.message);
          terminalTasks.add(taskId);
          replace(at, {
            ...task,
            state,
            ...(error ? { detail: String(error), error: String(error) } : {}),
          });
        }
        taskActiveCalls.delete(taskId);
        break;
      }
      case "call.started": {
        const callId = String(d.callId ?? "");
        const taskId =
          typeof d.taskId === "string" ? d.taskId : taskCalls.get(callId);
        if (!(callId && taskId)) {
          break;
        }
        taskCalls.set(callId, taskId);
        const at = taskIndexes.get(taskId);
        const task = at === undefined ? undefined : items[at];
        const active = taskActiveCalls.get(taskId) ?? new Set<string>();
        active.add(callId);
        taskActiveCalls.set(taskId, active);
        if (
          at !== undefined &&
          at >= 0 &&
          task?.kind === "activity" &&
          task.taskId === taskId &&
          !terminalTasks.has(taskId)
        ) {
          replace(at, { ...task, state: "running" });
        } else if (at === undefined) {
          const placeholder = byId.get(callId);
          const existing =
            placeholder === undefined ? undefined : items[placeholder];
          if (placeholder !== undefined && existing?.kind === "activity") {
            replace(placeholder, {
              ...existing,
              id: taskId,
              state: "running",
              taskId,
              taskKind: "agent",
            });
            taskIndexes.set(taskId, placeholder);
          }
        }
        break;
      }
      case "call.requested": {
        const callId = String(d.callId);
        const name = String(
          (d.capability as { name?: string } | undefined)?.name ?? ""
        );
        if (MCP_CONNECTION_TOOL_PREFIX.test(name) && name.includes("__")) {
          mcpCalls.set(callId, name);
        }
        if (HIDDEN_TOOLS.has(name)) {
          break;
        }
        if (name === REACT_TOOL) {
          // On the user's latest message; a later reaction replaces it.
          const emoji = parseReaction(d.input);
          const at = items.findLastIndex((i) => i.kind === "user");
          const target = items[at];
          if (emoji && target?.kind === "user" && !row.data.scope?.taskId) {
            items[at] = { ...target, reaction: emoji };
          }
          break;
        }
        if (name === QUICK_REPLIES_TOOL) {
          // The last valid call wins: a refused list the model corrected leaves its first try behind.
          const parsed = parseQuickReplies(d.input);
          if (parsed.ok && !row.data.scope?.taskId) {
            replies = [...parsed.replies];
            const turnKey = turnKeyOf(row);
            if (turnKey) {
              suggestedReplyTurns.add(turnKey);
            }
          }
          break;
        }
        const capability = (d.capability ?? {}) as {
          kind?: string;
          name?: string;
        };
        const { input } = d;
        const inputTaskId =
          capability.kind === "agent" ? taskIdFromInput(input) : undefined;
        const scopedTaskId =
          typeof row.data.scope?.taskId === "string"
            ? row.data.scope.taskId
            : inputTaskId;
        if (scopedTaskId) {
          taskCalls.set(callId, scopedTaskId);
          const active = taskActiveCalls.get(scopedTaskId) ?? new Set<string>();
          active.add(callId);
          taskActiveCalls.set(scopedTaskId, active);
          if (taskIndexes.has(scopedTaskId)) {
            break;
          }
        }
        const parentTaskId = taskCalls.get(callId);
        if (parentTaskId && taskIndexes.has(parentTaskId)) {
          break;
        }
        // Shown by its question (interaction.opened), which carries the id Done answers.
        if (name === "manage_plan" && !scopedTaskId) {
          planCalls.add(callId);
        }
        if (name === "request_login") {
          logins.add(callId);
          break;
        }
        // Its question card says it all: no separate activity row.
        if (name === "ask_user") {
          break;
        }
        if (name === "request_form") {
          logins.add(callId);
          forms.set(callId, formFieldsOf(d.input));
          break;
        }
        if (PEER.test(name)) {
          const peer = peerOf(callId);
          push({
            consultationId: peer?.id ?? null,
            direction: "to",
            id: `${callId}:to`,
            kind: "consult",
            peerName: nameOf(callId, name),
          });
        } else if (!FILE_TOOLS.has(name)) {
          push({
            detail: detailOf(d.input),
            id: callId,
            kind: "activity",
            state: "running",
            tool: name,
          });
        }
        break;
      }
      case "interaction.opened": {
        const subject = d.subject as
          | { callId?: string; taskId?: string }
          | undefined;
        const callId = subject?.callId ?? "";
        const taskId = subject?.taskId ?? "";
        const interactionId = String(d.interactionId ?? "");
        if (!interactionId || interactionIndexes.has(interactionId)) {
          break;
        }
        const request = (d.request ?? {}) as {
          kind?: string;
          prompt?: string;
          title?: string;
          display?: string;
          allowFreeform?: boolean;
          options?: {
            id?: string;
            label?: string;
            description?: string;
            style?: string;
          }[];
          link?: { url?: string; label?: string };
        };
        const origin = (d.origin ?? {}) as {
          sessionId?: string;
          interactionId?: string;
          call?: { callId?: string; name?: string };
        };
        const source = callId ? items[byId.get(callId) ?? -1] : undefined;
        const sourceTask = taskId
          ? items[taskIndexes.get(taskId) ?? -1]
          : undefined;
        const activity = source?.kind === "activity" ? source : sourceTask;
        const activityId =
          activity?.kind === "activity" ? activity.id : undefined;
        const repositorySetup =
          request.kind === "question" &&
          (origin.call?.name === "prepare_code_repository" ||
            (source?.kind === "activity" &&
              source.tool === "prepare_code_repository"));
        if (callId && logins.has(callId)) {
          const fields = forms.get(callId);
          push({
            ...(fields?.length ? { form: { fields } } : {}),
            id: callId,
            interactionId,
            kind: "login",
            state: "open",
            text: request.prompt ?? "I need you to log in.",
          });
        } else {
          push({
            allowFreeform: request.allowFreeform === true,
            ...(activityId ? { activityId } : {}),
            id: interactionId,
            interactionId,
            kind: "interaction",
            ...(repositorySetup ? { setup: "code-repository" as const } : {}),
            options: (request.options ?? []).flatMap((option) =>
              option.id && option.label
                ? [
                    {
                      id: option.id,
                      label: option.label,
                      ...(option.style === "primary" ||
                      option.style === "danger"
                        ? { style: option.style }
                        : { style: "secondary" as const }),
                    },
                  ]
                : []
            ),
            prompt: request.prompt ?? "The bot needs an answer.",
            type: request.kind === "approval" ? "approval" : "question",
            ...(safeLink(request.link) ? { link: safeLink(request.link) } : {}),
            ...(origin.sessionId && origin.interactionId
              ? {
                  origin: {
                    interactionId: origin.interactionId,
                    sessionId: origin.sessionId,
                    ...(origin.call?.callId
                      ? { callId: origin.call.callId }
                      : {}),
                    ...(origin.call?.name
                      ? { callName: origin.call.name }
                      : {}),
                  },
                }
              : {}),
            state: "open",
          });
        }
        interactionIndexes.set(interactionId, items.length - 1);
        break;
      }
      case "response.submitted": {
        const responseId = String(d.responseId ?? "");
        const interactionId = String(d.interactionId ?? "");
        if (responseId && interactionId) {
          responseInteractions.set(responseId, interactionId);
        }
        const at = interactionIndexes.get(interactionId);
        const item = at === undefined ? undefined : items[at];
        if (
          at !== undefined &&
          item?.kind === "interaction" &&
          item.state === "open"
        ) {
          replace(at, { ...item, pending: true });
        }
        break;
      }
      case "response.admitted": {
        const interactionId = responseInteractions.get(
          String(d.responseId ?? "")
        );
        const at = interactionId
          ? interactionIndexes.get(interactionId)
          : undefined;
        const item = at === undefined ? undefined : items[at];
        if (
          at !== undefined &&
          item?.kind === "interaction" &&
          item.state === "open"
        ) {
          replace(at, { ...item, pending: true });
        }
        break;
      }
      case "response.settled": {
        const responseId = String(d.responseId ?? "");
        const interactionId = responseInteractions.get(responseId);
        const at = interactionId
          ? interactionIndexes.get(interactionId)
          : undefined;
        const item = at === undefined ? undefined : items[at];
        if (
          at !== undefined &&
          item?.kind === "interaction" &&
          item.state === "open"
        ) {
          const outcome = String(d.outcome ?? "failed");
          // An applied answer remains pending until interaction.settled, which is the
          // authoritative point at which the UI can safely allow another response.
          replace(
            at,
            outcome === "applied"
              ? item
              : {
                  ...item,
                  pending: false,
                  ...(d.reason ? { error: String(d.reason) } : {}),
                }
          );
        }
        break;
      }
      case "interaction.settled": {
        const interactionId = String(d.interactionId ?? "");
        const at = interactionIndexes.get(interactionId);
        const item = at === undefined ? undefined : items[at];
        const outcome = String(d.outcome ?? "withdrawn");
        if (at !== undefined && item?.kind === "interaction") {
          const response = (d.response ?? {}) as {
            optionId?: string;
            text?: string;
          };
          let state:
            | "accepted"
            | "closed"
            | "failed"
            | "rejected"
            | "withdrawn";
          if (outcome === "accepted") {
            state = "accepted";
          } else if (outcome === "declined") {
            state = "rejected";
          } else if (outcome === "failed") {
            state = "failed";
          } else if (outcome === "withdrawn") {
            state = "withdrawn";
          } else {
            state = "closed";
          }
          replace(at, {
            ...item,
            pending: false,
            state,
            ...(response.optionId || response.text
              ? { outcome: response.optionId ?? response.text }
              : {}),
            ...(d.reason ? { outcome: String(d.reason) } : {}),
          });
        } else if (at !== undefined && item?.kind === "login") {
          // accepted: the user answered Done. Withdrawn/interrupted: no login.
          replace(at, {
            ...item,
            state: outcome === "accepted" ? "done" : "closed",
          });
        }
        break;
      }
      case "call.settled": {
        const callId = String(d.callId);
        const failed = d.outcome !== "completed";
        if (planCalls.has(callId) && !failed) {
          const plan = parseTaskPlan(d.output);
          if (plan && !waking) {
            const at = planIndexes.get(plan.id);
            const item = at === undefined ? undefined : items[at];
            if (at !== undefined && item?.kind === "plan") {
              if (plan.revision > item.plan.revision) {
                replace(at, { id: item.id, kind: "plan", plan });
              }
              hiddenPlanCalls.add(callId);
            } else {
              const activityAt = byId.get(callId);
              const planItem: ChatItem = {
                id: `plan:${plan.id}`,
                kind: "plan",
                plan,
              };
              const index = activityAt ?? items.length;
              if (activityAt === undefined) {
                push(planItem);
              } else {
                replace(activityAt, planItem);
              }
              planIndexes.set(plan.id, index);
            }
            break;
          }
        }
        const appTool = mcpCalls.get(callId);
        if (!failed && appTool && mcpAppSnapshotId(d.output)) {
          push({
            callId,
            id: `${callId}:app`,
            kind: "mcp-app",
            toolName: appTool,
          });
        }
        const taskId = taskCalls.get(callId);
        if (taskId) {
          const taskAt = taskIndexes.get(taskId);
          const task = taskAt === undefined ? undefined : items[taskAt];
          const active = taskActiveCalls.get(taskId);
          active?.delete(callId);
          const stopping =
            d.outcome === "interrupted" ||
            d.outcome === "abandoned" ||
            CANCEL_REASON.test(String(d.reason ?? ""));
          if (active && active.size === 0) {
            taskActiveCalls.delete(taskId);
          }
          if (
            active?.size === 0 &&
            taskAt !== undefined &&
            taskAt >= 0 &&
            task?.kind === "activity" &&
            task.taskId === taskId &&
            !terminalTasks.has(taskId)
          ) {
            let state: "done" | "error" | "stopped";
            if (stopping) {
              state = "stopped";
            } else if (failed) {
              state = "error";
            } else {
              state = "done";
            }
            replace(taskAt, {
              ...task,
              state,
              ...(stopping || failed
                ? {
                    error: String(
                      d.reason ??
                        (d.error as { message?: unknown } | undefined)
                          ?.message ??
                        d.outcome
                    ),
                  }
                : {}),
            });
            break;
          }
          // A peer task has no local activity row; its call still needs the
          // normal consultation divider below.
        }
        const to = byId.get(`${callId}:to`);
        if (to !== undefined) {
          const peer = peerOf(callId);
          const { peerName } = items[to] as Extract<
            ChatItem,
            { kind: "consult" }
          >;
          push({
            consultationId: peer?.id ?? null,
            direction: "from",
            id: `${callId}:from`,
            kind: "consult",
            peerName,
          });
          break;
        }
        const out = d.output as
          | {
              fileId?: string;
              name?: string;
              contentType?: string;
              size?: number;
              error?: string;
            }
          | undefined;
        if (out?.fileId) {
          push({
            contentType: out.contentType ?? "",
            fileId: out.fileId,
            id: callId,
            kind: "file",
            name: out.name ?? "file",
            size: out.size ?? 0,
          });
          break;
        }
        const at = byId.get(callId);
        if (at !== undefined && items[at]?.kind === "login") {
          // Its question settled first; a call that ends without one never got an answer.
          const login = items[at] as Extract<ChatItem, { kind: "login" }>;
          if (login.state === "open") {
            items[at] = { ...login, state: "closed" };
          }
          break;
        }
        if (at !== undefined && items[at]?.kind === "activity") {
          const activity = items[at] as Extract<ChatItem, { kind: "activity" }>;
          let state: "done" | "error" | "stopped";
          if (d.outcome === "cancelled") {
            state = "stopped";
          } else if (failed) {
            state = "error";
          } else {
            state = "done";
          }
          items[at] = {
            ...activity,
            state,
          };
          const reference = d.output as { taskId?: unknown } | undefined;
          if (
            d.outcome === "completed" &&
            !(failed || out?.error) &&
            activity.tool === "start_code_task" &&
            typeof reference?.taskId === "string" &&
            CODE_TASK_ID.test(reference.taskId) &&
            !codeTaskIds.has(reference.taskId)
          ) {
            codeTaskIds.add(reference.taskId);
            push({
              id: `code-task:${reference.taskId}`,
              kind: "code-task",
              taskId: reference.taskId,
            });
          }
        }
        break;
      }
      default:
        break;
    }
  }

  const staticItems = items.filter(
    (item) =>
      !(suppressedNarrations.has(item.id) || hiddenPlanCalls.has(item.id))
  );
  const staticReplies = offeredReplies(items, working, replies);
  return {
    project(deltas) {
      // Text still streaming: only while a turn runs, after everything stored. Copy the immutable
      // row projection only when adding deltas; completed rows can be reused by memoized consumers.
      const projectedItems = working ? [...staticItems] : staticItems;
      // The wake turn is hidden from the chat while it boots the computer. Keep the same guard
      // that `push` applies to stored rows: a live delta must not leak the hidden wake reply.
      if (working && !waking) {
        for (const [partId, text] of deltas) {
          if (
            !(
              completedParts.has(partId) ||
              suppressedNarrations.has(partId) ||
              hiddenPlanCalls.has(partId)
            ) &&
            text
          ) {
            projectedItems.push({
              id: partId,
              kind: "bot",
              streaming: true,
              text,
            });
          }
        }
      }
      return {
        items: projectedItems,
        replies: staticReplies,
        turnId,
        working,
      };
    },
  };
}

// A turn that ended on Stop or an error offers nothing: the chips belonged to a reply that didn't finish.
function offeredReplies(
  items: readonly ChatItem[],
  working: boolean,
  replies: string[]
): string[] {
  const last = items.at(-1)?.kind;
  if (working || last === "stopped" || last === "error" || last === "user") {
    return [];
  }
  return replies;
}
