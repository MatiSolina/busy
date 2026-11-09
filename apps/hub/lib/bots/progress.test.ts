import { describe, expect, it, vi } from "vitest";
import type { DeploymentDetails } from "../vercel/client";
import { BUILD_FAILED } from "./deploy";
import {
  deployProgress,
  loadDeployProgress,
  sanitizeLogLine,
} from "./progress";

const updatedAt = new Date("2026-11-05T12:00:00Z");
const created = Date.parse("2026-11-05T12:00:20Z");
const ready = Date.parse("2026-11-05T12:03:20Z");
const bot = (over: Partial<Parameters<typeof deployProgress>[0]> = {}) => ({
  deploymentId: "dpl_1",
  error: null,
  status: "deploying" as const,
  updatedAt,
  ...over,
});
const details = (over: Partial<DeploymentDetails> = {}): DeploymentDetails => ({
  buildingAt: created + 2000,
  createdAt: created,
  lastLine: "Compiling agent…",
  readyAt: null,
  readyState: "BUILDING",
  ...over,
});
const states = (steps: ReturnType<typeof deployProgress>) =>
  steps?.map((s) => s.state);

describe("deploy progress", () => {
  it("is preparing from the moment the bot became creating", () => {
    const steps = deployProgress(bot({ status: "creating" }), null);
    expect(states(steps)).toEqual(["active", "pending", "pending"]);
    expect(steps?.map((s) => s.id)).toEqual(["prepare", "build", "live"]);
    expect(steps?.[0]?.startedAt).toBe(updatedAt.toISOString());
  });

  it("shows the Vercel build state and last log line while building", () => {
    const steps = deployProgress(bot(), details());
    expect(states(steps)).toEqual(["done", "active", "pending"]);
    expect(steps?.[1]).toMatchObject({
      detail: "Building · Compiling agent…",
      startedAt: new Date(created).toISOString(),
    });
    expect(
      deployProgress(
        bot(),
        details({ lastLine: null, readyState: "QUEUED" })
      )?.[1]?.detail
    ).toBe("Queued");
  });

  it("goes live once Vercel is READY and the hub hasn't flipped the bot yet", () => {
    const steps = deployProgress(
      bot(),
      details({ readyAt: ready, readyState: "READY" })
    );
    expect(states(steps)).toEqual(["done", "done", "active"]);
    expect(steps?.[1]?.endedAt).toBe(new Date(ready).toISOString());
  });

  it("marks the failing step", () => {
    expect(
      states(
        deployProgress(
          bot({ error: BUILD_FAILED, status: "failed" }),
          details({ readyState: "ERROR" })
        )
      )
    ).toEqual(["done", "error", "pending"]);
    expect(
      states(
        deployProgress(
          bot({ error: "Token Pass is not configured", status: "failed" }),
          null
        )
      )
    ).toEqual(["error", "pending", "pending"]);
  });

  it("has nothing to show once ready", () => {
    expect(deployProgress(bot({ status: "ready" }), null)).toBeNull();
  });

  it("only asks Vercel about the deployment being built", async () => {
    const get = vi.fn(async () => details());
    await loadDeployProgress(bot({ status: "creating" }), get);
    await loadDeployProgress(bot({ error: "x", status: "failed" }), get);
    expect(get).not.toHaveBeenCalled();
    await loadDeployProgress(bot(), get);
    expect(get).toHaveBeenCalledWith("dpl_1");
  });

  it("keeps showing steps when Vercel can't be read", async () => {
    const steps = await loadDeployProgress(bot(), () =>
      Promise.reject(new Error("Vercel get deployment failed: 500"))
    );
    expect(states(steps)).toEqual(["done", "active", "pending"]);
  });
});

describe("build log sanitizing", () => {
  it("strips colors, secrets and long tokens, and keeps one short line", () => {
    expect(sanitizeLogLine("\u001b[32m✓\u001b[0m Compiled")).toBe("✓ Compiled");
    expect(sanitizeLogLine("AI_GATEWAY_API_KEY=vck_abc123 ok")).toBe(
      "AI_GATEWAY_API_KEY=… ok"
    );
    expect(sanitizeLogLine("token: hunter2")).toBe("token=…");
    expect(sanitizeLogLine("git clone https://user:pw@github.com/x")).toBe(
      "git clone https://…@github.com/x"
    );
    expect(sanitizeLogLine(`id ${"a".repeat(40)}`)).toBe("id …");
    expect(
      sanitizeLogLine("x".repeat(10).concat(" ", "y ".repeat(100)))?.length
    ).toBe(140);
    expect(sanitizeLogLine("   ")).toBeNull();
  });
});
