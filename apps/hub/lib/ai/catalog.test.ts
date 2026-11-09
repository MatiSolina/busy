import { describe, expect, it } from "vitest";
import { aiProviderCatalog } from "@/lib/ai/catalog";

describe("AI provider catalog", () => {
  it("offers OAuth connections instead of incorrectly blocking subscription access", () => {
    const providers = aiProviderCatalog({ TOKEN_PASS_API_KEY: "configured" });

    expect(
      providers.find((provider) => provider.id === "gateway")?.status
    ).toBe("available");
    expect(
      providers.find((provider) => provider.id === "token-pass")?.status
    ).toBe("available");
    expect(
      providers.find((provider) => provider.id === "chatgpt")
    ).toMatchObject({
      status: "not-connected",
    });
    expect(providers.find((provider) => provider.id === "grok")).toMatchObject({
      status: "not-connected",
    });
  });

  it("reports an unconfigured Token Pass without exposing a credential", () => {
    const tokenPass = aiProviderCatalog({}).find(
      (provider) => provider.id === "token-pass"
    );

    expect(tokenPass).toMatchObject({ status: "unconfigured" });
    expect(tokenPass?.detail).toContain("isn't set up");
    expect(
      JSON.stringify(
        aiProviderCatalog({ TOKEN_PASS_API_KEY: "private-test-value" })
      )
    ).not.toContain("private-test-value");
  });
});
