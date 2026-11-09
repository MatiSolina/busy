import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./app/api/library/route";

const h = vi.hoisted(() => ({
  cookies: vi.fn(),
  listLibraryFiles: vi.fn(),
  parseLibraryQuery: vi.fn(),
  readSession: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: h.cookies }));
vi.mock("@/lib/auth/session", () => ({
  readSession: h.readSession,
  SESSION_COOKIE: "busy_session",
}));
vi.mock("@/lib/library", () => ({
  listLibraryFiles: h.listLibraryFiles,
  parseLibraryQuery: h.parseLibraryQuery,
}));

const query = {
  botSlug: null,
  category: null,
  cursor: null,
  limit: 48,
  search: null,
};
const result = { files: [], nextCursor: null };

beforeEach(() => {
  vi.resetAllMocks();
  process.env.SESSION_SECRET = "test-session-secret";
  h.cookies.mockResolvedValue({
    get: vi.fn(() => ({ value: "session-token" })),
  });
  h.readSession.mockResolvedValue({ user: "mati" });
  h.parseLibraryQuery.mockReturnValue(query);
  h.listLibraryFiles.mockResolvedValue(result);
});

describe("/api/library", () => {
  it("requires the Busy session before querying generated files", async () => {
    h.readSession.mockResolvedValue(null);
    const response = await GET(new Request("https://busy.test/api/library"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(h.listLibraryFiles).not.toHaveBeenCalled();
  });

  it("returns the paginated library response with private no-store headers", async () => {
    const response = await GET(
      new Request("https://busy.test/api/library?type=document")
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(h.parseLibraryQuery).toHaveBeenCalledOnce();
    expect(h.listLibraryFiles).toHaveBeenCalledWith(query);
  });

  it("rejects malformed filters without querying the database", async () => {
    h.parseLibraryQuery.mockReturnValue(null);
    const response = await GET(
      new Request("https://busy.test/api/library?limit=0")
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_query" });
    expect(h.listLibraryFiles).not.toHaveBeenCalled();
  });
});
