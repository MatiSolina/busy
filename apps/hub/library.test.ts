import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeLibraryCursor,
  encodeLibraryCursor,
  listLibraryFiles,
  parseLibraryQuery,
  projectLibraryRow,
} from "./lib/library";

const h = vi.hoisted(() => {
  const files = {
    botId: "files.botId",
    contentType: "files.contentType",
    createdAt: "files.createdAt",
    id: "files.id",
    name: "files.name",
    size: "files.size",
    source: "files.source",
    status: "files.status",
    version: "files.version",
  };
  const bots = {
    avatar: "bots.avatar",
    id: "bots.id",
    name: "bots.name",
    slug: "bots.slug",
  };
  const where = vi.fn();
  const orderBy = vi.fn();
  const limit = vi.fn();
  const chain = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    limit,
    orderBy,
    where,
  };
  const select = vi.fn(() => chain);
  const db = vi.fn(() => ({ select }));
  return {
    bots,
    db,
    files,
    limit,
    orderBy,
    rows: [] as unknown[],
    select,
    where,
  };
});

vi.mock("drizzle-orm", () => {
  const expr = (kind: string, ...args: unknown[]) => ({ args, kind });
  return {
    and: (...args: unknown[]) => expr("and", ...args),
    desc: (value: unknown) => expr("desc", value),
    eq: (left: unknown, right: unknown) => expr("eq", left, right),
    ilike: (left: unknown, right: unknown) => expr("ilike", left, right),
    lt: (left: unknown, right: unknown) => expr("lt", left, right),
    not: (value: unknown) => expr("not", value),
    or: (...args: unknown[]) => expr("or", ...args),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) =>
      expr("sql", strings.join("?"), ...values),
  };
});
vi.mock("@/lib/db", () => ({ bots: h.bots, db: h.db, files: h.files }));

const id = "11111111-1111-4111-8111-111111111111";
const row = (overrides: Record<string, unknown> = {}) => ({
  botAvatar: "🧭",
  botId: "22222222-2222-4222-8222-222222222222",
  botName: "Researcher",
  botSlug: "researcher",
  contentType: "application/pdf",
  createdAt: new Date("2026-11-02T12:00:00.000Z"),
  id,
  name: "brief.pdf",
  size: 1024,
  source: "bot",
  status: "ready",
  version: 2,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.rows = [row()];
  h.where.mockImplementation(() => ({ orderBy: h.orderBy }));
  h.orderBy.mockImplementation(() => ({ limit: h.limit }));
  h.limit.mockImplementation(async () => h.rows);
});

describe("library query contract", () => {
  it("round trips a timestamp/id cursor and rejects malformed cursors", () => {
    const cursor = { createdAt: "2026-11-02T12:00:00.000Z", id };
    expect(decodeLibraryCursor(encodeLibraryCursor(cursor))).toEqual(cursor);
    expect(decodeLibraryCursor("not-base64-json")).toBeNull();
    expect(parseLibraryQuery(new URLSearchParams("cursor=bad"))).toBeNull();
  });

  it("parses the UI filters and clamps page size", () => {
    expect(
      parseLibraryQuery(
        new URLSearchParams("q=invoice&bot=researcher&type=document&limit=1000")
      )
    ).toMatchObject({
      botSlug: "researcher",
      category: "document",
      limit: 100,
      search: "invoice",
    });
    expect(parseLibraryQuery(new URLSearchParams("type=pdf"))).toBeNull();
  });

  it("projects only ready bot files and omits storage internals", () => {
    expect(projectLibraryRow(row())).toEqual({
      bot: { avatar: "🧭", name: "Researcher", slug: "researcher" },
      contentType: "application/pdf",
      createdAt: "2026-11-02T12:00:00.000Z",
      id,
      name: "brief.pdf",
      size: 1024,
      version: 2,
    });
    expect(projectLibraryRow(row({ status: "pending" }))).toBeNull();
    expect(projectLibraryRow(row({ source: "user" }))).toBeNull();
    expect(JSON.stringify(projectLibraryRow(row()))).not.toContain("pathname");
  });

  it("uses deterministic createdAt/id pagination and returns the next cursor", async () => {
    const second = row({
      createdAt: new Date("2026-11-02T11:00:00.000Z"),
      id: "33333333-3333-4333-8333-333333333333",
    });
    h.rows = [row(), second];
    h.limit.mockImplementation(async () => h.rows);
    const result = await listLibraryFiles({
      botSlug: null,
      category: null,
      cursor: null,
      limit: 1,
      search: null,
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.id).toBe(id);
    expect(decodeLibraryCursor(result.nextCursor)).toEqual({
      createdAt: "2026-11-02T12:00:00.000Z",
      id,
    });
    const where = h.where.mock.calls[0]?.[0];
    const serialized = JSON.stringify(where);
    expect(serialized).toContain("ready");
    expect(serialized).toContain("bot");
    expect(h.orderBy).toHaveBeenCalledOnce();
    expect(h.limit).toHaveBeenCalledWith(2);
  });
});
