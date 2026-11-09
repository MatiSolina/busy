import { describe, expect, it, it as test, vi } from "vitest";
import {
  deferred,
  fakeEventSource,
  fakeFetch,
  ok,
  row,
} from "./chat.test-helpers";
import { createChatStore, type InitialBotLite } from "./client-store";
import { toChatView } from "./items";
import { waitStage } from "./status";

const bot: InitialBotLite = {
  avatar: null,
  billing: "gateway",
  consults: [],
  description: "General assistant.",
  error: null,
  fast: false,
  instructions: "",
  model: "model/example",
  name: "Assistant",
  past: [],
  rows: [],
  sessionId: null,
  slug: "assistant",
  status: "creating",
};

test("retains the server snapshot while live facts, deltas and deletion advance", () => {
  const streams = fakeEventSource();
  const settled = row(9, "turn.settled", {
    outcome: "completed",
    turnId: "old",
  });
  const store = createChatStore(
    [{ ...bot, rows: [settled], sessionId: "current", status: "ready" }],
    { fetch: vi.fn(), open: streams.open }
  );
  const initial = store.getState();
  expect(store.getServerState()).toBe(initial);
  store.select("assistant");
  const source = streams.last("assistant");
  source.emit("fact", row(10, "turn.started", { turnId: "live" }));
  source.emit("progress", {
    data: { delta: "Hello", kind: "text", partId: "part" },
    type: "content.delta",
  });
  expect(store.getState().bots.assistant.rows).toHaveLength(2);
  expect(store.getState().bots.assistant.deltas.get("part")).toBe("Hello");
  store.removeBot("assistant");
  expect(store.getState().bots.assistant).toBeUndefined();
  expect(store.getServerState()).toBe(initial);
  expect(initial.bots.assistant.rows).toEqual([settled]);
  expect(initial.bots.assistant.deltas.size).toBe(0);
  expect(initial.selected).toBe("assistant");
});

test("resumes one line before the snapshot watermark to replay every same-line fact", () => {
  const streams = fakeEventSource();
  const store = createChatStore(
    [
      {
        ...bot,
        resumeAfter: 42,
        rows: [row(42, "content.completed")],
        sessionId: "current",
        status: "ready",
      },
    ],
    { fetch: vi.fn(), open: streams.open }
  );
  store.select("assistant");
  expect(streams.last("assistant").url).toContain("after=41");
  expect(store.getState().bots.assistant?.lastLine).toBe(41);
});

describe("stream lifecycle", () => {
  it("deduplicates replayed progress after pausing without dropping new deltas", () => {
    const sources = fakeEventSource();
    const store = createChatStore(
      [{ ...bot, sessionId: "current", status: "ready" }],
      { fetch: vi.fn(), open: sources.open }
    );
    const progress = (line: number, delta: string) => ({
      data: { delta, kind: "text", partId: "part" },
      line,
      type: "content.delta",
    });
    store.select("assistant");
    sources.last("assistant").emit("progress", progress(1, "Hel"));
    store.pauseStreams();
    store.resumeStreams();
    const resumed = sources.last("assistant");
    resumed.emit("progress", progress(1, "Hel"));
    resumed.emit("progress", progress(2, "lo"));
    resumed.emit("progress", progress(2, "lo"));
    expect(store.getState().bots.assistant.deltas.get("part")).toBe("Hello");
    resumed.emit("session", { sessionId: "next" });
    resumed.emit("progress", progress(1, "New session"));
    expect(store.getState().bots.assistant.deltas.get("part")).toBe(
      "New session"
    );
  });

  it("closes live sources, blocks retries while paused and resumes only surviving conversations", () => {
    vi.useFakeTimers();
    try {
      const sources = fakeEventSource();
      const working = row(0, "turn.started", { turnId: "working" });
      const store = createChatStore(
        [
          { ...bot, rows: [working], status: "ready" },
          { ...bot, rows: [working], slug: "other", status: "ready" },
        ],
        { fetch: vi.fn(), open: sources.open }
      );
      store.select("assistant");
      store.select("other");
      store.select("assistant");
      sources.last("assistant").fail();
      store.pauseStreams();
      expect(sources.live()).toHaveLength(0);
      vi.advanceTimersByTime(1000);
      expect(sources.opened()).toHaveLength(2);
      store.removeBot("other");
      store.resumeStreams();
      store.resumeStreams();
      store.select("assistant");
      expect(sources.live("assistant")).toHaveLength(1);
      expect(sources.opened("assistant")).toHaveLength(2);
      expect(sources.live("other")).toHaveLength(0);
      expect(store.getState().bots.assistant.rows).toEqual([working]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not open a source from a late deployment response after leaving chat", () => {
    const sources = fakeEventSource();
    const store = createChatStore([bot], {
      fetch: vi.fn(),
      open: sources.open,
    });
    store.pauseStreams();
    store.upsertBot({ ...bot, status: "ready" });
    expect(sources.opened()).toHaveLength(0);
    store.resumeStreams();
    store.select("assistant");
    expect(sources.live("assistant")).toHaveLength(1);
  });
});

describe("deferred archived conversations", () => {
  it("loads once on request, deduplicates clicks, and keeps current rows", async () => {
    const response = deferred<Response>();
    const fetcher = vi.fn(() => response.promise);
    const current = row(99, "turn.settled", { turnId: "current" });
    const store = createChatStore(
      [{ ...bot, pastLoaded: false, rows: [current], sessionId: "current" }],
      { fetch: fetcher as typeof fetch, open: vi.fn() }
    );
    expect(fetcher).not.toHaveBeenCalled();
    const first = store.loadPast("assistant");
    await store.loadPast("assistant");
    expect(fetcher).toHaveBeenCalledTimes(1);
    response.resolve(
      Response.json({
        past: [{ rows: [], sessionId: "old" }],
        sessionId: "current",
      })
    );
    await first;
    await store.loadPast("assistant");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.getState().bots.assistant).toMatchObject({
      lastLine: 99,
      past: [{ rows: [], sessionId: "old" }],
      pastStatus: "ready",
      rows: [current],
    });
  });

  it("bootstraps archived sessions without consuming the active history cursor", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        nextCursor: {
          sessionId: "older",
          startedAt: "2026-01-01T00:00:00.000Z",
        },
        past: [{ rows: [], sessionId: "newer" }],
        sessionId: "current",
      })
    );
    const store = createChatStore(
      [
        {
          ...bot,
          historyCursor: { index: 0, line: 100 },
          historyHasMore: true,
          pastLoaded: false,
          sessionId: "current",
        },
      ],
      { fetch: fetcher as typeof fetch, open: vi.fn() }
    );

    await store.loadPast("assistant");

    expect(fetcher).toHaveBeenCalledWith("/api/bots/assistant/past-sessions", {
      cache: "no-store",
    });
    expect(store.getState().bots.assistant).toMatchObject({
      historyCursor: { index: 0, line: 100 },
      historyHasMore: true,
      past: [{ sessionId: "newer" }],
      pastStatus: "ready",
    });
  });

  it("allows retry after a failed load", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ past: [], sessionId: null }));
    const store = createChatStore([{ ...bot, pastLoaded: false }], {
      fetch: fetcher,
      open: vi.fn(),
    });
    await store.loadPast("assistant");
    expect(store.getState().bots.assistant?.pastStatus).toBe("error");
    await store.loadPast("assistant");
    expect(store.getState().bots.assistant?.pastStatus).toBe("ready");
  });

  it("loads older archived pages with the returned cursor and prepends them", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          nextCursor: {
            sessionId: "older",
            startedAt: "2026-01-01T00:00:00.000Z",
          },
          past: [{ rows: [], sessionId: "newer" }],
          sessionId: "current",
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          nextCursor: null,
          past: [{ rows: [], sessionId: "older" }],
          sessionId: "current",
        })
      );
    const store = createChatStore(
      [{ ...bot, pastLoaded: false, sessionId: "current" }],
      {
        fetch: fetcher as typeof fetch,
        open: vi.fn(),
      }
    );
    await store.loadPast("assistant");
    expect(store.getState().bots.assistant).toMatchObject({
      past: [{ sessionId: "newer" }],
      pastHasMore: true,
    });
    await store.loadPast("assistant");
    expect(fetcher).toHaveBeenLastCalledWith(
      expect.stringContaining("before=%7B%22sessionId%22%3A%22older%22"),
      { cache: "no-store" }
    );
    expect(store.getState().bots.assistant).toMatchObject({
      past: [{ sessionId: "older" }, { sessionId: "newer" }],
      pastHasMore: false,
    });
  });

  it("drains an archive session's older facts before requesting older sessions", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          historyCursor: null,
          historyHasMore: false,
          historySessionId: "old",
          rows: [row(1, "delivery.consumed")],
          sessionId: "current",
        })
      )
      .mockResolvedValueOnce(Response.json({ past: [], sessionId: "current" }));
    const store = createChatStore(
      [
        {
          ...bot,
          past: [
            {
              historyCursor: { index: 0, line: 100 },
              historyHasMore: true,
              rows: [row(100, "turn.settled")],
              sessionId: "old",
            },
          ],
          pastHasMore: true,
          pastLoaded: true,
          sessionId: "current",
        },
      ],
      { fetch: fetcher, open: vi.fn() }
    );
    await store.loadPast("assistant");
    expect(fetcher).toHaveBeenLastCalledWith(
      expect.stringContaining(
        "/snapshot?archive=old&before=%7B%22index%22%3A0%2C%22line%22%3A100%7D&session=current"
      ),
      { cache: "no-store" }
    );
    expect(store.getState().bots.assistant).toMatchObject({
      past: [
        {
          historyHasMore: false,
          rows: [
            expect.objectContaining({ line: 1 }),
            expect.objectContaining({ line: 100 }),
          ],
        },
      ],
      pastHasMore: true,
    });
    await store.loadPast("assistant");
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/bots/assistant/past-sessions",
      { cache: "no-store" }
    );
    expect(store.getState().bots.assistant?.pastHasMore).toBe(false);
  });

  it("loads an older active-session window without moving the live cursor", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        historyCursor: { index: 0, line: 1 },
        historyHasMore: false,
        rows: [row(1, "turn.started", { turnId: "older" })],
        sessionId: "current",
      })
    );
    const store = createChatStore(
      [
        {
          ...bot,
          historyCursor: { index: 0, line: 100 },
          historyHasMore: true,
          rows: [row(100, "turn.settled", { turnId: "current" })],
          sessionId: "current",
          snapshotLoaded: true,
          status: "ready",
        },
      ],
      { fetch: fetcher as typeof fetch, open: vi.fn() }
    );
    await store.loadEarlier("assistant");
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining(
        "/snapshot?session=current&before=%7B%22index%22%3A0%2C%22line%22%3A100"
      ),
      { cache: "no-store" }
    );
    expect(store.getState().bots.assistant).toMatchObject({
      historyHasMore: false,
      historyStatus: "ready",
      lastLine: 100,
      rows: [
        expect.objectContaining({ line: 1 }),
        expect.objectContaining({ line: 100 }),
      ],
    });
  });

  it("prioritizes the active history frontier before archived sessions", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        historyCursor: null,
        historyHasMore: false,
        rows: [row(1, "turn.started")],
        sessionId: "current",
      })
    );
    const store = createChatStore(
      [
        {
          ...bot,
          historyCursor: { index: 0, line: 100 },
          historyHasMore: true,
          pastHasMore: true,
          pastLoaded: true,
          rows: [row(100, "turn.settled")],
          sessionId: "current",
          snapshotLoaded: true,
          status: "ready",
        },
      ],
      { fetch: fetcher as typeof fetch, open: vi.fn() }
    );
    await store.loadEarlier("assistant");
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining(
        "/snapshot?session=current&before=%7B%22index%22%3A0%2C%22line%22%3A100"
      ),
      { cache: "no-store" }
    );
    expect(store.getState().bots.assistant?.historyHasMore).toBe(false);
  });

  it("preserves live session rotation when an older snapshot arrives late", async () => {
    const response = deferred<Response>();
    const streams = fakeEventSource();
    const current = row(99, "turn.settled", { turnId: "current" });
    const store = createChatStore(
      [
        {
          ...bot,
          pastLoaded: false,
          rows: [current],
          sessionId: "current",
          status: "ready",
        },
      ],
      {
        fetch: vi.fn(() => response.promise) as typeof fetch,
        open: streams.open,
      }
    );
    store.select("assistant");
    const request = store.loadPast("assistant");
    streams.last("assistant").emit("session", { sessionId: "next" });
    response.resolve(Response.json({ past: [], sessionId: "current" }));
    await request;
    expect(store.getState().bots.assistant).toMatchObject({
      past: [{ rows: [current], sessionId: "current" }],
      pastStatus: "idle",
      sessionId: "next",
    });
  });
});

describe("conversation snapshots", () => {
  it("does not publish unchanged session announcements or duplicate facts", () => {
    const streams = fakeEventSource();
    const store = createChatStore(
      [{ ...bot, sessionId: "current", status: "ready" }],
      { fetch: vi.fn(), open: streams.open }
    );
    store.select("assistant");
    const changed = vi.fn();
    store.subscribe(changed);
    streams.last("assistant").emit("session", { sessionId: "current" });
    expect(changed).not.toHaveBeenCalled();
    const fact = row(1, "turn.started", { turnId: "live" });
    streams.last("assistant").emit("fact", fact);
    const state = store.getState();
    streams.last("assistant").emit("fact", fact);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(store.getState()).toBe(state);
  });

  it("reconnects a rotated snapshot and ignores a late error from the old stream", async () => {
    const response = deferred<Response>();
    const streams = fakeEventSource();
    const store = createChatStore(
      [
        {
          ...bot,
          sessionId: "current",
          snapshotLoaded: false,
          status: "ready",
        },
      ],
      {
        fetch: vi.fn(() => response.promise) as typeof fetch,
        open: streams.open,
      }
    );
    const loading = store.preload("assistant");
    store.select("assistant");
    const old = streams.last("assistant");
    response.resolve(
      Response.json({
        consults: [],
        rows: [row(0, "turn.started")],
        sessionId: "next",
      })
    );
    await loading;
    expect(old.closed).toBe(true);
    expect(streams.opened()).toHaveLength(2);
    old.fail();
    store.select("assistant");
    expect(streams.opened()).toHaveLength(2);
    expect(streams.last("assistant").url).toContain("session=next");
  });

  it("waits for the rotated snapshot watermark before reconnecting SSE", async () => {
    const snapshot = deferred<Response>();
    const streams = fakeEventSource();
    const fetcher = vi.fn(() => snapshot.promise);
    const store = createChatStore(
      [
        {
          ...bot,
          rows: [row(4, "turn.settled")],
          sessionId: "current",
          status: "ready",
        },
      ],
      { fetch: fetcher as typeof fetch, open: streams.open }
    );
    store.select("assistant");
    const old = streams.last("assistant");
    old.emit("session", { sessionId: "next" });
    old.fail();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(streams.opened()).toHaveLength(1);
    snapshot.resolve(
      Response.json({
        consults: [],
        resumeAfter: 10,
        rows: [row(9, "turn.started")],
        sessionId: "next",
      })
    );
    await vi.waitFor(() => expect(streams.opened()).toHaveLength(2));
    expect(streams.last("assistant").url).toContain("after=9");
  });

  it("does not reconnect from a stale rotated snapshot after streams are paused", async () => {
    const snapshot = deferred<Response>();
    const streams = fakeEventSource();
    const store = createChatStore(
      [{ ...bot, sessionId: "current", status: "ready" }],
      {
        fetch: vi.fn(() => snapshot.promise) as typeof fetch,
        open: streams.open,
      }
    );
    store.select("assistant");
    const old = streams.last("assistant");
    old.emit("session", { sessionId: "next" });
    old.fail();
    store.pauseStreams();
    snapshot.resolve(
      Response.json({
        consults: [],
        resumeAfter: 10,
        rows: [row(9, "turn.started")],
        sessionId: "next",
      })
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(streams.opened()).toHaveLength(1);
  });

  it("preloads once, merges concurrent live rows and preserves the cursor", async () => {
    const response = deferred<Response>();
    const fetcher = vi.fn(() => response.promise);
    const streams = fakeEventSource();
    const preview = row(99, "turn.settled", { turnId: "old" });
    const live = row(100, "turn.started", { turnId: "live" });
    const store = createChatStore(
      [
        {
          ...bot,
          rows: [preview],
          sessionId: "current",
          snapshotLoaded: false,
          status: "ready",
        },
      ],
      { fetch: fetcher as typeof fetch, open: streams.open }
    );
    store.preload("assistant");
    expect(streams.opened()).toHaveLength(0);
    store.select("assistant");
    streams.last("assistant").emit("fact", live);
    expect(fetcher).toHaveBeenCalledTimes(1);
    response.resolve(
      Response.json({
        consults: [],
        rows: [
          row(98, "content.completed", {
            kind: "text",
            value: "Previous response",
          }),
          preview,
        ],
        sessionId: "current",
      })
    );
    await response.promise;
    await vi.waitFor(() =>
      expect(store.getState().bots.assistant?.snapshotStatus).toBe("ready")
    );
    expect(store.getState().bots.assistant?.rows.map((r) => r.line)).toEqual([
      98, 99, 100,
    ]);
    expect(store.getState().bots.assistant?.lastLine).toBe(100);
  });

  it("does not restore an old snapshot or archive an incomplete preview after a live rotation", async () => {
    const response = deferred<Response>();
    const streams = fakeEventSource();
    const store = createChatStore(
      [
        {
          ...bot,
          pastLoaded: false,
          rows: [row(99, "turn.settled")],
          sessionId: "current",
          snapshotLoaded: false,
          status: "ready",
        },
      ],
      {
        fetch: vi.fn(() => response.promise) as typeof fetch,
        open: streams.open,
      }
    );
    store.select("assistant");
    streams.last("assistant").emit("session", { sessionId: "next" });
    response.resolve(
      Response.json({
        consults: [],
        rows: [row(99, "turn.settled")],
        sessionId: "current",
      })
    );
    await response.promise;
    await Promise.resolve();
    expect(store.getState().bots.assistant).toMatchObject({
      past: [],
      rows: [],
      sessionId: "next",
      snapshotStatus: "ready",
    });
  });

  it("retries a failed snapshot and adopts a newer server session", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          consults: [],
          resumeAfter: 1,
          rows: [row(0, "turn.started")],
          sessionId: "next",
        })
      );
    const store = createChatStore(
      [{ ...bot, sessionId: "current", snapshotLoaded: false }],
      { fetch: fetcher, open: vi.fn() }
    );
    await store.loadSnapshot("assistant");
    expect(store.getState().bots.assistant?.snapshotStatus).toBe("error");
    await store.loadSnapshot("assistant");
    expect(store.getState().bots.assistant).toMatchObject({
      lastLine: 0,
      sessionId: "next",
      snapshotStatus: "ready",
    });
  });
});

describe("chat browser context", () => {
  it("sends the browser time zone and repeats the same context on retry", async () => {
    const requests: RequestInit[] = [];
    const fetcher = vi.fn((_url: string, init?: RequestInit) => {
      requests.push(init ?? {});
      return Promise.resolve(
        requests.length === 1
          ? new Response("temporary", { status: 502 })
          : Response.json({ deliveryId: "delivery-1" })
      );
    });
    const store = createChatStore([bot], {
      fetch: fetcher as typeof fetch,
      open: vi.fn(),
    });
    const expected = Intl.DateTimeFormat().resolvedOptions().timeZone;

    await store.send("assistant", {
      files: [],
      id: "11111111-1111-4111-8111-111111111111",
      text: "Create a routine.",
    });

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const body = JSON.parse(String(request.body)) as Record<string, unknown>;
      expect(body.clientContext).toEqual({ timeZone: expected });
      expect(body.text).toBe("Create a routine.");
    }
  });

  it("does not immediately retry a rate-limited delivery and keeps it for an explicit retry", async () => {
    const requests: RequestInit[] = [];
    const fetcher = vi.fn((_url: string, init?: RequestInit) => {
      requests.push(init ?? {});
      return Promise.resolve(
        requests.length === 1
          ? Response.json({ code: "provider_rate_limited" }, { status: 429 })
          : Response.json({ deliveryId: "delivery-2" })
      );
    });
    const store = createChatStore([bot], {
      fetch: fetcher as typeof fetch,
      open: vi.fn(),
    });
    const id = "33333333-3333-4333-8333-333333333333";

    await store.send("assistant", {
      files: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          name: "notes.txt",
        },
      ],
      id,
      text: "Try this later.",
    });

    expect(requests).toHaveLength(1);
    expect(store.getState().bots.assistant?.pending[0]?.failed).toBe(true);
    expect(store.getState().bots.assistant?.pending[0]?.issue?.code).toBe(
      "provider_rate_limited"
    );

    expect(await store.retry("assistant", id)).toBe(true);
    expect(requests).toHaveLength(2);
    const retried = JSON.parse(String(requests[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(retried.fileIds).toEqual(["44444444-4444-4444-8444-444444444444"]);
    expect(retried.id).toBe(id);
    expect(retried.clientContext).toEqual(
      JSON.parse(String(requests[0]?.body)).clientContext
    );
    expect(retried.text).toBe("Try this later.");
  });

  it("maps an empty proxy 401 to Busy sign-in without retrying it", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(new Response("session expired", { status: 401 }))
    );
    const store = createChatStore([bot], {
      fetch: fetcher as typeof fetch,
      open: vi.fn(),
    });

    await store.send("assistant", {
      files: [],
      id: "66666666-6666-4666-8666-666666666666",
      text: "Needs sign-in",
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.getState().bots.assistant?.pending[0]?.issue?.code).toBe(
      "unauthorized"
    );
  });

  it("claims a failed item before retrying so rapid clicks do not duplicate the POST", async () => {
    const responses = [
      new Response("busy", { status: 429 }),
      Response.json({ deliveryId: "delivery-3" }),
    ];
    const fetcher = vi.fn(() =>
      Promise.resolve(
        responses.shift() ?? new Response("missing", { status: 500 })
      )
    );
    const store = createChatStore([bot], {
      fetch: fetcher as typeof fetch,
      open: vi.fn(),
    });
    const id = "77777777-7777-4777-8777-777777777777";

    await store.send("assistant", { files: [], id, text: "Retry once" });
    const [first, second] = await Promise.all([
      store.retry("assistant", id),
      store.retry("assistant", id),
    ]);

    expect([first, second].toSorted()).toEqual([false, true]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(store.getState().bots.assistant?.pending).toEqual([
      expect.objectContaining({
        deliveryId: "delivery-3",
        failed: false,
        id,
      }),
    ]);
  });
});

test("reports send, ack and first visible text to RUM without message content", async () => {
  const sources = fakeEventSource();
  const rum = { ack: vi.fn(), firstText: vi.fn(), send: vi.fn() };
  const store = createChatStore(
    [{ ...bot, sessionId: "current", status: "ready" }],
    {
      fetch: vi.fn(() =>
        Promise.resolve(Response.json({ deliveryId: "delivery-rum" }))
      ) as unknown as typeof fetch,
      open: sources.open,
      rum,
    }
  );
  store.select("assistant");
  await store.send("assistant", {
    files: [],
    id: "55555555-5555-4555-8555-555555555555",
    text: "secret text",
  });
  expect(rum.send).toHaveBeenCalledWith("assistant");
  expect(rum.ack).toHaveBeenCalledWith("assistant", true);
  sources.last("assistant").emit("progress", {
    data: { delta: "thinking", kind: "reasoning", partId: "r" },
    type: "content.delta",
  });
  expect(rum.firstText).not.toHaveBeenCalled();
  sources.last("assistant").emit("progress", {
    data: { delta: "Hi", kind: "text", partId: "t" },
    type: "content.delta",
  });
  expect(rum.firstText).toHaveBeenCalledWith("assistant");
  expect(JSON.stringify(rum.send.mock.calls)).not.toContain("secret");
});

test("warms a bot at most once every two minutes", () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  const store = createChatStore([bot], { fetch, open: vi.fn() });
  store.warm("assistant", 1000);
  store.warm("assistant", 60_000);
  store.warm("other", 60_000);
  store.warm("assistant", 121_000);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "/api/bots/assistant/warm",
    "/api/bots/other/warm",
    "/api/bots/assistant/warm",
  ]);
});

describe("fast replies", () => {
  const id = "44444444-4444-4444-8444-444444444444";
  const ndjson = (lines: unknown[]) =>
    new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(""), {
      headers: { "content-type": "application/x-ndjson" },
    });
  const opening = [
    { fact: row(7, "delivery.consumed", { deliveryId: `fast:${id}` }, 10) },
    { fact: row(7, "turn.started", { turnId: `fast-${id}` }, 11) },
    {
      progress: {
        data: { delta: "Hi", kind: "text", partId: "p" },
        type: "content.delta",
      },
    },
  ];
  const ready = { ...bot, sessionId: "s", status: "ready" as const };

  it("applies the streamed facts and drops the pending message", async () => {
    const store = createChatStore([ready], {
      fetch: vi.fn(() =>
        Promise.resolve(
          ndjson([
            ...opening,
            { fact: row(7, "turn.settled", { outcome: "completed" }, 13) },
            { deliveryId: `fast:${id}` },
          ])
        )
      ) as unknown as typeof fetch,
      open: fakeEventSource().open,
    });
    await store.send("assistant", { files: [], id, text: "hola" });
    const b = store.getState().bots.assistant;
    expect(b?.pending).toEqual([]);
    expect(b?.rows.map((r) => r.type)).toEqual([
      "delivery.consumed",
      "turn.started",
      "turn.settled",
    ]);
  });

  it("keeps an ack: The user's message once, above it, still working until eve settles", async () => {
    const sources = fakeEventSource();
    const consumedBy = (deliveryId: string) =>
      row(7, "delivery.consumed", {
        deliveryId,
        parts: [{ kind: "text", text: "buscá vuelos" }],
      });
    const ack = {
      ...row(7, "content.completed", {
        kind: "text",
        partId: "p",
        phase: "reply",
        value: "Hi",
      }),
      index: 12,
    };
    const store = createChatStore([ready], {
      fetch: vi.fn(() =>
        Promise.resolve(
          ndjson([
            { fact: { ...consumedBy(`fast:${id}`), index: 10 } },
            ...opening.slice(1),
            // Stored under eve's id: same keys, so they replace what was shown.
            { fact: { ...consumedBy("delivery-9"), index: 10 } },
            opening[1],
            { fact: ack },
            { deliveryId: "delivery-9" },
          ])
        )
      ) as unknown as typeof fetch,
      open: sources.open,
    });
    store.select("assistant");
    await store.send("assistant", { files: [], id, text: "buscá vuelos" });
    const view = () => {
      const b = store.getState().bots.assistant;
      if (!b) {
        throw new Error("no bot");
      }
      const v = toChatView(b.rows, b.deltas, new Map());
      return {
        items: v.items.map((i) => [i.kind, "text" in i ? i.text : ""]),
        wait: waitStage(b.rows, b.pending, v.working),
        working: v.working,
      };
    };
    expect(store.getState().bots.assistant?.pending).toEqual([]);
    expect(view()).toEqual({
      items: [
        ["user", "buscá vuelos"],
        ["bot", "Hi"],
      ],
      wait: { id: "turn", stage: "thinking" },
      working: true,
    });

    // eve takes the same delivery on a later line: no second bubble, the ack stays on top.
    const source = sources.last("assistant");
    source.emit("fact", { ...consumedBy("delivery-9"), index: 0, line: 8 });
    source.emit("fact", row(8, "turn.started", { turnId: "t" }, 1));
    source.emit(
      "fact",
      row(9, "content.completed", {
        kind: "text",
        partId: "r",
        phase: "reply",
        value: "Found 3.",
      })
    );
    source.emit("fact", row(9, "turn.settled", { turnId: "t" }, 1));
    const done = view();
    expect(done).toEqual({
      items: [
        ["user", "buscá vuelos"],
        ["bot", "Hi"],
        ["bot", "Found 3."],
      ],
      wait: null,
      working: false,
    });
    // A reload reads the same rows from the snapshot, in stored order.
    const stored = store.getState().bots.assistant?.rows ?? [];
    expect(
      toChatView(stored.toReversed(), new Map(), new Map()).items.map((i) => [
        i.kind,
        "text" in i ? i.text : "",
      ])
    ).toEqual(done.items);
  });

  it("retracts a dropped draft and waits for the bot's delivery", async () => {
    const store = createChatStore([ready], {
      fetch: vi.fn(() =>
        Promise.resolve(
          ndjson([...opening, { retract: true }, { deliveryId: "delivery-9" }])
        )
      ) as unknown as typeof fetch,
      open: fakeEventSource().open,
    });
    await store.send("assistant", { files: [], id, text: "hola" });
    const b = store.getState().bots.assistant;
    expect(b?.rows).toEqual([]);
    expect(b?.deltas.size).toBe(0);
    expect(b?.pending).toMatchObject([
      { deliveryId: "delivery-9", id, text: "hola" },
    ]);
  });
});

test("a bot's first session does not offer earlier conversations", () => {
  const streams = fakeEventSource();
  const store = createChatStore([{ ...bot, status: "ready" }], {
    fetch: vi.fn(),
    open: streams.open,
  });
  store.select("assistant");
  streams.last("assistant").emit("session", { sessionId: "first" });
  expect(store.getState().bots.assistant).toMatchObject({
    historyHasMore: false,
    pastHasMore: false,
    pastStatus: "ready",
    sessionId: "first",
  });
});

describe("pending messages and durable evidence (H-22)", () => {
  const ready = {
    ...bot,
    sessionId: "s",
    snapshotLoaded: false,
    status: "ready" as const,
  };
  const first = "55555555-5555-4555-8555-555555555555";
  const second = "66666666-6666-4666-8666-666666666666";

  it("a snapshot settles only the pending message whose consumption it carries", async () => {
    const http = fakeFetch();
    http.enqueue(ok({ deliveryId: "d-9" }), ok({ deliveryId: "d-10" }));
    const store = createChatStore([ready], {
      fetch: http.fetch,
      open: fakeEventSource().open,
    });
    await store.send("assistant", { files: [], id: first, text: "one" });
    await store.send("assistant", { files: [], id: second, text: "two" });
    http.enqueue(
      ok({
        consults: [],
        rows: [
          row(3, "delivery.consumed", { deliveryId: "d-9" }),
          // Admission alone is not consumption: the second one stays pending.
          row(4, "delivery.admitted", { deliveryId: "d-10" }),
        ],
        sessionId: "s",
      })
    );
    await store.loadSnapshot("assistant");
    expect(store.getState().bots.assistant?.pending).toMatchObject([
      { deliveryId: "d-10", id: second },
    ]);
  });

  it("keeps an old pending message across a session rotation", async () => {
    const http = fakeFetch();
    http.enqueue(ok({ deliveryId: "d-9" }));
    const streams = fakeEventSource();
    const store = createChatStore([{ ...ready, snapshotLoaded: true }], {
      fetch: http.fetch,
      open: streams.open,
    });
    store.select("assistant");
    await store.send("assistant", { files: [], id: first, text: "one" });
    streams.last("assistant").emit("session", { sessionId: "next" });
    expect(store.getState().bots.assistant?.pending).toMatchObject([
      { deliveryId: "d-9", id: first },
    ]);
  });

  it("a fast stream cut before its final line is uncertain, then reconciled once", async () => {
    const http = fakeFetch();
    const cut = new Response(
      `${JSON.stringify({
        progress: {
          data: { delta: "Hi", kind: "text", partId: "p" },
          type: "content.delta",
        },
      })}\n`,
      { headers: { "content-type": "application/x-ndjson" } }
    );
    const answer = deferred<Response>();
    http.enqueue(
      () => Promise.resolve(cut),
      () => answer.promise
    );
    const store = createChatStore([ready], {
      fetch: http.fetch,
      open: fakeEventSource().open,
    });
    const sending = store.send("assistant", {
      files: [],
      id: first,
      text: "hola",
    });
    await vi.waitFor(() => expect(http.calls).toHaveLength(2));
    // While the hub is asked, the message is still on its way, not failed.
    expect(store.getState().bots.assistant?.pending).toMatchObject([
      { id: first, uncertain: true },
    ]);
    expect(store.getState().bots.assistant?.pending[0]?.failed).toBeFalsy();
    expect(http.calls[1]?.url).toContain("?reconcile=1");
    expect(JSON.parse(String(http.calls[1]?.init?.body)).id).toBe(first);
    answer.resolve(Response.json({ deliveryId: "d-1" }));
    await sending;
    expect(store.getState().bots.assistant?.pending).toEqual([
      expect.objectContaining({ deliveryId: "d-1", failed: false, id: first }),
    ]);
    // The stored consumption then settles it: one delivery, never a retry prompt.
    http.enqueue(
      ok({
        consults: [],
        rows: [row(5, "delivery.consumed", { deliveryId: "d-1" })],
        sessionId: "s",
      })
    );
    await store.loadSnapshot("assistant");
    expect(store.getState().bots.assistant?.pending).toEqual([]);
    expect(http.calls.filter((c) => c.url.includes("/messages"))).toHaveLength(
      2
    );
  });
});

test("a settled peer call refreshes consultations, so its divider opens the thread", async () => {
  vi.useFakeTimers();
  const streams = fakeEventSource();
  const fetch = vi.fn(async () =>
    Response.json([{ callId: "call-1", id: "c1", peerName: "Editor" }])
  );
  const store = createChatStore(
    [{ ...bot, sessionId: "current", status: "ready" }],
    { fetch, open: streams.open }
  );
  store.select("assistant");
  streams.last("assistant").emit("fact", {
    ...row(1, "call.settled", { callId: "call-1" }),
    data: {
      data: { callId: "call-1" },
      scope: { taskId: "peer-2-abc" },
      type: "call.settled",
    },
  });
  await vi.advanceTimersByTimeAsync(1500);
  vi.useRealTimers();
  expect(fetch).toHaveBeenCalledWith("/api/bots/assistant/consultations");
  expect(store.getState().bots.assistant.consults.get("call-1")?.id).toBe("c1");
});
