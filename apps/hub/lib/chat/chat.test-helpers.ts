// Shared builders for the chat tests: eve facts, the real v27 fixture, a fake EventSource and fetch.
import { readFileSync } from "node:fs";
import { vi } from "vitest";
import type { BotLite, BotStatus, InitialBotLite } from "./client-store";
import { type ClientRow, toChatView } from "./items";

export type Data = Record<string, unknown>;
/** One fact before it gets a position: [type, data]. */
export type F = readonly [type: string, data: Data];

export const row = (
  line: number,
  type: string,
  data: Data = {},
  index = 0
): ClientRow => ({
  data: { data, type },
  index,
  line,
  type,
});

/** One fact per line, lines 0, 1, 2… */
export const seq = (...facts: F[]): ClientRow[] =>
  facts.map(([type, data], line) => row(line, type, data));

/** Facts sharing one stored line, indexes 0, 1, 2… */
export const onLine = (line: number, ...facts: F[]): ClientRow[] =>
  facts.map(([type, data], index) => row(line, type, data, index));

// Fact builders, named after what eve writes.
export const admitted = (deliveryId: string): F => [
  "delivery.admitted",
  { deliveryId },
];
export const consumed = (
  deliveryId: string | undefined,
  parts?: unknown[]
): F => [
  "delivery.consumed",
  {
    ...(deliveryId === undefined ? {} : { deliveryId }),
    ...(parts === undefined ? {} : { parts }),
  },
];
export const said = (deliveryId: string, text: string): F =>
  consumed(deliveryId, [{ kind: "text", text }]);
export const started = (turnId?: unknown): F => [
  "turn.started",
  turnId === undefined ? {} : { turnId },
];
export const settled = (turnId: string, outcome?: string): F => [
  "turn.settled",
  { turnId, ...(outcome === undefined ? {} : { outcome }) },
];
export const modelFailed = (error?: unknown): F => [
  "model.settled",
  { outcome: "failed", ...(error === undefined ? {} : { error }) },
];
export const modelDone = (): F => [
  "model.settled",
  { finishReason: "stop", outcome: "completed" },
];
/** `phase: null` leaves the phase out. */
export const reply = (
  partId: string,
  value?: unknown,
  phase: string | null = "reply",
  kind = "text"
): F => [
  "content.completed",
  {
    kind,
    partId,
    ...(phase === null ? {} : { phase }),
    ...(value === undefined ? {} : { value }),
  },
];
export const requested = (
  callId: string,
  name?: string,
  input: Data = {}
): F => [
  "call.requested",
  { callId, ...(name === undefined ? {} : { capability: { name } }), input },
];
export const callSettled = (
  callId: string,
  outcome?: string,
  output?: unknown
): F => [
  "call.settled",
  {
    callId,
    ...(outcome === undefined ? {} : { outcome }),
    ...(output === undefined ? {} : { output }),
  },
];
export const childOpened = (
  name: string,
  callId: string,
  sessionId = "wrun_child"
): F => ["child.opened", { name, owner: { callId }, sessionId, stream: "/s" }];
export const noise = (type = "usage.recorded"): F => [type, { kind: "model" }];

export type Consults = Map<string, { id: string; peerName: string }>;
export const view = (
  rows: readonly ClientRow[],
  opts: {
    deltas?: Map<string, string>;
    consults?: Consults;
    slot?: (n: number) => string | undefined;
  } = {}
) =>
  toChatView(
    rows,
    opts.deltas ?? new Map(),
    opts.consults ?? new Map(),
    opts.slot
  );

// The real stream of one eve v27 session ("Say hello to QA Grok."), numbered like eve numbers stored lines.
export interface FixtureRecord {
  line: number;
  record: Data;
}
export const fixtureRecords: FixtureRecord[] = readFileSync(
  new URL("../eve/__fixtures__/stream-v27.ndjson", import.meta.url),
  "utf8"
)
  .split("\n")
  .filter((l) => l.trim() && !l.includes('"$eve"'))
  .map((l, line) => ({ line, record: JSON.parse(l) as Data }));

export const rowsOf = (records: readonly FixtureRecord[]): ClientRow[] =>
  records.flatMap(({ line, record }) =>
    ((record.facts as ClientRow["data"][] | undefined) ?? []).map(
      (fact, index) => ({ data: fact, index, line, type: fact.type })
    )
  );

export const deltasOf = (
  records: readonly FixtureRecord[]
): Map<string, string> => {
  const deltas = new Map<string, string>();
  for (const { record } of records) {
    const p = record.progress as
      | { type: string; data: { partId: string; delta: string } }
      | undefined;
    if (p?.type === "content.delta") {
      deltas.set(
        p.data.partId,
        (deltas.get(p.data.partId) ?? "") + p.data.delta
      );
    }
  }
  return deltas;
};

export const FIXTURE_DELIVERY = "33928fec-868d-4964-9ed7-bfffa52ad551";

/** Deterministic Fisher–Yates, so properties can shuffle from a generated seed. */
export function shuffle<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  // This helper intentionally implements a deterministic 32-bit PRNG for property tests.
  // biome-ignore lint/suspicious/noBitwiseOperators: the seeded PRNG requires 32-bit mixing
  let s = seed >>> 0 || 1;
  const next = () => {
    // biome-ignore lint/suspicious/noBitwiseOperators: the seeded PRNG requires 32-bit mixing
    s = (s + 0x6d_2b_79_f5) >>> 0;
    let t = s;
    // biome-ignore lint/suspicious/noBitwiseOperators: the seeded PRNG requires 32-bit mixing
    t = Math.imul(t ^ (t >>> 15), t | 1);
    // biome-ignore lint/suspicious/noBitwiseOperators: the seeded PRNG requires 32-bit mixing
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    // biome-ignore lint/suspicious/noBitwiseOperators: the seeded PRNG requires 32-bit mixing
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const swap = out[i];
    out[i] = out[j];
    out[j] = swap;
  }
  return out;
}

// ---- client store fakes ----

export const botLite = (
  slug: string,
  status: BotStatus = "ready"
): BotLite => ({
  avatar: null,
  billing: "token-pass",
  description: "",
  error: null,
  fast: false,
  instructions: "",
  model: "moonshotai/kimi-k3",
  name: slug,
  slug,
  status,
});

export const initialBot = (
  slug: string,
  over: Partial<InitialBotLite> = {}
): InitialBotLite => ({
  ...botLite(slug),
  consults: [],
  past: [],
  rows: [],
  sessionId: "s1",
  ...over,
});

export interface FakeSource {
  close: () => void;
  closed: boolean;
  emit: (type: string, data: unknown) => void;
  /** The connection drops (EventSource fires `error`). */
  fail: () => void;
  onerror: (() => void) | null;
  slug: string;
  url: string;
}

export function fakeEventSource() {
  const all: FakeSource[] = [];
  class FakeES implements FakeSource {
    slug: string;
    closed: boolean;
    onerror: (() => void) | null = null;
    listeners = new Map<string, ((e: { data: string }) => void)[]>();
    url: string;
    constructor(url: string) {
      this.url = url;
      this.closed = false;
      this.slug = decodeURIComponent(url.split("/")[3] ?? "");
      all.push(this);
    }
    addEventListener(type: string, fn: (e: { data: string }) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    emit(type: string, data: unknown) {
      if (this.closed) {
        return;
      }
      for (const fn of this.listeners.get(type) ?? []) {
        fn({ data: JSON.stringify(data) });
      }
    }
    fail() {
      this.onerror?.();
    }
    close() {
      this.closed = true;
    }
  }
  return {
    all,
    /** The newest stream of a bot. */
    last: (slug: string) => {
      const source = all.filter((s) => s.slug === slug).at(-1);
      if (!source) {
        throw new Error(`No EventSource opened for ${slug}`);
      }
      return source;
    },
    live: (slug?: string) =>
      all.filter((s) => !s.closed && (slug === undefined || s.slug === slug)),
    open: (url: string) => new FakeES(url) as unknown as EventSource,
    opened: (slug?: string) =>
      all.filter((s) => slug === undefined || s.slug === slug),
  };
}

export const response = (
  body: unknown,
  isOk = true,
  status = isOk ? 200 : 502
) => ({ json: async () => body, ok: isOk, status }) as unknown as Response;

export interface FetchCall {
  init?: RequestInit;
  url: string;
}

type Answer = (url: string, init?: RequestInit) => Promise<Response>;

/** fetch that answers from a queue (then `fallback`) and records every call. */
export function fakeFetch(
  fallback: Answer = () => Promise.resolve(response({}))
) {
  const calls: FetchCall[] = [];
  const queue: Answer[] = [];
  const fn = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ init, url: String(url) });
    return Promise.resolve((queue.shift() ?? fallback)(String(url), init));
  });
  return {
    calls,
    /** Next answers, in order. */
    enqueue: (...answers: Answer[]) => {
      queue.push(...answers);
    },
    fetch: fn as unknown as typeof fetch,
  };
}

export const ok = (body: unknown) => () => Promise.resolve(response(body));
export const notOk =
  (status = 502) =>
  () =>
    Promise.resolve(response({ error: "boom" }, false, status));
export const throws = () => (): Promise<Response> =>
  Promise.reject(new TypeError("Failed to fetch"));

/** A promise you settle by hand, to order a POST against stream events. */
export function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
