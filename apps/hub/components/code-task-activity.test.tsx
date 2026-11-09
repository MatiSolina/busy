// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import {
  CodeTaskActivity,
  CodeTaskChecks,
} from "@/components/code-task-activity";
import type { PublicCodeEvent, PublicCodeTask } from "@/lib/code-tasks/types";

const ALL_ACTIVITY = /^All activity/u;
const EXIT_ONE = /Exit 1/u;
const EXIT_ZERO = /Exit 0/u;

const task: PublicCodeTask = {
  agentName: null,
  appliedInstructionVersion: 1,
  billing: "gateway",
  botId: "bot-1",
  branch: "codex/task-1",
  commitSha: null,
  createdAt: "2026-11-03T12:00:00Z",
  durableSessionId: null,
  error: null,
  execution: {},
  finishedAt: null,
  goal: "Show the complete coding task history.",
  id: "task-1",
  instructionVersion: 1,
  lastStreamCursor: 5,
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
  summary: null,
  title: "Show coding task history",
  updatedAt: "2026-11-03T12:00:00Z",
};

const activityEvents: PublicCodeEvent[] = [
  {
    createdAt: "2026-11-03T12:00:01Z",
    data: { message: "Reading the task" },
    revision: 1,
    seq: 1,
    taskId: task.id,
    type: "agent.working",
  },
  {
    createdAt: "2026-11-03T12:00:02Z",
    data: { command: "{}", name: "prepare_repository" },
    revision: 1,
    seq: 2,
    taskId: task.id,
    type: "tool.start",
  },
  {
    createdAt: "2026-11-03T12:00:03Z",
    data: { isError: false, name: "prepare_repository", output: "{}" },
    revision: 1,
    seq: 3,
    taskId: task.id,
    type: "tool.end",
  },
  {
    createdAt: "2026-11-03T12:00:04Z",
    data: { command: "pnpm test", exitCode: 0, output: "{}" },
    revision: 1,
    seq: 4,
    taskId: task.id,
    type: "verification",
  },
  {
    createdAt: "2026-11-03T12:00:05Z",
    data: { summary: "Task is ready" },
    revision: 1,
    seq: 5,
    taskId: task.id,
    type: "task.ready",
  },
];

afterEach(() => {
  cleanup();
});

test("keeps the initial goal and renders every activity event without empty JSON", () => {
  render(<CodeTaskActivity events={activityEvents} task={task} />);

  expect(screen.getByText(task.goal)).toBeTruthy();
  const transcriptElement = screen.getByTestId("code-task-transcript");
  expect(transcriptElement.hasAttribute("open")).toBe(false);
  const transcript = within(transcriptElement);
  fireEvent.click(transcript.getByText(ALL_ACTIVITY));
  expect(transcriptElement.hasAttribute("open")).toBe(true);
  expect(transcript.getByText("Agent working")).toBeTruthy();
  expect(transcript.getByText("Started prepare_repository")).toBeTruthy();
  expect(transcript.getByText("Finished prepare_repository")).toBeTruthy();
  expect(transcript.getByText("Verification")).toBeTruthy();
  expect(transcript.getByText("Task ready")).toBeTruthy();
  expect(screen.queryByText("{}")).toBeNull();
});

test("coalesces adjacent streamed agent messages into one activity item", () => {
  const events: PublicCodeEvent[] = [
    {
      createdAt: "2026-11-03T12:00:01Z",
      data: { message: "Preparing " },
      revision: 1,
      seq: 1,
      taskId: task.id,
      type: "agent.message",
    },
    {
      createdAt: "2026-11-03T12:00:02Z",
      data: { message: "the patch" },
      revision: 1,
      seq: 2,
      taskId: task.id,
      type: "agent.message",
    },
  ];

  render(<CodeTaskActivity events={events} task={task} />);

  const transcript = within(screen.getByTestId("code-task-transcript"));
  fireEvent.click(transcript.getByText(ALL_ACTIVITY));
  expect(transcript.getByText("Preparing the patch")).toBeTruthy();
  expect(transcript.getAllByText("Agent update")).toHaveLength(1);
});

test("keeps checks with the same command and digest when their receipt changes", () => {
  const checksTask: PublicCodeTask = {
    ...task,
    execution: {
      checks: [
        {
          command: "pnpm test",
          digest: "digest-1",
          exitCode: 1,
          instructionVersion: 1,
          output: "failed",
        },
      ],
    },
  };
  const checks: PublicCodeEvent[] = [
    {
      ...activityEvents[3],
      data: {
        command: "pnpm test",
        digest: "digest-1",
        exitCode: 0,
        instructionVersion: 2,
        output: "passed",
      },
    },
  ];

  render(<CodeTaskChecks events={checks} task={checksTask} />);

  expect(screen.getAllByText("pnpm test")).toHaveLength(2);
  expect(screen.getByText(EXIT_ONE)).toBeTruthy();
  expect(screen.getByText(EXIT_ZERO)).toBeTruthy();
});
