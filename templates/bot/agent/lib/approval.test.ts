import { describe, expect, it } from "vitest";
import {
  approvalPrompt,
  bareToolName,
  currentMarketplaceToolPolicy,
  marketplaceApprovalPolicy,
  marketplaceToolPolicy,
  summarizeInput,
  toolKind,
} from "./approval";

const mati = {
  auth: {
    current: {
      attributes: {},
      authenticator: "test",
      principalId: "busy-hub",
      principalType: "service",
    },
    initiator: null,
  },
  id: "session-main",
  turn: { id: "turn-main", sequence: 1 },
};
const peer = {
  auth: {
    current: {
      attributes: {},
      authenticator: "test",
      principalId: "owner:team:project:bot-lawyer:environment:production",
      principalType: "user",
    },
    initiator: null,
  },
  id: "session-peer",
  turn: { id: "turn-peer", sequence: 1 },
};

const policy = (
  toolName: string,
  toolAnnotations?: Record<string, unknown>,
  session: unknown = mati
) =>
  marketplaceApprovalPolicy({
    session,
    toolAnnotations,
    toolName,
  } as Parameters<typeof marketplaceApprovalPolicy>[0]);

describe("MCP approval policy", () => {
  it("strips the connection prefix", () => {
    expect(bareToolName("mcp_gmail__send_message")).toBe("send_message");
    expect(bareToolName("mcp-gmail__send_message")).toBe("send_message");
    expect(bareToolName("listIssues")).toBe("listissues");
  });

  it("lets reads run and stops writes", () => {
    expect(policy("mcp_gmail__search_threads")).toBe("not-applicable");
    expect(policy("mcp_linear__listIssues")).toBe("not-applicable");
    expect(policy("mcp_gmail__send_message")).toBe("user-approval");
    expect(policy("mcp_stripe__create_refund")).toBe("user-approval");
    expect(policy("mcp-github__create_pull_request")).toBe("user-approval");
  });

  it("treats an unknown verb as a write", () => {
    expect(toolKind("mcp_x__frobnicate")).toBe("write");
    expect(toolKind("mcp_shop__checkout")).toBe("write");
  });

  it("trusts declared annotations over the name", () => {
    expect(policy("mcp_x__send_report", { readOnlyHint: true })).toBe(
      "not-applicable"
    );
    expect(policy("mcp_x__get_and_delete", { readOnlyHint: false })).toBe(
      "user-approval"
    );
    expect(policy("mcp_x__list_purge", { destructiveHint: true })).toBe(
      "user-approval"
    );
  });

  it("denies every MCP call in a consultation, reads included (H-07)", () => {
    expect(policy("mcp_gmail__send_message", undefined, peer)).toMatchObject({
      type: "denied",
    });
    // A read still sends its arguments to the provider; readOnlyHint is no confidentiality promise.
    expect(policy("mcp_gmail__get_thread", undefined, peer)).toMatchObject({
      type: "denied",
    });
    expect(
      policy("mcp_search__search", { readOnlyHint: true }, peer)
    ).toMatchObject({ type: "denied" });
    // The user's own chat keeps the usual read/write split.
    expect(policy("mcp_gmail__get_thread")).toBe("not-applicable");
    expect(policy("mcp_gmail__send_message")).toBe("user-approval");
  });

  it("denies a consultation's allowlisted read before the remote sees it, enforced or legacy", async () => {
    const fetcher = (aclMode: string) => async () =>
      Response.json({
        connections: [
          { aclMode, allowedTools: ["read_issue"], id: "connection-1" },
        ],
      });
    for (const mode of ["enforced", "legacy"]) {
      // biome-ignore lint/performance/noAwaitInLoops: two independent modes, checked in order
      await expect(
        currentMarketplaceToolPolicy(
          "connection-1",
          ["read_issue"],
          {
            session: peer,
            toolAnnotations: { readOnlyHint: true },
            toolName: "mcp_linear__read_issue",
          },
          fetcher(mode)
        )
      ).resolves.toMatchObject({ type: "denied" });
    }
  });

  it("denies a tool outside the connection allowlist before approvals", () => {
    expect(
      marketplaceToolPolicy(["read_issue"], {
        session: mati,
        toolAnnotations: { readOnlyHint: true },
        toolName: "mcp_linear__delete_issue",
      })
    ).toMatchObject({ type: "denied" });
    expect(
      marketplaceToolPolicy(["read_issue"], {
        session: mati,
        toolAnnotations: { readOnlyHint: true },
        toolName: "mcp_linear__read_issue",
      })
    ).toBe("not-applicable");
  });

  it("re-reads revocation from the hub even when the session has stale tools", async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          connections: [{ allowedTools: [], id: "connection-1" }],
        }),
        { status: 200 }
      );
    await expect(
      currentMarketplaceToolPolicy(
        "connection-1",
        ["read_issue"],
        {
          session: mati,
          toolAnnotations: { readOnlyHint: true },
          toolName: "mcp_linear__read_issue",
        },
        fetcher
      )
    ).resolves.toMatchObject({ type: "denied" });
  });

  it("denies a stale model call to a tool now reserved for an MCP App", async () => {
    await expect(
      currentMarketplaceToolPolicy(
        "connection-1",
        ["refresh_deployments"],
        {
          session: mati,
          toolAnnotations: { readOnlyHint: true },
          toolName: "mcp_vercel__refresh_deployments",
        },
        async () =>
          Response.json({
            connections: [
              {
                allowedTools: ["refresh_deployments"],
                id: "connection-1",
                tools: [
                  { name: "refresh_deployments", ui: { visibility: ["app"] } },
                ],
              },
            ],
          })
      )
    ).resolves.toMatchObject({ type: "denied" });
  });
});

describe("approval prompt", () => {
  it("names the outward action, the app and the key fields", () => {
    expect(
      approvalPrompt({
        input: { body: "Hi Ana", subject: "Invoice", to: ["ana@example.com"] },
        toolName: "mcp_gmail__send_message",
      })
    ).toBe(
      "I'm about to send or publish something in Gmail (send message). to: ana@example.com · subject: Invoice · body: Hi Ana. OK?"
    );
    expect(
      approvalPrompt({
        input: { amount: 1200 },
        toolName: "mcp_stripe__create_refund",
      })
    ).toBe(
      "I'm about to move money in Stripe (create refund). amount: 1200. OK?"
    );
    expect(
      approvalPrompt({ input: {}, toolName: "mcp_notion__update_page" })
    ).toBe('I\'m about to use "update page" in Notion. OK?');
  });

  it("keeps the summary short and ignores nested values", () => {
    expect(
      summarizeInput({ body: "x".repeat(500) }).length
    ).toBeLessThanOrEqual(160);
    expect(summarizeInput({ nested: { to: "a" } })).toBe("");
    expect(summarizeInput(undefined)).toBe("");
  });
});
