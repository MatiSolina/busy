import { describe, expect, it } from "vitest";
import {
  aiIssueFromEvent,
  hasAiIssueSignal,
  sanitizeAiFact,
} from "./model-errors";

describe("persisted model errors", () => {
  it("maps and strips a provider token from model failures", () => {
    expect(
      sanitizeAiFact(
        {
          data: {
            error: { message: "secret access token", status: 401 },
            outcome: "failed",
          },
          type: "model.settled",
        },
        "chatgpt"
      )
    ).toEqual({
      data: {
        error: { code: "connection_not_connected", provider: "chatgpt" },
        outcome: "failed",
      },
      type: "model.settled",
    });
  });

  it("does not fabricate a provider issue for a tool-only turn failure", () => {
    const fact = {
      data: {
        error: { message: "Command exited with code 1" },
        outcome: "failed",
      },
      type: "turn.settled",
    };
    expect(sanitizeAiFact(fact, "gateway")).toEqual(fact);
    expect(aiIssueFromEvent(fact.data, "gateway").code).toBe(
      "inference_failed"
    );
  });

  it("sanitizes issue metadata as well as legacy error metadata", () => {
    expect(
      sanitizeAiFact(
        {
          data: {
            issue: { code: "provider_quota_exceeded", message: "private body" },
            outcome: "failed",
          },
          type: "model.settled",
        },
        "gateway"
      )
    ).toMatchObject({
      data: {
        error: { code: "provider_quota_exceeded", provider: "gateway" },
      },
    });
  });

  it("sanitizes provider-shaped child task failures", () => {
    expect(
      sanitizeAiFact(
        {
          data: {
            error: {
              message: "private provider body",
              provider: "grok",
              status: 429,
            },
            outcome: "failed",
            reason: "private provider body",
          },
          type: "task.ended",
        },
        "grok"
      )
    ).toEqual({
      data: {
        error: { code: "provider_rate_limited", provider: "grok" },
        outcome: "failed",
      },
      type: "task.ended",
    });
  });

  it("removes actual NULs from nested stream data without rewriting literal escapes", () => {
    expect(
      sanitizeAiFact({
        data: {
          "key\u0000": "before\u0000after",
          "key�": "existing value",
          literal: "\\u0000",
          nested: ["inside\u0000array"],
        },
        type: "content.completed",
      })
    ).toEqual({
      data: {
        "key�": "before�after",
        "key� [duplicate 2]": "existing value",
        literal: "\\u0000",
        nested: ["inside�array"],
      },
      type: "content.completed",
    });
  });

  it("classifies a message-only context-length failure as a terminal public issue", () => {
    const value = {
      error: {
        message: "This model's maximum context length is 128000 tokens",
      },
    };
    expect(hasAiIssueSignal(value)).toBe(true);
    expect(aiIssueFromEvent(value)).toMatchObject({
      action: "retry",
      code: "context_length_exceeded",
      message: "This conversation is too long for the model.",
      retryable: false,
    });
  });

  it("unwraps an AI SDK retry error and keeps the Busy provider code", () => {
    const retryError = {
      errors: [
        {
          data: {
            error: {
              code: "provider_unavailable",
              message: "Grok could not complete this request.",
              type: "busy_subscription_error",
            },
            provider: "grok",
          },
          message: "Grok could not complete this request.",
          statusCode: 503,
        },
      ],
      lastError: {
        data: {
          error: {
            code: "provider_unavailable",
            message: "Grok could not complete this request.",
          },
          provider: "grok",
        },
        message: "Grok could not complete this request.",
        statusCode: 503,
      },
      message:
        "Failed after 3 attempts. Last error: Grok could not complete this request.",
      name: "AI_RetryError",
      reason: "maxRetriesExceeded",
    };

    expect(aiIssueFromEvent({ error: retryError }, "grok")).toMatchObject({
      code: "provider_unavailable",
      provider: "grok",
    });
  });
});
