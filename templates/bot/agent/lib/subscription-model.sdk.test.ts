import { generateText } from "ai";
import { describe, expect, it, vi } from "vitest";
import { subscriptionModel } from "./subscription-model";

const getVercelOidcToken = vi.hoisted(() => vi.fn(async () => "oidc-token"));

vi.mock("@vercel/oidc", () => ({ getVercelOidcToken }));

describe("subscription model SDK error boundary", () => {
  it("keeps the canonical Busy code in the OpenAI SDK error data", async () => {
    vi.stubEnv("HUB_URL", "https://busy.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            code: "provider_unavailable",
            error: "provider_unavailable",
            message: "private raw details",
            provider: "grok",
          },
          { status: 503 }
        )
      )
    );

    const error = await generateText({
      maxRetries: 0,
      model: subscriptionModel("grok", "grok/grok-4.7"),
      prompt: "hi",
    }).catch((value: unknown) => value);

    expect(error).toMatchObject({
      data: {
        error: { code: "provider_unavailable" },
      },
      message: "Grok could not complete this request.",
      name: "AI_APICallError",
      statusCode: 503,
    });
    expect(JSON.stringify(error)).not.toContain("private raw details");

    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});
