import { describe, expect, it } from "vitest";
import {
  baselineFromMeasurements,
  checkContextBudgets,
  measureContextBudget,
} from "./context-budget";
import { collectToolInventory } from "./tool-inventory";

describe("context budget", () => {
  it("fails when a measured dimension grows past its checked-in ceiling", async () => {
    const measurement = await measureContextBudget("core", 8);
    const baseline = baselineFromMeasurements({
      core: measurement,
      off: measurement,
      on: measurement,
    });
    const result = checkContextBudgets(
      {
        core: { ...measurement, promptBytes: measurement.promptBytes + 1 },
        off: measurement,
        on: measurement,
      },
      baseline
    );

    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual({
      ceiling: measurement.promptBytes,
      current: measurement.promptBytes + 1,
      metric: "promptBytes",
      mode: "core",
    });
  });

  it("measures dynamic tools deterministically, including their real schemas", async () => {
    const first = await measureContextBudget("core", 8);
    const second = await measureContextBudget("core", 8);
    const inventory = await collectToolInventory("core", { peerCount: 8 });

    expect(second).toEqual(first);
    expect(first.toolCount).toBeGreaterThan(first.promptToolCount);
    expect(first.toolGroups).toHaveProperty("plan (deferred)");
    expect(inventory.rows.some((row) => row.name === "manage_plan")).toBe(true);
    expect(inventory.rows.some((row) => row.name === "browser__batch")).toBe(
      true
    );
  });
});
