// @vitest-environment happy-dom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  CodeTaskDetail,
  type PublicCodeTask,
} from "@/components/code-task-panel";
import { InlineCodeTaskCard } from "@/components/inline-code-task-card";
import { installFakes, json } from "./components.test-helpers";

const task: PublicCodeTask = {
  agentName: null,
  appliedInstructionVersion: 1,
  billing: "gateway",
  botId: "bot-1",
  botSlug: "builder",
  branch: "codex/busy-task-1",
  commitSha: null,
  createdAt: "2026-11-02T12:00:00Z",
  durableSessionId: null,
  error: null,
  execution: {},
  finishedAt: null,
  goal: "Keep the redirect query string.",
  id: "task-1",
  instructionVersion: 1,
  lastStreamCursor: 0,
  model: "openai/gpt-6.1-sol",
  phase: "editing",
  prUrl: null,
  repository: {
    baseBranch: "main",
    fullName: "acme/app",
    id: "repo-1",
  },
  revision: 1,
  status: "running",
  summary: "Reading the auth flow",
  title: "Fix the login redirect",
  updatedAt: "2026-11-02T12:00:00Z",
};
const TASK_NAME = /fix the login redirect/iu;
const CHECKPOINT_DIFF_LINK = /latest diff.*src\/auth\.test\.ts/iu;
const DIFF_HEADER = /@@ -1 \+1 @@/u;

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
});

test("updates the selected task from its detail view instead of creating another task", async () => {
  const { server } = installFakes();
  server.on("GET", "/api/code-tasks/task-1", json({ events: [], task }));
  server.on("GET", "/api/code-tasks/task-1/events", json({}));
  server.on(
    "POST",
    "/api/code-tasks/task-1/commands",
    json({ command: { id: "command-1", status: "queued" } }, 202)
  );

  render(<InlineCodeTaskCard slug="builder" taskId="task-1" />);
  fireEvent.click(await screen.findByRole("button", { name: TASK_NAME }));
  const input = await screen.findByRole("textbox", {
    name: "Update code task",
  });
  fireEvent.change(input, {
    target: { value: "Also cover the callback query string." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send task update" }));

  await waitFor(() => {
    expect(server.to("POST", "/api/code-tasks/task-1/commands")).toHaveLength(
      1
    );
  });
  const [call] = server.to("POST", "/api/code-tasks/task-1/commands");
  expect(call?.body).toMatchObject({
    kind: "steer",
    text: "Also cover the callback query string.",
  });
  expect(server.to("POST", "/api/code-tasks")).toHaveLength(0);
});

test("opens a completed inline task directly on its result", async () => {
  const { server } = installFakes();
  const readyTask: PublicCodeTask = {
    ...task,
    phase: null,
    prUrl: "https://github.com/acme/app/pull/42",
    status: "ready",
    summary: "Verified and published the login fix.",
  };
  server.on(
    "GET",
    "/api/code-tasks/task-1",
    json({ events: [], task: readyTask })
  );

  render(<InlineCodeTaskCard slug="builder" taskId="task-1" />);
  fireEvent.click(await screen.findByRole("button", { name: TASK_NAME }));

  expect(
    (await screen.findByRole("tab", { name: "result" })).getAttribute(
      "aria-selected"
    )
  ).toBe("true");
  expect(
    (
      await screen.findByRole("link", { name: "Open draft pull request" })
    ).getAttribute("href")
  ).toBe(readyTask.prUrl);
  expect(server.to("POST", "/api/code-tasks")).toHaveLength(0);
});

test("does not show another bot's task in the conversation", async () => {
  const { server } = installFakes();
  server.on(
    "GET",
    "/api/code-tasks/task-1",
    json({
      task: { ...task, botSlug: "someone-else" },
    })
  );
  render(<InlineCodeTaskCard slug="builder" taskId="task-1" />);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Couldn't refresh this task."
  );
  expect(screen.queryByRole("button", { name: TASK_NAME })).toBeNull();
  expect(server.to("POST", "/api/code-tasks")).toHaveLength(0);
});

test("renders flat verification receipts and execution changes in the detail view", async () => {
  const { server, streams } = installFakes();
  const snapshot: PublicCodeTask = {
    ...task,
    execution: {
      checks: [
        {
          command: "pnpm test",
          digest: "workspace-123",
          exitCode: 0,
          instructionVersion: 1,
          output: "Tests passed",
        },
      ],
      diff: "@@ -1 +1 @@\n-old\n+new",
      files: ["src/auth.ts"],
    },
  };
  server.on(
    "GET",
    "/api/code-tasks/task-1",
    json({
      events: [
        {
          createdAt: "2026-11-02T12:01:00Z",
          data: {
            command: "pnpm test",
            digest: "workspace-123",
            exitCode: 0,
            instructionVersion: 1,
            output: "Tests passed",
          },
          revision: 1,
          seq: 1,
          taskId: "task-1",
          type: "verification",
        },
      ],
      task: snapshot,
    })
  );

  const view = render(<CodeTaskDetail open taskId="task-1" />);
  expect(
    await screen.findByRole("heading", { name: "Fix the login redirect" })
  ).toBeTruthy();
  expect(streams.all[0]?.url).toContain("after=1");

  fireEvent.click(screen.getByRole("tab", { name: "checks" }));
  expect((await screen.findAllByText("pnpm test")).length).toBeGreaterThan(0);
  expect((await screen.findAllByText("Tests passed")).length).toBeGreaterThan(
    0
  );

  fireEvent.click(screen.getByRole("tab", { name: "changes" }));
  expect(
    screen.getByRole("region", { name: "Diff for src/auth.ts" })
  ).toBeTruthy();
  expect(screen.getByText(DIFF_HEADER)).toBeTruthy();
  view.unmount();
});

test("renders a ready task result and uses its status when phase is empty", async () => {
  const { server } = installFakes();
  const commitSha = "178606f65fe58fef077a8b405a9149ee3747501d";
  const summary = "Draft PR published after verification.";
  const readyTask: PublicCodeTask = {
    ...task,
    commitSha,
    execution: {
      checks: [
        {
          command: "pnpm check",
          exitCode: 0,
          instructionVersion: 1,
          output: "ok",
        },
      ],
    },
    phase: null,
    prUrl: "https://github.com/MatiSolina/busy/pull/74",
    status: "ready",
    summary,
  };
  server.on(
    "GET",
    "/api/code-tasks/task-1",
    json({
      events: [
        {
          createdAt: "2026-11-03T21:26:00Z",
          data: {
            commitSha,
            pullRequestUrl: readyTask.prUrl,
            summary,
            verificationPassed: true,
          },
          revision: 1,
          seq: 2,
          taskId: "task-1",
          type: "task.ready",
        },
      ],
      task: readyTask,
    })
  );

  render(<CodeTaskDetail open taskId="task-1" />);
  expect(await screen.findByRole("heading", { name: TASK_NAME })).toBeTruthy();
  expect(screen.queryByText("Working")).toBeNull();
  expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);

  fireEvent.click(screen.getByRole("tab", { name: "result" }));
  expect(screen.queryByText("No result recorded yet.")).toBeNull();
  expect((await screen.findAllByText(summary)).length).toBeGreaterThan(0);
  expect(
    screen
      .getByRole("link", { name: "Open draft pull request" })
      .getAttribute("href")
  ).toBe(readyTask.prUrl);
  expect(screen.getByText(commitSha)).toBeTruthy();
});

test("renders a ready task without changes in the result tab", async () => {
  const { server } = installFakes();
  const summary = "No changes were needed.";
  const readyTask: PublicCodeTask = {
    ...task,
    commitSha: null,
    phase: null,
    prUrl: null,
    status: "ready",
    summary,
  };
  server.on(
    "GET",
    "/api/code-tasks/task-1",
    json({
      events: [],
      task: readyTask,
    })
  );

  render(<CodeTaskDetail open taskId="task-1" />);
  expect(await screen.findByRole("heading", { name: TASK_NAME })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "result" }));
  expect(screen.queryByText("No result recorded yet.")).toBeNull();
  expect((await screen.findAllByText(summary)).length).toBeGreaterThan(0);
});

test("renders a persisted ready PR result when stream events are absent", async () => {
  const { server } = installFakes();
  const summary = "Draft PR is ready for review.";
  const readyTask: PublicCodeTask = {
    ...task,
    commitSha: "commit-ready",
    phase: null,
    prUrl: "https://github.com/example/repo/pull/12",
    status: "ready",
    summary,
  };
  server.on(
    "GET",
    "/api/code-tasks/task-1",
    json({ events: [], task: readyTask })
  );

  render(<CodeTaskDetail open taskId="task-1" />);
  expect(await screen.findByRole("heading", { name: TASK_NAME })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "result" }));
  expect(screen.queryByText("No result recorded yet.")).toBeNull();
  expect(screen.getAllByText(summary).length).toBeGreaterThan(0);
  expect(
    screen
      .getByRole("link", { name: "Open draft pull request" })
      .getAttribute("href")
  ).toBe(readyTask.prUrl);
});

test("opens the task stream from cursor zero and reconnects after a dropped stream", async () => {
  const { server, streams } = installFakes();
  server.on("GET", "/api/code-tasks/task-1", json({ events: [], task }));

  const view = render(<CodeTaskDetail open taskId="task-1" />);
  await waitFor(() => expect(streams.all).toHaveLength(1));
  expect(streams.all[0]?.url).toContain("after=0");

  streams.all[0]?.onerror?.();
  await waitFor(
    () => {
      expect(streams.all).toHaveLength(2);
      expect(streams.all[1]?.url).toContain("after=0");
    },
    { timeout: 2500 }
  );
  expect(streams.all[0]?.closed).toBe(true);
  view.unmount();
});

test("keeps correction controls available for ready tasks", async () => {
  const { server } = installFakes();
  const readyTask: PublicCodeTask = { ...task, status: "ready" };
  server.on(
    "GET",
    "/api/code-tasks/task-1",
    json({ events: [], task: readyTask })
  );
  server.on(
    "POST",
    "/api/code-tasks/task-1/commands",
    json({ command: { id: "command-2", status: "queued" } }, 202)
  );

  const view = render(<CodeTaskDetail open taskId="task-1" />);
  const input = await screen.findByRole("textbox", {
    name: "Update code task",
  });
  fireEvent.change(input, { target: { value: "Please adjust the copy." } });
  fireEvent.click(screen.getByRole("button", { name: "Send task update" }));

  await waitFor(() => {
    expect(server.to("POST", "/api/code-tasks/task-1/commands")).toHaveLength(
      1
    );
  });
  expect(
    server.to("POST", "/api/code-tasks/task-1/commands")[0]?.body
  ).toMatchObject({
    kind: "steer",
    text: "Please adjust the copy.",
  });
  view.unmount();
});

test("restarts the stream from the returned snapshot when steering a terminal task", async () => {
  const { server, streams } = installFakes();
  const readyTask: PublicCodeTask = { ...task, status: "ready" };
  const queuedTask: PublicCodeTask = {
    ...readyTask,
    phase: "preparing",
    status: "queued",
    summary: "Queued correction",
    updatedAt: "2026-11-02T12:02:00Z",
  };
  const oldEvent = {
    createdAt: "2026-11-02T12:01:00Z",
    data: { command: "pnpm test", output: "Old receipt" },
    revision: 1,
    seq: 1,
    taskId: "task-1",
    type: "verification",
  };
  let details = 0;
  server.on("GET", "/api/code-tasks/task-1", () => {
    details += 1;
    return json(
      details === 1
        ? { events: [oldEvent], task: readyTask }
        : { events: [], task: queuedTask }
    );
  });
  server.on(
    "POST",
    "/api/code-tasks/task-1/commands",
    json(
      { command: { id: "command-3", status: "queued" }, task: queuedTask },
      202
    )
  );

  render(<CodeTaskDetail open taskId="task-1" />);
  const input = await screen.findByRole("textbox", {
    name: "Update code task",
  });
  fireEvent.change(input, { target: { value: "Please rerun the checks." } });
  fireEvent.click(screen.getByRole("button", { name: "Send task update" }));

  await waitFor(() => expect(streams.all).toHaveLength(1));
  expect(streams.all[0]?.url).toContain("after=0");
  expect(await screen.findByText("Queued")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "result" }));
  expect(await screen.findByText("Queued correction")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "checks" }));
  expect(await screen.findByText("No checks recorded yet.")).toBeTruthy();
});

test("clears task-local events when selecting a different task", async () => {
  const { server } = installFakes();
  const secondTask: PublicCodeTask = {
    ...task,
    id: "task-2",
    summary: "Reading the second task",
    title: "Fix the second redirect",
  };
  server.on("GET", "/api/code-tasks/task-1", json({ events: [], task }));
  server.on(
    "GET",
    "/api/code-tasks/task-2",
    json({ events: [], task: secondTask })
  );

  const view = render(<CodeTaskDetail open taskId="task-1" />);
  expect(
    await screen.findByRole("heading", { name: "Fix the login redirect" })
  ).toBeTruthy();
  view.rerender(<CodeTaskDetail open taskId="task-2" />);
  expect(
    await screen.findByRole("heading", { name: "Fix the second redirect" })
  ).toBeTruthy();
  expect(
    screen.queryByRole("heading", { name: "Fix the login redirect" })
  ).toBeNull();
  view.unmount();
});

test("keeps polling resumable terminal task summaries", async () => {
  vi.useFakeTimers();
  const { server } = installFakes();
  const readyTask: PublicCodeTask = { ...task, status: "ready" };
  const queuedTask: PublicCodeTask = { ...task, status: "queued" };
  let requests = 0;
  server.on("GET", "/api/code-tasks/task-1", () => {
    requests += 1;
    return json({ task: requests === 1 ? readyTask : queuedTask });
  });

  render(<InlineCodeTaskCard slug="builder" taskId="task-1" />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByRole("button", { name: TASK_NAME })).toBeTruthy();
  expect(requests).toBe(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(29_999);
  });
  expect(requests).toBe(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(requests).toBe(2);
  expect(screen.getByText("Queued")).toBeTruthy();
});

test("opens a modal with the initial request and every kind of activity", async () => {
  const { server } = installFakes();
  server.on(
    "GET",
    "/api/code-tasks/task-1",
    json({
      events: [
        {
          createdAt: task.createdAt,
          data: { command: "repo/src/auth.ts", name: "read_file" },
          revision: 1,
          seq: 1,
          taskId: task.id,
          type: "tool.start",
        },
        {
          createdAt: task.createdAt,
          data: { command: "pnpm test", exitCode: 0, output: "Tests passed" },
          revision: 1,
          seq: 2,
          taskId: task.id,
          type: "verification",
        },
        {
          createdAt: task.createdAt,
          data: { summary: "Finished the redirect fix." },
          revision: 1,
          seq: 3,
          taskId: task.id,
          type: "task.ready",
        },
      ],
      task: { ...task, status: "ready" },
    })
  );
  render(<CodeTaskDetail open taskId={task.id} />);
  const dialog = await screen.findByRole("dialog");
  expect(dialog.getAttribute("data-slot")).toBe("dialog-content");
  expect(await screen.findByText(task.goal)).toBeTruthy();
  const transcript = within(screen.getByTestId("code-task-transcript"));
  expect(transcript.getByText("pnpm test")).toBeTruthy();
  expect(transcript.getByText("Finished the redirect fix.")).toBeTruthy();
  expect(screen.queryByText("task.ready")).toBeNull();
});

test("keeps unavailable costs distinct from a subscription charge", async () => {
  const { server } = installFakes();
  server.on(
    "GET",
    "/api/code-tasks/task-1",
    json({ events: [], task: { ...task, status: "ready" } })
  );
  const view = render(<CodeTaskDetail open taskId={task.id} />);
  await screen.findByRole("heading", { name: TASK_NAME });
  fireEvent.click(screen.getByRole("tab", { name: "usage" }));
  expect(await screen.findByText("Unavailable")).toBeTruthy();
  expect(screen.queryByText("$0.00")).toBeNull();
  view.unmount();
  server.on(
    "GET",
    "/api/code-tasks/task-1",
    json({ events: [], task: { ...task, billing: "chatgpt", status: "ready" } })
  );
  render(<CodeTaskDetail open taskId={task.id} />);
  await screen.findByRole("heading", { name: TASK_NAME });
  fireEvent.click(screen.getByRole("tab", { name: "usage" }));
  expect(await screen.findByText("Subscription")).toBeTruthy();
  expect(screen.queryByText("$0.00")).toBeNull();
});

test.each([
  { costStatus: "reported", costUsd: 0.0123, expected: "$0.0123" },
  { costStatus: "reported", costUsd: 0, expected: "$0.00" },
  { costStatus: "pending", costUsd: null, expected: "Pending" },
  { costStatus: "partial", costUsd: 0.001, expected: "$0.001" },
] as const)(
  "shows $costStatus cost as $expected",
  async ({ costStatus, costUsd, expected }) => {
    const { server } = installFakes();
    server.on(
      "GET",
      "/api/code-tasks/task-1",
      json({
        events: [],
        task: {
          ...task,
          status: "ready",
          usage: {
            cacheReadTokens: 500,
            cacheWriteTokens: null,
            costStatus,
            costUsd,
            inputTokens: 1000,
            outputTokens: 400,
            reasoningTokens: 200,
            requests: 2,
          },
        },
      })
    );
    render(<CodeTaskDetail open taskId={task.id} />);
    await screen.findByRole("heading", { name: TASK_NAME });
    fireEvent.click(screen.getByRole("tab", { name: "usage" }));
    expect(await screen.findByText(expected)).toBeTruthy();
    expect(screen.queryByText("Partial cost") !== null).toBe(
      costStatus === "partial"
    );
  }
);

test("opens the current diff for the file attached to a checkpoint", async () => {
  const { server } = installFakes();
  server.on(
    "GET",
    "/api/code-tasks/task-1",
    json({
      events: [
        {
          createdAt: task.createdAt,
          data: {
            command: "pnpm test auth",
            exitCode: 0,
            files: ["src/auth.test.ts"],
          },
          revision: 1,
          seq: 1,
          taskId: task.id,
          type: "verification",
        },
      ],
      task: {
        ...task,
        execution: {
          diff: "diff --git a/src/auth.ts b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/src/auth.test.ts b/src/auth.test.ts\n@@ -0,0 +1 @@\n+test callback query\n",
          files: ["src/auth.ts", "src/auth.test.ts"],
        },
        status: "ready",
      },
    })
  );
  render(<CodeTaskDetail open taskId={task.id} />);
  fireEvent.click(
    await screen.findByRole("button", { name: CHECKPOINT_DIFF_LINK })
  );
  expect(
    await screen.findByRole("region", { name: "Diff for src/auth.test.ts" })
  ).toBeTruthy();
  expect(
    screen.getByRole("tab", { name: "changes" }).getAttribute("aria-selected")
  ).toBe("true");
  expect(
    screen
      .getByRole("button", { name: "src/auth.test.ts" })
      .getAttribute("aria-pressed")
  ).toBe("true");
  expect(document.activeElement).toBe(
    screen.getByRole("tabpanel", { name: "changes" })
  );
});
