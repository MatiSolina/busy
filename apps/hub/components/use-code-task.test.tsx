// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useCodeTask } from "@/components/use-code-task";
import type { PublicCodeEvent, PublicCodeTask } from "@/lib/code-tasks/types";

interface TestCall {
  body: unknown;
  method: string;
  path: string;
  url: string;
}
type TestAnswer = (call: TestCall) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return {
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

function testServer() {
  const calls: TestCall[] = [];
  const streams: string[] = [];
  const routes = new Map<string, TestAnswer>();
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const [path = ""] = url.split("?");
    const call = {
      body: init?.body,
      method: (init?.method ?? "GET").toUpperCase(),
      path,
      url,
    };
    calls.push(call);
    const answer = routes.get(`${call.method} ${call.path}`);
    return answer ? answer(call) : json({ error: "Not found" }, 404);
  });
  vi.stubGlobal("fetch", fetch);
  class FakeEventSource {
    readonly url: string;
    onerror: (() => void) | null = null;

    constructor(url: string) {
      this.url = url;
      streams.push(url);
    }

    // biome-ignore lint/style/useThisInClassMethods: EventSource test double has no instance event registry.
    addEventListener() {
      // No stream events are needed by these snapshot polling tests.
    }

    // biome-ignore lint/style/useThisInClassMethods: EventSource test double has no instance cleanup state.
    close() {
      // The hook only needs the close contract for cleanup.
    }
  }
  vi.stubGlobal("EventSource", FakeEventSource);
  return {
    calls,
    on(method: string, path: string, answer: TestAnswer) {
      routes.set(`${method} ${path}`, answer);
    },
    streams,
  };
}

function held() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((nextResolve) => {
    resolve = nextResolve;
  });
  return { answer: () => promise, resolve };
}

const task: PublicCodeTask = {
  agentName: null,
  appliedInstructionVersion: 1,
  billing: "gateway",
  botId: "bot-1",
  branch: "codex/task-1",
  commitSha: "commit-1",
  createdAt: "2026-11-03T12:00:00.000Z",
  durableSessionId: "session-1",
  error: null,
  execution: {},
  finishedAt: "2026-11-03T12:10:00.000Z",
  goal: "Keep the redirect query string.",
  id: "task-1",
  instructionVersion: 1,
  lastStreamCursor: 0,
  model: "openai/gpt-6.1-sol",
  phase: null,
  prUrl: "https://github.com/acme/app/pull/1",
  repository: {
    baseBranch: "main",
    fullName: "acme/app",
    id: "repo-1",
  },
  revision: 1,
  status: "ready",
  summary: "Draft pull request is ready.",
  title: "Fix the login redirect",
  updatedAt: "2026-11-03T12:10:00.000Z",
};

function event(seq: number, taskId = task.id): PublicCodeEvent {
  return {
    createdAt: "2026-11-03T12:00:00.000Z",
    data: { message: `Event ${seq}` },
    revision: 1,
    seq,
    taskId,
    type: "agent.working",
  };
}

function Probe({ open, taskId }: { open: boolean; taskId: string | null }) {
  const result = useCodeTask({ open, taskId });
  return (
    <div>
      <output data-testid="task-title">{result.task?.title ?? "empty"}</output>
      <output data-testid="event-count">{result.events.length}</output>
      <output data-testid="last-event">
        {result.events.at(-1)?.seq ?? "none"}
      </output>
      <output data-testid="usage-status">
        {result.task?.usage?.costStatus ?? "none"}
      </output>
      {result.error ? <p role="alert">{result.error}</p> : null}
    </div>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("loads and deduplicates terminal history across detail pages", async () => {
  const server = testServer();
  const firstPage = Array.from({ length: 500 }, (_, index) => event(index + 1));
  const secondPage = [
    event(500),
    ...Array.from({ length: 100 }, (_, index) => event(index + 501)),
  ];
  server.on("GET", "/api/code-tasks/task-1", (call) => {
    const after = new URL(call.url, "https://busy.test").searchParams.get(
      "after"
    );
    return json(
      after === "500"
        ? { events: secondPage, hasMoreEvents: false, task }
        : { events: firstPage, hasMoreEvents: true, task }
    );
  });

  render(<Probe open taskId="task-1" />);

  await waitFor(() => {
    expect(screen.getByTestId("event-count")).toHaveProperty(
      "textContent",
      "600"
    );
  });
  expect(screen.getByTestId("last-event")).toHaveProperty("textContent", "600");
  expect(
    server.calls
      .filter(
        (call) =>
          call.method === "GET" && call.path === "/api/code-tasks/task-1"
      )
      .map((call) =>
        new URL(call.url, "https://busy.test").searchParams.get("after")
      )
  ).toEqual([null, "500"]);
});

test("ignores a stale snapshot after switching to another task", async () => {
  const server = testServer();
  const first = held();
  server.on("GET", "/api/code-tasks/task-1", first.answer);
  server.on("GET", "/api/code-tasks/task-2", () =>
    json({
      events: [],
      task: { ...task, id: "task-2", title: "Second task" },
    })
  );

  const view = render(<Probe open taskId="task-1" />);
  await waitFor(() => {
    expect(
      server.calls.filter(
        (call) =>
          call.method === "GET" && call.path === "/api/code-tasks/task-1"
      )
    ).toHaveLength(1);
  });
  view.rerender(<Probe open taskId="task-2" />);
  await waitFor(() => {
    expect(screen.getByTestId("task-title")).toHaveProperty(
      "textContent",
      "Second task"
    );
  });

  first.resolve(json({ events: [event(1, "task-1")], task }));
  await Promise.resolve();
  expect(screen.getByTestId("task-title")).toHaveProperty(
    "textContent",
    "Second task"
  );
  expect(screen.getByTestId("event-count")).toHaveProperty("textContent", "0");
});

test("refreshes pending cost usage without reopening the task stream", async () => {
  vi.useFakeTimers();
  const server = testServer();
  const pending = {
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costStatus: "pending" as const,
    costUsd: null,
    inputTokens: 100,
    outputTokens: 25,
    reasoningTokens: null,
    requests: 1,
  };
  const reported = {
    ...pending,
    costStatus: "reported" as const,
    costUsd: 0.0042,
  };
  server.on("GET", "/api/code-tasks/task-1", (call) => {
    const after = new URL(call.url, "https://busy.test").searchParams.get(
      "after"
    );
    return after === "0"
      ? json({
          events: [event(1)],
          hasMoreEvents: false,
          task: { ...task, usage: reported },
        })
      : json({
          events: [],
          hasMoreEvents: false,
          task: { ...task, usage: pending },
        });
  });

  render(<Probe open taskId="task-1" />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByTestId("usage-status")).toHaveProperty(
    "textContent",
    "pending"
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByTestId("usage-status")).toHaveProperty(
    "textContent",
    "reported"
  );
  expect(
    server.calls.map((call) =>
      new URL(call.url, "https://busy.test").searchParams.get("after")
    )
  ).toEqual([null, "0"]);
});

test("does not poll cost while an active task stream is running", async () => {
  vi.useFakeTimers();
  const server = testServer();
  const pending = {
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costStatus: "pending" as const,
    costUsd: null,
    inputTokens: 100,
    outputTokens: 25,
    reasoningTokens: null,
    requests: 1,
  };
  server.on("GET", "/api/code-tasks/task-1", () =>
    json({
      events: [],
      hasMoreEvents: false,
      task: { ...task, status: "running", usage: pending },
    })
  );

  render(<Probe open taskId="task-1" />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(server.calls).toHaveLength(1);
  expect(server.streams).toHaveLength(1);
});

test("reopens the stream when reconciliation moves a terminal task back to queued", async () => {
  vi.useFakeTimers();
  const server = testServer();
  const pending = {
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costStatus: "pending" as const,
    costUsd: null,
    inputTokens: 100,
    outputTokens: 25,
    reasoningTokens: null,
    requests: 1,
  };
  let initial = true;
  server.on("GET", "/api/code-tasks/task-1", (call) => {
    const after = new URL(call.url, "https://busy.test").searchParams.get(
      "after"
    );
    if (after === "0") {
      return json({
        events: [],
        hasMoreEvents: false,
        task: { ...task, status: "queued", usage: pending },
      });
    }
    const nextTask = {
      ...task,
      status: initial ? "ready" : "queued",
      usage: pending,
    };
    initial = false;
    return json({ events: [], hasMoreEvents: false, task: nextTask });
  });

  render(<Probe open taskId="task-1" />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(server.streams).toHaveLength(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(server.streams).toHaveLength(1);
  expect(server.streams[0]).toContain("stream=1");
});
