import { describe, expect, it } from "vitest";
import type { ClientRow } from "./lib/chat/items";
import {
  isWorking,
  projectTurn,
  STALE_TURN_MS,
  type TurnFact,
} from "./lib/chat/status";

const t0 = new Date("2026-11-08T12:00:00.000Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const fact = (
  type: string,
  data: Record<string, unknown> = {},
  ms = 0,
  scope?: Record<string, unknown>
): TurnFact => ({ at: at(ms), data: { data, scope }, type });
const row = (
  type: string,
  data: Record<string, unknown> = {},
  scope?: Record<string, unknown>
): ClientRow => ({ data: { data, scope, type }, index: 0, line: 0, type });

describe("projectTurn (H-33)", () => {
  it("lets eve's turn settle the fast ack turn it took over", () => {
    // Prod (content-editor): the ack's turn starts after eve's own turn, and never settles itself.
    const rows = [
      row("turn.started", { turnId: "fast-m1" }, { turnId: "fast-m1" }),
      row("turn.started", { turnId: "fast-m2" }, { turnId: "fast-m2" }),
      row("model.requested", {}, { turnId: "turn_2" }),
      row("turn.settled", { turnId: "turn_2" }, { turnId: "turn_2" }),
    ];
    expect(isWorking(rows)).toBe(false);
    expect(isWorking(rows.slice(0, 3))).toBe(true);
  });

  it("still ignores another real turn's settle", () => {
    const rows = [
      row("turn.started", { turnId: "t2" }),
      row("turn.settled", { turnId: "t1" }),
    ];
    expect(isWorking(rows)).toBe(true);
  });

  it("keeps an orphan turn.started open until session.ended, never inventing a settle", () => {
    const orphan = [fact("turn.started", { turnId: "t1" })];
    expect(projectTurn(orphan, at(60_000).getTime()).state).toBe("running");
    // Past the threshold it is unverified, still open: not "settled".
    const stale = projectTurn(orphan, at(STALE_TURN_MS + 1).getTime());
    expect(stale.state).toBe("unknown");
    expect(stale.turnId).toBe("t1");
    const ended = projectTurn(
      [...orphan, fact("session.ended", { outcome: "failed" }, 5000)],
      at(STALE_TURN_MS + 1).getTime()
    );
    expect(ended.state).toBe("ended");
  });

  it("keeps a paused turn awaiting input past the stale threshold", () => {
    const facts = [
      fact("turn.started", { turnId: "t1" }),
      fact("interaction.opened", { interactionId: "i1" }, 10, {
        turnId: "t1",
      }),
      fact("turn.paused", { awaiting: [{ interactionId: "i1" }] }, 20, {
        turnId: "t1",
      }),
    ];
    const p = projectTurn(facts, at(3 * 60 * 60_000).getTime());
    expect(p.state).toBe("awaiting_input");
  });

  it("shows the paused turn running again on its next fact", () => {
    const facts = [
      fact("turn.started", { turnId: "t1" }),
      fact("turn.paused", {}, 20, { turnId: "t1" }),
      fact("interaction.settled", { interactionId: "i1" }, 30, {
        turnId: "t1",
      }),
      fact("model.requested", {}, 40, { turnId: "t1" }),
    ];
    expect(projectTurn(facts, at(50).getTime()).state).toBe("running");
  });

  it("settles only the open turn; progress keeps a long turn verified", () => {
    const facts = [
      fact("turn.started", { turnId: "t1" }),
      fact("model.requested", {}, STALE_TURN_MS, { turnId: "t1" }),
    ];
    expect(projectTurn(facts, at(STALE_TURN_MS + 60_000).getTime()).state).toBe(
      "running"
    );
    expect(
      projectTurn([
        ...facts,
        fact("turn.settled", { outcome: "completed", turnId: "t0" }),
      ]).state
    ).toBe("running");
    expect(
      projectTurn([
        ...facts,
        fact("turn.settled", { outcome: "completed", turnId: "t1" }),
      ]).state
    ).toBe("idle");
  });

  it("counts admitted deliveries that no settle closed", () => {
    const p = projectTurn([
      fact("delivery.admitted", { deliveryId: "d1" }),
      fact("delivery.admitted", { deliveryId: "d2" }),
      fact("delivery.settled", { deliveryId: "d1" }),
    ]);
    expect(p).toMatchObject({ pendingDeliveries: 1, state: "idle" });
  });
});

describe("isWorking", () => {
  it("is on for an open or paused turn and off once it settles or the session ends", () => {
    const started = row("turn.started", { turnId: "t1" });
    expect(isWorking([started])).toBe(true);
    expect(isWorking([started, row("turn.paused", {}, { turnId: "t1" })])).toBe(
      true
    );
    expect(
      isWorking([started, row("turn.settled", { outcome: "completed" })])
    ).toBe(false);
    expect(
      isWorking([started, row("session.ended", { outcome: "failed" })])
    ).toBe(false);
    expect(isWorking([])).toBe(false);
  });
});
