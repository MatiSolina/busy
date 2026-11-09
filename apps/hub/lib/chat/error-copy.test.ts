import { describe, expect, it } from "vitest";
import { modelFailed, said, seq, started, view } from "./chat.test-helpers";
import { chatErrorCopy, classifyChatError } from "./error-copy";

describe("chat error copy", () => {
  it.each([
    ["429 Too Many Requests", "rate_limit"],
    ["AI Gateway: insufficient funds for this request", "credits"],
    ["This model's maximum context length is 128000 tokens", "context"],
    ["401 Unauthorized: invalid API key", "auth"],
    ["The model `gpt-x` does not exist", "model_unavailable"],
    ["fetch failed", "network"],
    ["Request timed out", "timeout"],
    ["kaboom", "unknown"],
  ] as const)("classifies %s", (message, kind) => {
    expect(classifyChatError(message)).toBe(kind);
  });

  it("says when a usage limit resets", () => {
    expect(chatErrorCopy("Usage limit reached · resets 6:50pm (UTC)")).toBe(
      "The model hit its usage limit. It resets at 6:50pm (UTC)."
    );
  });

  it("shows provider recovery without retaining raw error details", () => {
    const [, error] = view(
      seq(
        said("d1", "Hi"),
        started("t1"),
        modelFailed({ message: "429 Too Many Requests; token=private" })
      )
    ).items;
    expect(error).toEqual({
      id: "t1:2:0",
      issue: {
        action: "retry",
        code: "provider_rate_limited",
        message: "AI provider is busy right now.",
        provider: null,
        retryable: true,
      },
      kind: "error",
      text: "AI provider is busy right now. Try again in a moment.",
    });
    expect(JSON.stringify(error)).not.toContain("token=private");
  });
});
