import { describe, expect, it } from "vitest";
import { config, gateError } from "./proxy";

const gated = (path: string) =>
  config.matcher.some((m) => new RegExp(`^${m}$`, "u").test(path));

describe("proxy matcher", () => {
  it("gates the app and the user's API", () => {
    for (const path of [
      "/",
      "/b/lawyer",
      "/api/bots",
      "/api/bots/x/messages",
    ]) {
      expect(gated(path), path).toBe(true);
    }
  });

  it("skips the bots' bearer-authenticated API and internal routes", () => {
    for (const path of [
      "/api/bot/memory",
      "/api/bot/ai/responses",
      "/.well-known/workflow/v1/flow",
      "/api/queues/routine-runs",
      "/_next/static/chunk.js",
    ]) {
      expect(gated(path), path).toBe(false);
    }
  });
});

describe("gate errors", () => {
  it("answers in the API's JSON error shape", async () => {
    const res = gateError(401);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({
      code: "unauthorized",
      docs: "https://busybot.dev/developers",
      error: "unauthorized",
      retryable: false,
    });
    expect(await gateError(403).json()).toMatchObject({ code: "forbidden" });
  });
});
