// Shared fakes for the component tests: eve fact builders, a routed fetch, a fake EventSource and
// the whole app on top. lib/chat/chat.test-helpers can't be imported under happy-dom (Vite rewrites
// its `new URL(fixture, import.meta.url)` against the page URL), so the few builders we need live here.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, render, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import { ChatApp } from "@/components/chat-app";
import type {
  BotLite,
  BotStatus,
  InitialBotLite,
} from "@/lib/chat/client-store";
import type { ClientRow } from "@/lib/chat/items";
import { disableHappyDomWebAnimations } from "./motion-test-helpers";

disableHappyDomWebAnimations();
const ABSOLUTE_URL = /^https?:\/\/[^/]+/u;

// React's act() warnings need this flag; vitest has no globals for testing-library to set it.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// ---- eve facts (same shapes as lib/chat/chat.test-helpers) ----

export type Data = Record<string, unknown>;
export type F = readonly [type: string, data: Data];

export const row = (
  line: number,
  type: string,
  data: Data = {},
  index = 0
): ClientRow => ({ data: { data, type }, index, line, type });
/** One fact per line, starting at `from`. */
export const seqFrom = (from: number, ...facts: F[]): ClientRow[] =>
  facts.map(([type, data], i) => row(from + i, type, data));
export const seq = (...facts: F[]): ClientRow[] => seqFrom(0, ...facts);

export const said = (
  deliveryId: string,
  text: string,
  files: string[] = []
): F => [
  "delivery.consumed",
  {
    deliveryId,
    parts: [
      ...(text ? [{ kind: "text", text }] : []),
      ...files.map((filename) => ({ filename, kind: "file" })),
    ],
  },
];
export const started = (turnId: string): F => ["turn.started", { turnId }];
export const settled = (turnId: string, outcome = "completed"): F => [
  "turn.settled",
  { outcome, turnId },
];
export const reply = (
  partId: string,
  value: string,
  phase = "reply",
  kind = "text"
): F => ["content.completed", { kind, partId, phase, value }];
export const requested = (
  callId: string,
  name: string,
  input: Data = {}
): F => ["call.requested", { callId, capability: { name }, input }];
export const callSettled = (
  callId: string,
  outcome = "completed",
  output?: unknown
): F => [
  "call.settled",
  { callId, outcome, ...(output === undefined ? {} : { output }) },
];
export const modelFailed = (message?: string): F => [
  "model.settled",
  { outcome: "failed", ...(message ? { error: { message } } : {}) },
];
export const delivered = (deliveryId: string): F => [
  "delivery.settled",
  { deliveryId },
];

/** The real stream of one eve v27 session ("Say hello to QA Grok."), as stored rows. */
export function fixtureRows(): ClientRow[] {
  const path = join(
    dirname(fileURLToPath(import.meta.url)),
    "../lib/eve/__fixtures__/stream-v27.ndjson"
  );
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.includes('"$eve"'))
    .flatMap((l, line) =>
      ((JSON.parse(l) as { facts?: ClientRow["data"][] }).facts ?? []).map(
        (fact, index) => ({ data: fact, index, line, type: fact.type })
      )
    );
}

// ---- bots ----

export const botLite = (
  slug: string,
  over: Partial<BotLite> = {}
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
  status: "ready" as BotStatus,
  ...over,
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

// ---- network ----

// biome-ignore lint/style/useConsistentTypeDefinitions: test fixture type aliases mirror the external data contracts under test.
export type Call = {
  method: string;
  url: string;
  path: string;
  body: unknown;
  init?: RequestInit;
};
type Answer = Response | ((call: Call) => Response | Promise<Response>);

/** A minimal Response: what the components read (ok, status, json). */
export const json = (body: unknown, status = 200) =>
  ({
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  }) as unknown as Response;

/** An answer you settle by hand, to look at the UI while a request is in flight. */
export function held() {
  let resolve!: (r: Response) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { answer: () => promise, reject, resolve };
}

/**
 * fetch routed by method and path. `once` answers go first, in order; `on` answers stay (the newest
 * wins). Anything else is a 404. Every call is recorded with its JSON body parsed.
 */
export function fakeServer() {
  const calls: Call[] = [];
  // biome-ignore lint/style/useConsistentTypeDefinitions: test fixture type aliases mirror the external data contracts under test.
  type Route = { method: string; path: string | RegExp; answer: Answer };
  const once: Route[] = [];
  const always: Route[] = [];
  const matches = (r: Route, method: string, path: string) =>
    r.method === method &&
    (typeof r.path === "string" ? r.path === path : r.path.test(path));

  // biome-ignore lint/suspicious/useAwait: test double intentionally preserves the Promise-returning API contract.
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const [path = ""] = url.replace(ABSOLUTE_URL, "").split("?");
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // not JSON: keep the string
      }
    }
    const call: Call = { body, init, method, path, url };
    calls.push(call);
    const i = once.findIndex((r) => matches(r, method, path));
    const route =
      i >= 0
        ? once.splice(i, 1)[0]
        : always.findLast((r) => matches(r, method, path));
    if (!route) {
      return json({ error: "not found" }, 404);
    }
    return typeof route.answer === "function"
      ? route.answer(call)
      : route.answer;
  });

  return {
    calls,
    fetch,
    on(method: string, path: string | RegExp, answer: Answer) {
      always.push({ answer, method, path });
    },
    once(method: string, path: string | RegExp, ...answers: Answer[]) {
      for (const answer of answers) {
        once.push({ answer, method, path });
      }
    },
    to: (method: string, path: string | RegExp) =>
      calls.filter(
        (c) =>
          c.method === method &&
          (typeof path === "string" ? c.path === path : path.test(c.path))
      ),
  };
}
export type Server = ReturnType<typeof fakeServer>;

// biome-ignore lint/style/useConsistentTypeDefinitions: test fixture type aliases mirror the external data contracts under test.
export type FakeSource = {
  url: string;
  slug: string;
  closed: boolean;
  onerror: (() => void) | null;
  emit: (type: string, data: unknown) => void;
  close: () => void;
};

export function fakeEventSource() {
  const all: FakeSource[] = [];
  class FakeES implements FakeSource {
    slug: string;
    closed = false;
    onerror: (() => void) | null = null;
    listeners = new Map<string, ((e: { data: string }) => void)[]>();
    url: string;
    constructor(url: string) {
      this.url = url;
      this.slug = decodeURIComponent(url.split("/")[3] ?? "");
      all.push(this);
    }
    addEventListener(type: string, fn: (e: { data: string }) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    removeEventListener(type: string, fn: (e: { data: string }) => void) {
      this.listeners.set(
        type,
        (this.listeners.get(type) ?? []).filter((listener) => listener !== fn)
      );
    }
    emit(type: string, data: unknown) {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: fixture deliberately switches between these state branches.
      if (this.closed) {
        return;
      }
      for (const fn of this.listeners.get(type) ?? []) {
        fn({ data: JSON.stringify(data) });
      }
    }
    close() {
      this.closed = true;
    }
  }
  return {
    all,
    /** The newest stream of a bot. */
    last: (slug: string) => {
      const stream = all.filter((s) => s.slug === slug).at(-1);
      if (!stream) {
        throw new Error(`No stream found for ${slug}`);
      }
      return stream;
    },
    live: (slug?: string) =>
      all.filter((s) => !s.closed && (slug === undefined || s.slug === slug)),
    open: (url: string) => new FakeES(url) as unknown as EventSource,
  };
}
export type Streams = ReturnType<typeof fakeEventSource>;

/** Global fetch + EventSource fakes for one test. Undo with vi.unstubAllGlobals(). */
export function installFakes() {
  const server = fakeServer();
  const streams = fakeEventSource();
  vi.stubGlobal("fetch", server.fetch);
  // biome-ignore lint/correctness/noComponentHookFactories: browser API constructor mock, not a React component.
  vi.stubGlobal("EventSource", function FakeEventSource(url: string) {
    return streams.open(url);
  });
  return { server, streams };
}

// ---- rendering ----

export function renderApp(initial: InitialBotLite[]) {
  return render(<ChatApp initial={initial} />);
}

/** The visible chat of one bot (hidden panes don't match). */
export const pane = (name: string) =>
  within(screen.getByRole("region", { name: `Chat with ${name}` }));

/** Lets pending promises (fetch answers, store updates) settle inside act. */
export async function settle(rounds = 10) {
  await act(async () => {
    await Promise.all(Array.from({ length: rounds }, () => Promise.resolve()));
  });
}

/** Facts arriving on a bot's live stream. */
export function emitFacts(
  streams: Streams,
  slug: string,
  rows: readonly ClientRow[]
) {
  act(() => {
    for (const r of rows) {
      streams.last(slug).emit("fact", r);
    }
  });
}

/** Text arriving token by token on a bot's live stream. */
export function emitDelta(
  streams: Streams,
  slug: string,
  partId: string,
  delta: string,
  kind = "text"
) {
  act(() =>
    streams.last(slug).emit("progress", {
      data: { delta, kind, partId },
      type: "content.delta",
    })
  );
}

export const file = (
  name: string,
  type = "application/octet-stream",
  bytes = 3
) => new File(["x".repeat(bytes)], name, { type });
