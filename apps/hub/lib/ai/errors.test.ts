import { describe, expect, it } from "vitest";
import {
  aiIssue,
  aiIssueFromResponse,
  aiIssueGuidance,
  issueFromProviderStatus,
  issueResponse,
} from "./errors";

describe("AI public issues", () => {
  it("keeps provider and recovery guidance stable", () => {
    expect(aiIssue("provider_rate_limited", "grok")).toEqual({
      action: "retry",
      code: "provider_rate_limited",
      message: "Grok is busy right now.",
      provider: "grok",
      retryable: true,
    });
    expect(aiIssue("connection_expired", "chatgpt")).toMatchObject({
      code: "connection_expired",
      message: "Your ChatGPT connection expired. Reconnect it in Settings.",
      provider: "chatgpt",
    });
  });

  it("classifies statuses without exposing an upstream response body", () => {
    expect(issueFromProviderStatus(401, "chatgpt")).toMatchObject({
      code: "connection_not_connected",
      provider: "chatgpt",
      retryable: false,
    });
    expect(issueFromProviderStatus(402, "token-pass").code).toBe(
      "provider_quota_exceeded"
    );
    expect(issueFromProviderStatus(429, "gateway").code).toBe(
      "provider_rate_limited"
    );
  });

  it("parses only the fixed public vocabulary", () => {
    expect(
      aiIssueFromResponse(
        {
          code: "provider_unavailable",
          message: "provider response with private details",
          provider: "grok",
          retryable: true,
          secret: "must be ignored",
        },
        { provider: "grok" }
      )
    ).toMatchObject({
      code: "provider_unavailable",
      message: "Grok is unavailable right now.",
      provider: "grok",
      retryable: true,
    });
    expect(
      aiIssueFromResponse({
        code: "provider_quota_exceeded",
        provider: "gateway",
      })
    ).toMatchObject({
      code: "provider_quota_exceeded",
      provider: "gateway",
    });
    expect(
      aiIssueFromResponse({ error: "provider_auth_required" })
    ).toMatchObject({
      code: "provider_auth_failed",
    });
    expect(
      aiIssueFromResponse(
        { error: "provider-password=secret" },
        {
          provider: "grok",
          status: 502,
        }
      )
    ).toBeNull();
  });

  it("provides contextual guidance for the compact action", () => {
    expect(aiIssueGuidance(aiIssue("invalid_inference_input", "grok"))).toBe(
      "Try a shorter message or fewer files. If it still fails, choose another model in this bot's settings."
    );
    expect(aiIssueGuidance(aiIssue("context_length_exceeded", "grok"))).toBe(
      "Start a fresh conversation or ask for a shorter task before trying again."
    );
  });

  it("can preserve a legacy error-only body while routes migrate", async () => {
    const legacy = await issueResponse(
      aiIssue("provider_unconfigured", "token-pass"),
      409,
      true
    );
    expect(await legacy.json()).toEqual({ error: "provider_unconfigured" });
    const structured = await issueResponse(
      aiIssue("provider_unconfigured", "token-pass"),
      409
    );
    expect(await structured.json()).toMatchObject({
      code: "provider_unconfigured",
      provider: "token-pass",
    });
  });
});
