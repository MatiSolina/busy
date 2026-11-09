import { afterEach, describe, expect, it, vi } from "vitest";
import { logChatObservation } from "@/lib/chat/observability";
import { type Stages, serverTiming, span, stageFields } from "@/lib/trace";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("trace stages", () => {
  it("records each stage, including failed ones, and formats them", async () => {
    const stages: Stages = {};
    expect(await span("eve.send", () => Promise.resolve(1), stages)).toBe(1);
    await expect(
      span("message.files", () => Promise.reject(new Error("x")), stages)
    ).rejects.toThrow("x");

    expect(Object.keys(stages)).toEqual(["eve.send", "message.files"]);
    expect(serverTiming({ "eve.send": 12 })).toBe("eve_send;dur=12");
    expect(stageFields({ "eve.send": 12, "message.bot": 3 })).toEqual({
      stageEveSendMs: 12,
      stageMessageBotMs: 3,
    });
  });

  it("logs only numeric stage fields", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logChatObservation("message.post", {
      outcome: "accepted",
      stageEveSendMs: 12,
      stageLeak: "secret",
      stagePromptMs: "secret",
    });
    const logged = JSON.parse(String(info.mock.calls[0]?.[0]));
    expect(logged.stageEveSendMs).toBe(12);
    expect(logged).not.toHaveProperty("stageLeak");
    expect(logged).not.toHaveProperty("stagePromptMs");
  });
});
