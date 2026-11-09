import { describe, expect, it } from "vitest";
import { callSettled, requested, seq } from "./chat.test-helpers";
import { toChatView } from "./items";

const snapshotId = "1ce3c56e-de0f-4bfd-bd86-8b2457293dd7";
const marker = { _busyMcpApp: { snapshotId } };

describe("MCP Apps in persisted and streamed chat facts", () => {
  it("renders a nominated MCP App without copying its private data into chat items", () => {
    const facts = seq(
      requested("call-1", "mcp_vercel__open_deployments", { project: "demo" }),
      callSettled("call-1", "completed", marker)
    );
    const view = toChatView(facts, new Map(), new Map());
    expect(view.items).toContainEqual({
      callId: "call-1",
      id: "call-1:app",
      kind: "mcp-app",
      toolName: "mcp_vercel__open_deployments",
    });
    expect(JSON.stringify(view.items)).not.toContain(snapshotId);
    expect(toChatView([...facts, ...facts], new Map(), new Map())).toEqual(
      view
    );
  });

  it("renders an MCP App from a dash-prefixed connection name", () => {
    const view = toChatView(
      seq(
        requested("call-dash", "mcp-vercel__open_deployments"),
        callSettled("call-dash", "completed", marker)
      ),
      new Map(),
      new Map()
    );

    expect(view.items).toContainEqual({
      callId: "call-dash",
      id: "call-dash:app",
      kind: "mcp-app",
      toolName: "mcp-vercel__open_deployments",
    });
  });

  it("keeps ordinary tools and unsuccessful MCP calls as chat activity", () => {
    const view = toChatView(
      seq(
        requested("ordinary", "some_tool"),
        callSettled("ordinary", "completed", marker),
        requested("failed", "mcp_vercel__open_deployments"),
        callSettled("failed", "failed", marker),
        requested("normal", "mcp_vercel__list_projects"),
        callSettled("normal", "completed", { projects: [] })
      ),
      new Map(),
      new Map()
    );
    expect(view.items.some((item) => item.kind === "mcp-app")).toBe(false);
  });
});
