import { describe, expect, it } from "vitest";
import { catalogEntry, catalogHash, MCP_CATALOG_VERSION } from "./catalog";

describe("MCP catalog descriptors", () => {
  it("keeps the existing GitHub descriptor hash stable when Vercel is added", () => {
    const github = catalogEntry("github");
    expect(github).toBeDefined();
    expect(MCP_CATALOG_VERSION).toBe("2026-11-02");
    expect(catalogHash(github as NonNullable<typeof github>)).toBe(
      "90a969dd3baf61310f087393a2de6d2f6a5ee9663a41c7697851d95d7c153901"
    );
  });
});
