import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PUT } from "./app/api/ai/settings/route";

const mocks = vi.hoisted(() => ({
  AiProviderUnavailableError: class AiProviderUnavailableError extends Error {},
  getAiSettings: vi.fn(),
  readSession: vi.fn(),
  saveAiSettings: vi.fn(),
}));

vi.mock("@/lib/ai/settings", () => ({
  AiProviderUnavailableError: mocks.AiProviderUnavailableError,
  getAiSettings: mocks.getAiSettings,
  saveAiSettings: mocks.saveAiSettings,
}));
vi.mock("@/lib/auth/session", () => ({
  readSession: mocks.readSession,
  SESSION_COOKIE: "busy_session",
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "session" }) }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SESSION_SECRET", "test-session-secret");
  mocks.readSession.mockResolvedValue({ user: "test-user" });
  mocks.getAiSettings.mockResolvedValue({
    onboardingCompleted: false,
    provider: null,
    providers: [],
  });
  mocks.saveAiSettings.mockResolvedValue({
    onboardingCompleted: true,
    provider: "gateway",
    providers: [],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AI settings route", () => {
  it("returns the current account-scoped settings", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ onboardingCompleted: false });
  });

  it("does not read settings when the request is unauthenticated", async () => {
    mocks.readSession.mockResolvedValue(null);

    const getResponse = await GET();
    const putResponse = await PUT(
      new Request("https://busy.test/api/ai/settings", {
        body: JSON.stringify({ provider: "gateway" }),
        method: "PUT",
      })
    );

    expect(getResponse.status).toBe(401);
    expect(putResponse.status).toBe(401);
    expect(mocks.getAiSettings).not.toHaveBeenCalled();
    expect(mocks.saveAiSettings).not.toHaveBeenCalled();
  });

  it("sanitizes settings read failures", async () => {
    mocks.getAiSettings.mockRejectedValue(
      new Error("database password leaked")
    );

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      action: "retry",
      code: "could_not_load",
      error: "could_not_load",
      message: "Busy could not load AI connection settings.",
      provider: null,
      retryable: true,
    });
  });

  it("rejects malformed, extra, and unknown provider payloads", async () => {
    const requests = [
      new Request("https://busy.test/api/ai/settings", {
        body: "not json",
        method: "PUT",
      }),
      new Request("https://busy.test/api/ai/settings", {
        body: JSON.stringify({ extra: true, provider: "gateway" }),
        method: "PUT",
      }),
      new Request("https://busy.test/api/ai/settings", {
        body: JSON.stringify({ provider: "unknown-provider" }),
        method: "PUT",
      }),
      new Request("https://busy.test/api/ai/settings", {
        body: JSON.stringify({
          model: { id: "grok/grok-4.7" },
          provider: "grok",
        }),
        method: "PUT",
      }),
    ];

    const responses = await Promise.all(
      requests.map((request) => PUT(request))
    );
    for (const response of responses) {
      expect(response.status).toBe(400);
    }
    expect(mocks.saveAiSettings).not.toHaveBeenCalled();
  });

  it("saves a subscription model through the validated connection store", async () => {
    const response = await PUT(
      new Request("https://busy.test/api/ai/settings", {
        body: JSON.stringify({ model: "grok/grok-4.7", provider: "grok" }),
        method: "PUT",
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.saveAiSettings).toHaveBeenCalledWith(
      "grok",
      undefined,
      "grok/grok-4.7"
    );
  });

  it("saves only the supported billing choices", async () => {
    const response = await PUT(
      new Request("https://busy.test/api/ai/settings", {
        body: JSON.stringify({ provider: "gateway" }),
        method: "PUT",
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.saveAiSettings).toHaveBeenCalledWith("gateway");
  });

  it("returns conflict when Token Pass is unavailable", async () => {
    mocks.saveAiSettings.mockRejectedValue(
      new mocks.AiProviderUnavailableError("Token Pass is not configured")
    );

    const response = await PUT(
      new Request("https://busy.test/api/ai/settings", {
        body: JSON.stringify({ provider: "token-pass" }),
        method: "PUT",
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      action: "settings",
      code: "provider_unconfigured",
      error: "provider_unconfigured",
      provider: "token-pass",
      retryable: false,
    });
  });

  it("sanitizes settings write failures", async () => {
    mocks.saveAiSettings.mockRejectedValue(
      new Error("database password leaked")
    );

    const response = await PUT(
      new Request("https://busy.test/api/ai/settings", {
        body: JSON.stringify({ provider: "gateway" }),
        method: "PUT",
      })
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      action: "retry",
      code: "could_not_save",
      error: "could_not_save",
      message: "Busy could not save AI connection settings.",
      provider: "gateway",
      retryable: true,
    });
  });

  it("rejects oversized bodies from the declared length and actual UTF-8 bytes", async () => {
    const declaredTooLarge = await PUT(
      new Request("https://busy.test/api/ai/settings", {
        body: JSON.stringify({ provider: "gateway" }),
        headers: { "content-length": "9000" },
        method: "PUT",
      })
    );
    const unicodeBody = JSON.stringify({
      description: "é".repeat(5000),
      provider: "gateway",
    });
    const actualTooLarge = await PUT(
      new Request("https://busy.test/api/ai/settings", {
        body: unicodeBody,
        headers: { "content-length": "1" },
        method: "PUT",
      })
    );

    expect(declaredTooLarge.status).toBe(413);
    expect(actualTooLarge.status).toBe(413);
    expect(mocks.saveAiSettings).not.toHaveBeenCalled();
  });
});
