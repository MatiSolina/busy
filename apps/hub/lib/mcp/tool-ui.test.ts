import { describe, expect, it } from "vitest";
import {
  isAppVisible,
  isModelVisible,
  mcpAppSnapshotId,
  toolUiMetadata,
} from "./tool-ui";

describe("MCP Apps tool metadata", () => {
  it("recognizes a proxy marker without discarding multimodal content", () => {
    const snapshotId = "1ce3c56e-de0f-4bfd-bd86-8b2457293dd7";
    expect(
      mcpAppSnapshotId([
        { data: "AAAA", mimeType: "image/png", type: "image" },
        { text: "Normal result", type: "text" },
        { text: JSON.stringify({ _busyMcpApp: { snapshotId } }), type: "text" },
      ])
    ).toBe(snapshotId);
    expect(
      mcpAppSnapshotId({ _busyMcpApp: { snapshotId: "bad" } })
    ).toBeUndefined();
  });
  it("keeps UI linkage and visibility without retaining unrelated metadata", () => {
    expect(
      toolUiMetadata({
        secret: "not public",
        ui: {
          resourceUri: "ui://vercel/deployments",
          visibility: ["model", "app"],
        },
      })
    ).toEqual({
      resourceUri: "ui://vercel/deployments",
      visibility: ["model", "app"],
    });
    expect(toolUiMetadata({ "ui/resourceUri": "ui://legacy/card" })).toEqual({
      resourceUri: "ui://legacy/card",
    });
  });

  it("rejects external resource URIs and does not turn invalid visibility into model access", () => {
    expect(
      toolUiMetadata({ ui: { resourceUri: "https://evil.test" } })
    ).toBeUndefined();
    const ui = toolUiMetadata({ ui: { visibility: ["unknown", 42] } });
    expect(isModelVisible(ui)).toBe(false);
    expect(isAppVisible(ui)).toBe(false);
  });

  it("excludes app-only tools from model access, with protocol defaults for omitted visibility", () => {
    expect(isModelVisible({ visibility: ["app"] })).toBe(false);
    expect(isAppVisible({ visibility: ["model"] })).toBe(false);
    expect(isModelVisible()).toBe(true);
    expect(isAppVisible()).toBe(true);
  });
});
