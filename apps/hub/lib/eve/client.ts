// Hub → bot: the eve session HTTP API (stream v27).
import { trace } from "@opentelemetry/api";
import { span } from "../trace";

export interface BotCall {
  fetchImpl?: typeof fetch;
  /** Extra trusted headers used by the hub's development relay. */
  headers?: Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
  token: () => Promise<string>;
  url: string;
}

export interface OutgoingMessage {
  /** Ephemeral context for this turn; Eve does not persist it in session history. */
  clientContext?: Record<string, unknown>;
  files: { url: string; mediaType: string; filename: string }[];
  id: string;
  text: string;
  turnPolicy?: "queue" | "steer";
}

export interface StreamRecord {
  line: number;
  record: Record<string, unknown>;
}

async function call(
  bot: BotCall,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const send = (token: string) =>
    (bot.fetchImpl ?? fetch)(`${bot.url}/eve/v1/session${path}`, {
      ...init,
      // Never let Next buffer or cache an eve stream.
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(bot.headers ?? {}),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  return send(await span("eve.token", () => bot.token()));
}

async function fail(what: string, res: Response): Promise<never> {
  throw new Error(
    `eve ${what} failed: ${res.status} ${(await res.text()).slice(0, 300)}`
  );
}

/** Prewarmed session; operationId makes a retried create return the same session. */
export async function createSession(
  bot: BotCall,
  operationId: string
): Promise<string> {
  const res = await call(bot, "", {
    body: JSON.stringify({ operationId }),
    method: "POST",
  });
  if (!res.ok) {
    await fail("create session", res);
  }
  return ((await res.json()) as { sessionId: string }).sessionId;
}

const NOT_READY_BUDGET_MS = 20_000;

/** idempotencyKey = message id: a retry returns the original delivery (spec 4.3). */
export async function sendMessage(
  bot: BotCall,
  sessionId: string,
  msg: OutgoingMessage
): Promise<{ deliveryId: string }> {
  const message = msg.files.length
    ? [
        ...(msg.text ? [{ text: msg.text, type: "text" }] : []),
        ...msg.files.map((f) => ({
          data: f.url,
          filename: f.filename,
          mediaType: f.mediaType,
          type: "file",
        })),
      ]
    : msg.text;
  const body = JSON.stringify({
    idempotencyKey: msg.id,
    message,
    ...(msg.turnPolicy ? { turnPolicy: msg.turnPolicy } : {}),
    ...(msg.clientContext ? { clientContext: msg.clientContext } : {}),
  });
  const sleep = bot.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (
    let waited = 0, delay = 250;
    ;
    waited += delay, delay = Math.min(delay * 2, 4000)
  ) {
    // A 409 retry must wait for the previous session operation before posting again.
    // biome-ignore lint/performance/noAwaitInLoops: retries are intentionally sequential and bounded
    const res = await call(bot, `/${sessionId}`, { body, method: "POST" });
    // 409 session_not_ready retries are the usual suspect when a first message is slow.
    trace.getActiveSpan()?.setAttributes({
      "eve.send.retryWaitMs": waited,
      "eve.send.status": res.status,
    });
    if (res.ok) {
      return {
        deliveryId: ((await res.json()) as { deliveryId: string }).deliveryId,
      };
    }
    if (res.status !== 409 || waited >= NOT_READY_BUDGET_MS) {
      return fail("send", res);
    }
    // `?.`: a 409 body can be JSON null.
    const code = (
      (await res
        .clone()
        .json()
        .catch(() => null)) as { code?: string } | null
    )?.code;
    if (code !== "session_not_ready") {
      return fail("send", res);
    }
    await sleep(delay);
  }
}

/** Answers a question the bot's turn is paused on (eve `ctx.ask`, e.g. request_login's Done). */
export interface InteractionAnswer {
  interactionId: string;
  optionId?: string;
  text?: string;
}

/** Answers a native eve question or approval. Exactly one of optionId/text is normally supplied. */
export async function answerInteraction(
  bot: BotCall,
  sessionId: string,
  answer: InteractionAnswer
): Promise<void> {
  const res = await call(bot, `/${sessionId}`, {
    body: JSON.stringify({ answers: [answer] }),
    method: "POST",
  });
  if (!res.ok) {
    await fail("answer", res);
  }
}

/**
 * Cancels only the turn the UI is showing. `null` cancels nothing (eve settles it `ignored`), but it
 * still travels hook → queue → flow: the warm route uses it to wake the bot's flow function.
 */
export async function cancelTurn(
  bot: BotCall,
  sessionId: string,
  turnId: string | null
): Promise<void> {
  const res = await call(bot, `/${sessionId}/cancel`, {
    body: JSON.stringify({ turnId }),
    method: "POST",
  });
  if (!res.ok) {
    await fail("cancel", res);
  }
}

/**
 * Summarizes the session's history now, without adding a user message (eve's `compact` control).
 * eve queues it behind a running turn. Lets a bot pay a compaction off the user's next message.
 */
export async function compactSession(
  bot: BotCall,
  sessionId: string
): Promise<void> {
  const res = await call(bot, `/${sessionId}/compact`, { method: "POST" });
  if (!res.ok) {
    await fail("compact", res);
  }
}

export type PrewarmStatus =
  | "accepted"
  | "no_active_session"
  | "ready"
  | "unsupported";

/**
 * eve's prewarm of an existing idle session: a POST with no body. It never starts a turn or calls
 * a model. `ready` means the session already runs on the bot's current deployment (nothing moved);
 * `accepted` means eve is moving it to the current deployment, which wakes its workflow.
 */
export async function prewarmSession(
  bot: BotCall,
  sessionId: string
): Promise<PrewarmStatus> {
  const res = await call(bot, `/${sessionId}`, { method: "POST" });
  if (!res.ok) {
    await fail("prewarm", res);
  }
  return ((await res.json()) as { status: PrewarmStatus }).status;
}

/**
 * Ends one session for good: a dedicated fireside session, or a main session that lost its install
 * (lib/chat/session.ts). True once eve reports it ended or no longer active.
 */
export async function endSession(
  bot: BotCall,
  sessionId: string,
  reason = "fireside control"
): Promise<boolean> {
  const res = await call(bot, `/${sessionId}/end`, {
    body: JSON.stringify({ reason }),
    method: "POST",
  });
  if (res.status === 404 || res.status === 410) {
    return true;
  }
  if (
    res.status === 409 &&
    (
      await res
        .clone()
        .json()
        .catch(() => null)
    )?.code === "session_not_active"
  ) {
    return true;
  }
  if (!res.ok) {
    await fail("end", res);
  }
  return false;
}

/**
 * Stored records (event lines and progress records) numbered from startIndex.
 * Transport records ({"$eve": …}) hold no position and are skipped.
 */
export function readStream(
  bot: BotCall,
  sessionId: string,
  startIndex: number,
  follow: boolean,
  signal?: AbortSignal
) {
  return readStreamAt(bot, `/${sessionId}/stream`, startIndex, follow, signal);
}

/** A consultation thread, read through the parent bot (checkpoint C). */
export const childStreamPath = (
  parentSessionId: string,
  callId: string,
  childSessionId: string
) => `/${parentSessionId}/subagents/${callId}/${childSessionId}/stream`;

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) {
    return reader.read();
  }
  if (signal.aborted) {
    reader.cancel().catch(() => undefined);
    return { done: true, value: undefined };
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<ReadableStreamReadResult<Uint8Array>>(
    (resolve) => {
      onAbort = () => {
        reader.cancel().catch(() => undefined);
        resolve({ done: true, value: undefined });
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  );
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

async function openStream(
  bot: BotCall,
  url: string,
  signal?: AbortSignal
): Promise<Response | null> {
  try {
    return await call(bot, url, signal ? { signal } : undefined);
  } catch (error) {
    if (signal?.aborted) {
      return null;
    }
    throw error;
  }
}

export async function* readStreamAt(
  bot: BotCall,
  streamPath: string,
  startIndex: number,
  follow: boolean,
  signal?: AbortSignal
): AsyncGenerator<StreamRecord> {
  // A catch-up read uses includeTailIndex: it ends after the last stored line (eve docs,
  // "Stream a session"). We also stop at that line ourselves; a subagent stream kept going.
  const qs = new URLSearchParams({
    startIndex: String(startIndex),
    ...(follow ? { follow: "true" } : { includeTailIndex: "1" }),
  });
  const res = await openStream(bot, `${streamPath}?${qs}`, signal);
  if (!res) {
    return;
  }
  if (!(res.ok && res.body)) {
    await fail("stream", res);
    return;
  }
  const tailHeader = res.headers.get("x-eve-stream-tail-index");
  const tail =
    follow || tailHeader === null
      ? Number.POSITIVE_INFINITY
      : Number(tailHeader);
  if (tail < startIndex) {
    res.body.cancel().catch(() => undefined);
    return;
  }
  let line = startIndex;
  let buf = "";
  const decoder = new TextDecoder();
  const flush = function* (chunk: string) {
    for (const raw of chunk.split("\n")) {
      if (!raw.trim()) {
        continue;
      }
      const record = JSON.parse(raw) as Record<string, unknown>;
      if ("$eve" in record) {
        continue;
      }
      const currentLine = line;
      line += 1;
      yield { line: currentLine, record };
    }
  };
  const reader = res.body.getReader();
  try {
    for (;;) {
      // A stream reader can only be consumed sequentially; Promise.all would corrupt ordering.
      // biome-ignore lint/performance/noAwaitInLoops: stream reads must preserve wire order
      const { value, done } = await readChunk(reader, signal);
      if (done) {
        break;
      }
      buf += decoder.decode(value, { stream: true });
      const cut = buf.lastIndexOf("\n");
      if (cut < 0) {
        continue;
      }
      for (const r of flush(buf.slice(0, cut))) {
        yield r;
        if (r.line >= tail) {
          return;
        }
      }
      buf = buf.slice(cut + 1);
    }
    yield* flush(buf);
  } finally {
    // Fire and forget: under Next's fetch, awaiting cancel on an endless body can hang.
    reader.cancel().catch(() => undefined);
  }
}
