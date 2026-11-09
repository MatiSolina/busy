import assert from "node:assert/strict";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptOAuth, encryptOAuth } from "./lib/mcp/crypto";
import type { OAuthData } from "./lib/mcp/oauth";

import {
  publicConnection,
  updateAllowedTools,
  withConnection,
} from "./lib/mcp/store";

const harness = vi.hoisted(() => {
  const forUpdate = vi.fn();
  const updateWhere = vi.fn().mockResolvedValue([]);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const selectWhere = vi.fn(() => ({ for: forUpdate }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));
  const directLimit = vi.fn();
  const directWhere = vi.fn(() => ({ limit: directLimit }));
  const directFrom = vi.fn(() => ({ where: directWhere }));
  const directSelect = vi.fn(() => ({ from: directFrom }));
  const update = vi.fn(() => ({ set: updateSet }));
  const execute = vi.fn().mockResolvedValue([]);
  const tx = { execute, select, update };
  const transaction = vi.fn(async (callback: (value: typeof tx) => unknown) =>
    callback(tx)
  );
  const db = vi.fn(() => ({ select: directSelect, transaction }));
  const need = vi.fn(() => "test-session-secret-which-is-long-enough");
  return {
    db,
    directLimit,
    forUpdate,
    need,
    transaction,
    tx,
    updateSet,
    updateWhere,
  };
});

vi.mock("@/lib/db", () => ({
  db: harness.db,
  mcpConnections: {
    botId: { name: "bot_id" },
    catalogId: { name: "catalog_id" },
    createdAt: { name: "created_at" },
    id: { name: "id" },
  },
}));
vi.mock("@/lib/env", () => ({ need: harness.need }));
vi.mock("drizzle-orm", () => ({
  asc: (value: unknown) => ({ kind: "asc", value }),
  eq: (left: unknown, right: unknown) => ({ kind: "eq", left, right }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
}));

const connectionId = "11111111-1111-4111-8111-111111111111";
const secret = "test-session-secret-which-is-long-enough";
const row = {
  botId: "bot-alpha",
  catalogId: "linear",
  error: null,
  id: connectionId,
  oauthData: encryptOAuth(
    {
      tokens: {
        access_token: "access-secret",
        expires_in: 3600,
        refresh_token: "refresh-secret",
      },
      tokensIssuedAt: 1_700_000_000_000,
    },
    connectionId,
    secret
  ),
  status: "connected" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  harness.need.mockReturnValue(secret);
  harness.forUpdate.mockResolvedValue([row]);
});

describe("MCP connection store", () => {
  it("projects connection rows without encrypted OAuth material", () => {
    const projected = publicConnection(row);
    expect(projected).toEqual({
      catalogId: "linear",
      error: null,
      id: connectionId,
      status: "connected",
    });
    expect(JSON.stringify(projected)).not.toContain("access-secret");
    expect(JSON.stringify(projected)).not.toContain("oauthData");
  });

  it("decrypts under the connection AAD and re-encrypts updated credentials", async () => {
    const result = await withConnection(
      connectionId,
      // biome-ignore lint/suspicious/useAwait: test double intentionally preserves the Promise-returning API contract.
      async (selected, data) => {
        expect(selected.id).toBe(connectionId);
        expect(data.tokens?.access_token).toBe("access-secret");
        assert(data.tokens);
        return {
          data: {
            ...data,
            tokens: { ...data.tokens, access_token: "rotated-access" },
          },
          error: null,
          status: "connected",
          value: { token: "ok" },
        };
      }
    );

    expect(result).toEqual({ token: "ok" });
    const written = (
      harness.updateSet.mock.calls as unknown as unknown[][]
    )[0]?.[0] as { oauthData: string };
    expect(written.oauthData).toBeTypeOf("string");
    expect(written.oauthData).not.toContain("rotated-access");
    expect(
      decryptOAuth<OAuthData>(written.oauthData, connectionId, secret).tokens
        ?.access_token
    ).toBe("rotated-access");
  });

  it("returns null and never runs the callback for a missing app connection", async () => {
    harness.forUpdate.mockResolvedValue([]);
    const callback = vi.fn();
    await expect(withConnection(connectionId, callback)).resolves.toBeNull();
    expect(callback).not.toHaveBeenCalled();
    expect(harness.updateSet).not.toHaveBeenCalled();
  });

  it("rejects ACL edits for an unreviewed catalog revision without rotating tokens", async () => {
    const stale = {
      ...row,
      oauthData: encryptOAuth(
        {
          busyMcp: {
            allowedTools: ["read_issue"],
            auth: "oauth",
            catalogHash: "catalog-hash-before-revision",
            endpoint: "https://stale.example/mcp",
            reviewedAt: "2026-11-02T00:00:00.000Z",
            scopes: "stale-scope",
          },
          tokens: {
            access_token: "access-secret",
            expires_in: 3600,
            refresh_token: "refresh-secret",
          },
          tokensIssuedAt: 1_700_000_000_000,
        },
        connectionId,
        secret
      ),
    };
    harness.directLimit.mockResolvedValue([stale]);

    await expect(
      updateAllowedTools(connectionId, ["read_issue"])
    ).rejects.toMatchObject({
      message: "Review this MCP update before changing its tools.",
      status: 409,
    });
    expect(harness.transaction).not.toHaveBeenCalled();
    expect(harness.updateSet).not.toHaveBeenCalled();
    expect(
      decryptOAuth<OAuthData>(stale.oauthData, connectionId, secret).tokens
        ?.access_token
    ).toBe("access-secret");
  });
});
