import type { BotRow } from "../db";
import type { Fact } from "./sync";

/**
 * Fast path for simple chat turns (docs/fast-path.md). Everything here is pure: the router, the
 * prompt, the synthetic facts the UI renders and the context the bot gets on its next normal turn.
 */

export const FAST_MAX_CHARS = 300;
/** Synthetic rows share eve's last line and sort after its facts; eve never numbers a line's facts this high. */
export const FAST_INDEX_BASE = 1_000_000_000;
export const FAST_DELIVERY_PREFIX = "fast:";

/**
 * `FAST_PATH_ACK=1`: a turn that needs tools first gets one short line from the fast model (what the
 * bot is about to do), kept as the start of the bot's answer while eve does the work. Off: unchanged.
 */
export const fastAckEnabled = (value = process.env.FAST_PATH_ACK) =>
  value === "1";

/** `FAST_PATH_BOTS`: comma-separated slugs, or `*` for every bot. Unset: off, nothing changes. */
export function fastPathEnabled(
  slug: string,
  list = process.env.FAST_PATH_BOTS
): boolean {
  if (!list) {
    return false;
  }
  const slugs = list.split(",").map((entry) => entry.trim());
  return slugs.includes("*") || slugs.includes(slug);
}

// ponytail: a conservative keyword list, not a classifier. A false "action" only costs the normal
// path; the model's `escalate` tool catches what slips through. Stems match word starts.
const ACTION_STEMS = [
  // English
  "open",
  "search",
  "find",
  "look up",
  "lookup",
  "browse",
  "navigate",
  "go to",
  "visit",
  "create",
  "make",
  "build",
  "send",
  "email",
  "e-mail",
  "mail",
  "schedule",
  "remind",
  "remember",
  "save",
  "download",
  "upload",
  "install",
  "run",
  "execute",
  "deploy",
  "book",
  "buy",
  "order",
  "delete",
  "remove",
  "update",
  "fix",
  "file",
  "document",
  "attach",
  "routine",
  "code",
  "calendar",
  "spreadsheet",
  "excel",
  "pdf",
  "link",
  "url",
  "browser",
  "screen",
  "computer",
  "news",
  "weather",
  "price",
  // Spanish
  "abr",
  "busc",
  "naveg",
  "cre[aáe]",
  "gener",
  "envi",
  "enví",
  "mand",
  "program",
  "agend",
  "record",
  "acord",
  "guard",
  "descarg",
  "sub[ií]",
  "instal",
  "ejecut",
  "corr(?:é|er)",
  "borr",
  "elimin",
  "actualiz",
  "arregl",
  "archiv",
  "document",
  "adjunt",
  "enlace",
  "rutina",
  "c[oó]digo",
  "planilla",
  "correo",
  "calendari",
  "reuni[oó]n",
  "investig",
  "pantalla",
  "computadora",
  "noticia",
  "clima",
  "precio",
  "cotizaci",
];
const ACTION = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${ACTION_STEMS.join("|")})`,
  "iu"
);
const URLISH =
  /https?:\/\/|www\.|[\p{L}\p{N}-]+\.(?:com|net|org|io|ai|app|dev|ar|es|co|me)(?![\p{L}\p{N}])/iu;

export type FastRoute =
  // `mustEscalate`: the fast model can't open what came with the message (wide + ack only). It only
  // acknowledges in one line and the turn always goes on to the bot, files and links included.
  | { fast: true; mustEscalate?: "files" | "url" }
  | { fast: false; reason: "action" | "empty" | "files" | "long" | "url" };

// `FAST_PATH_ROUTER=wide` sends nearly every text turn down the fast path: only files, links and
// very long messages stay off it. The model escalates when it needs a tool (`escalate`), which costs
// that turn ~1 s and a second model call; every other turn skips eve's queue.
const WIDE_MAX_CHARS = 2000;

/** The text-only part of the decision; the bot's state is checked separately (fast-reply.ts). */
export function routeFast({
  ack = fastAckEnabled(),
  fileIds,
  mode = process.env.FAST_PATH_ROUTER,
  text,
}: {
  ack?: boolean;
  fileIds: readonly string[];
  mode?: string;
  text: string;
}): FastRoute {
  const wide = mode === "wide";
  const ackOnly = wide && ack;
  const trimmed = text.trim();
  if (fileIds.length) {
    return ackOnly
      ? { fast: true, mustEscalate: "files" }
      : { fast: false, reason: "files" };
  }
  if (!trimmed) {
    return { fast: false, reason: "empty" };
  }
  if (trimmed.length > (wide ? WIDE_MAX_CHARS : FAST_MAX_CHARS)) {
    return { fast: false, reason: "long" };
  }
  if (URLISH.test(trimmed)) {
    return ackOnly
      ? { fast: true, mustEscalate: "url" }
      : { fast: false, reason: "url" };
  }
  if (!wide && ACTION.test(trimmed)) {
    return { fast: false, reason: "action" };
  }
  return { fast: true };
}

const MAX_MEMORY_CHARS = 8000;

/** The bot's voice without its computer: identity and style from the template, its memory and recent chat. */
export function fastSystemPrompt(
  bot: Pick<BotRow, "description" | "instructions" | "name">,
  memory: string | null,
  history: string,
  ack = false,
  mustEscalate?: "files" | "url"
): string {
  const escalate = ack
    ? `- If a good answer needs any of those, fresh or external information, an action, a file, or anything beyond your memory and this conversation: first write ONE short sentence (at most 15 words, in the user's language) saying what you'll do now, without claiming any result or inventing any fact; then call \`escalate\`. Your full self continues right after that sentence.`
    : "- If a good answer needs any of those, fresh or external information, an action, a file, or anything beyond your memory and this conversation, call `escalate` right away, before writing anything.";
  return [
    `# Identity\n\nYou are ${bot.name}. ${bot.description}\n\n${bot.instructions}`.trim(),
    "# How you work\n\n- You write in English, clear and brief.",
    `# Quick reply mode

You are answering from a lightweight chat mode, without your computer, tools, files, browser, routines, skills or connected apps.
${escalate}
- Otherwise answer directly and briefly. Never say you did, saved, scheduled or looked up something.
- When words would be overkill (a thanks, an ok, a done), call \`react\` with one emoji and write nothing.${
      mustEscalate
        ? `
- This message comes with ${mustEscalate === "files" ? "files" : "a link"} you cannot open here: write only the one short sentence, then call \`escalate\`.`
        : ""
    }`,
    memory?.trim()
      ? `# Memory\n\n${memory.trim().slice(0, MAX_MEMORY_CHARS)}`
      : "",
    history ? `# Recent conversation\n\n${history}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface FastSlot {
  /** First of the four indexes (user, start, reply, settle) this exchange owns on that line. */
  index: number;
  /** eve's last stored line in the session (-1 before any). */
  line: number;
}

export interface FastRow {
  data: Fact;
  index: number;
  line: number;
  type: string;
}

const row = (
  slot: FastSlot,
  offset: number,
  type: string,
  data: Record<string, unknown>,
  turnId: string
): FastRow => ({
  data: { data, scope: { turnId }, type },
  index: slot.index + offset,
  line: slot.line,
  type,
});

export const fastTurnId = (messageId: string) => `fast-${messageId}`;
export const fastPartId = (messageId: string) => `fast-${messageId}:reply`;
export const fastDeliveryId = (messageId: string) =>
  `${FAST_DELIVERY_PREFIX}${messageId}`;

/** Shown when the first token arrives: The user's message, then a running turn (deltas render inside it). */
export function fastOpeningRows(
  slot: FastSlot,
  messageId: string,
  text: string
): FastRow[] {
  const turnId = fastTurnId(messageId);
  return [
    row(
      slot,
      0,
      "delivery.consumed",
      {
        deliveryId: fastDeliveryId(messageId),
        parts: [{ kind: "text", text }],
      },
      turnId
    ),
    row(slot, 1, "turn.started", { turnId }, turnId),
  ];
}

export function fastClosingRows(
  slot: FastSlot,
  messageId: string,
  reply: string,
  reaction?: string
): FastRow[] {
  const turnId = fastTurnId(messageId);
  // A reaction alone has no reply row; it rides on the settle (the exchange owns only four indexes).
  const settled = row(
    slot,
    3,
    "turn.settled",
    { outcome: "completed", turnId, ...(reaction ? { reaction } : {}) },
    turnId
  );
  if (!reply.trim()) {
    return [settled];
  }
  return [
    row(
      slot,
      2,
      "content.completed",
      {
        kind: "text",
        partId: fastPartId(messageId),
        phase: "reply",
        value: reply,
      },
      turnId
    ),
    settled,
  ];
}

/**
 * An acknowledgement kept before escalating: The user's message under eve's real delivery id (eve's own
 * `delivery.consumed` for it is then a duplicate the chat skips) and a turn that stays running, so the
 * chat keeps showing work until eve's turn settles it. Three indexes, no settle.
 */
export function fastAckRows(
  slot: FastSlot,
  messageId: string,
  text: string,
  ack: string,
  deliveryId: string
): FastRow[] {
  const [consumed, started] = fastOpeningRows(slot, messageId, text);
  const [completed] = fastClosingRows(slot, messageId, ack);
  return [
    {
      ...consumed,
      data: {
        ...consumed.data,
        data: { ...consumed.data.data, deliveryId },
      },
    },
    started,
    completed,
  ];
}

export interface FastExchange {
  reply: string;
  text: string;
}

/**
 * eve never saw these exchanges: the next normal message carries them as client context, the same
 * channel that already brings firesides and the time zone to the bot. No bot redeploy needed.
 */
export function withFastExchanges<T extends Record<string, unknown>>(
  context: T | null | undefined,
  exchanges: readonly FastExchange[]
): (T & Record<string, unknown>) | null | undefined {
  if (!exchanges.length) {
    return context;
  }
  return {
    ...(context ?? ({} as T)),
    recentQuickReplies: exchanges.map((e) => ({
      mati: e.text,
      you: e.reply,
    })),
    recentQuickRepliesNote:
      "Exchanges you answered in quick reply mode since your last turn, oldest first. They are part of this conversation.",
  };
}

/** The ack the user already saw for this very message: the bot continues from it instead of greeting again. */
export function withFastAck<T extends Record<string, unknown>>(
  context: T | null | undefined,
  ack: string | undefined
): (T & Record<string, unknown>) | null | undefined {
  if (!ack) {
    return context;
  }
  return {
    ...(context ?? ({} as T)),
    quickAck: ack,
    quickAckNote:
      "You already sent the user this line about this message, in quick reply mode. Continue from it: don't repeat it or greet again.",
  };
}
