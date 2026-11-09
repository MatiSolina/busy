import type { Fact } from "../../lib/chat/items";

const workloads = {
  "history-long": {
    archivedTurnsPerSession: 103,
    bots: 1,
    factsPerTurn: 4,
    name: "history-long",
    sessionsPerBot: 65,
    turnsPerSession: 10_000,
  },
  mixed: {
    bots: 1,
    factsPerTurn: 6,
    name: "mixed",
    sessionsPerBot: 3,
    turnsPerSession: 103,
  },
  scale: {
    bots: 8,
    factsPerTurn: 4,
    name: "scale",
    sessionsPerBot: 4,
    turnsPerSession: 70,
  },
} as const;

export type Workload = (typeof workloads)[keyof typeof workloads];

export function getWorkload(name = "scale"): Workload {
  if (name !== "scale" && name !== "mixed" && name !== "history-long") {
    throw new Error("PERF_WORKLOAD must be scale, mixed or history-long");
  }
  return workloads[name];
}

export function turnsForSession(workload: Workload, session: number): number {
  if (session === workload.sessionsPerBot - 1) {
    return workload.turnsPerSession;
  }
  if ("archivedTurnsPerSession" in workload) {
    return workload.archivedTurnsPerSession;
  }
  return workload.turnsPerSession;
}

export const fixtureTaskId = "b07d7ea0-a1ca-4f2c-91e8-af7c865ef0ad";
export const fixtureTaskTitle = "Review the synthetic performance change";

export const replyMarker = (
  workload: Workload,
  bot: number,
  session = workload.sessionsPerBot - 1,
  turn = turnsForSession(workload, session) - 1
) => `Evaluation ${bot}/${session}/${turn}.`;

export const newestArchivedReplyMarker = (workload: Workload, bot = 0) =>
  replyMarker(workload, bot, workload.sessionsPerBot - 2);

/** Deterministic multi-line tool text, ~60 bytes per line. */
const toolBody = (verb: string, turn: number, lines: number) =>
  Array.from(
    { length: lines },
    (_, line) =>
      `${verb} fixture/project-${turn}/src/module-${line}.ts: ok (${line * 7} ms)`
  ).join("\n");

export function turnFacts(
  workload: Workload,
  bot: number,
  session: number,
  turn: number
): Fact[] {
  const deliveryId = `perf-bot-${bot}-session-${session}-delivery-${turn}`;
  const text = `Review project ${turn} and explain the next steps.`;
  const marker = replyMarker(workload, bot, session, turn);
  const value =
    workload.name === "scale"
      ? `${marker}\n\n## Project review\n\nThe implementation is ready for review. Check these next steps:\n\n- Verify the customer flow.\n- Review the measurements.\n- Publish the approved change.\n\nRepeatable measurements help us find regressions and compare the same workload.`
      : `${marker}\n\n## Project review\n\nThe **synthetic** investigation completed with \`fixture-${turn}\`. See [the project notes](https://example.com/project) for the next review.\n\n| Check | Outcome |\n| --- | --- |\n| Navigation | Passed |\n| Draft retention | Passed |\n\n### Proposed implementation\n\n\`\`\`ts\nexport async function review(project: string) {\n  const result = await inspect(project);\n  return { project, result, approved: false };\n}\n\`\`\`\n\n- [x] Inspect the current behavior\n- [x] Compare the same workload\n- [ ] Review the proposed change\n\n> This conversation contains only deterministic synthetic content.\n\nThe result includes a table, a fenced code block, a safe external link and a task list so repeated evaluations exercise the controls used by real conversations.`;
  return [
    {
      data: { deliveryId, parts: [{ kind: "text", text }] },
      type: "delivery.consumed",
    },
    { data: { turnId: `turn-${turn}` }, type: "turn.started" },
    ...(workload.name === "mixed"
      ? [
          {
            data: {
              callId: `inspect-${turn}`,
              capability: { name: "inspect_project" },
              // Large tool IO, like real shell and file tools: the chat shows
              // neither body, so the transport can drop them.
              input: {
                project: `project-${turn}`,
                script: toolBody("step", turn, 24),
              },
            },
            type: "call.requested",
          },
          {
            data: {
              callId: `inspect-${turn}`,
              outcome: "completed",
              output: {
                files: 12,
                findings: ["Ready for review"],
                log: toolBody("checked", turn, 64),
                passed: true,
              },
            },
            type: "call.settled",
          },
        ]
      : []),
    {
      data: { kind: "text", partId: `reply-${turn}`, phase: "reply", value },
      type: "content.completed",
    },
    {
      data: { outcome: "completed", turnId: `turn-${turn}` },
      type: "turn.settled",
    },
  ];
}
