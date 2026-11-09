import { expect, it as test } from "vitest";
import { type ClientRow, toChatView } from "../../lib/chat/items";
import {
  getWorkload,
  newestArchivedReplyMarker,
  replyMarker,
  turnFacts,
  turnsForSession,
} from "./workload";

test.each(["scale", "mixed"])(
  "%s retains the latest reply and settled tools through the real 400-row window",
  (name) => {
    const workload = getWorkload(name);
    const session = workload.sessionsPerBot - 1;
    const rows: ClientRow[] = Array.from(
      { length: workload.turnsPerSession },
      (_, turn) =>
        turnFacts(workload, 0, session, turn).map((fact, index) => ({
          data: fact,
          index: 0,
          line: turn * workload.factsPerTurn + index,
          type: fact.type,
        }))
    ).flat();
    expect(new Set(rows.map((row) => row.line)).size).toBe(rows.length);
    const nextLiveLine = workload.turnsPerSession * workload.factsPerTurn;
    expect(rows.at(-1)?.line).toBe(nextLiveLine - 1);
    const view = toChatView(rows.slice(-400), new Map(), new Map());
    const reply = view.items.filter((item) => item.kind === "bot").at(-1);
    expect(reply?.text).toContain(replyMarker(workload, 0));
    expect(reply?.streaming).toBe(false);
    expect(view.working).toBe(false);
    const tools = view.items.filter((item) => item.kind === "activity");
    expect(tools.length > 40).toBe(name === "mixed");
    expect(tools.every((tool) => tool.state === "done")).toBe(true);
    expect(reply?.text.includes("| Check | Outcome |")).toBe(name === "mixed");
    expect(reply?.text.includes("```ts")).toBe(name === "mixed");
  }
);

test("rejects an unknown workload instead of silently measuring another scenario", () => {
  expect(() => getWorkload("unknown")).toThrow("PERF_WORKLOAD");
});

test("history-long keeps ten thousand active turns and 64 archived sessions", () => {
  const workload = getWorkload("history-long");
  expect(workload.sessionsPerBot).toBe(65);
  expect(workload.turnsPerSession).toBe(10_000);
  expect(turnsForSession(workload, 0)).toBe(103);
  expect(turnsForSession(workload, 64)).toBe(10_000);
  expect(replyMarker(workload, 0)).toBe("Evaluation 0/64/9999.");
  expect(newestArchivedReplyMarker(workload)).toBe("Evaluation 0/63/102.");
});
