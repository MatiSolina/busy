import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defined } from "../test-utils";
import dynamic from "./send_file";

const hubFetch = vi.hoisted(() =>
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>()
);
vi.mock("../lib/hub", () => ({ hubFetch }));

interface Tool {
  description: string;
  execute: (
    input: { path: string },
    ctx: unknown
  ) => Promise<Record<string, unknown>>;
  inputSchema: { safeParse: (v: unknown) => { success: boolean } };
}
const resolve = (principalId: string | null, parent?: { callId: string }) => {
  const [key] = Object.getOwnPropertySymbols(dynamic);
  const fn = (
    dynamic as unknown as Record<symbol, (ctx: unknown) => Tool | null>
  )[defined(key)];
  return fn({
    session: {
      auth: {
        current:
          principalId === null ? null : { principalId, principalType: "app" },
        initiator: null,
      },
      id: "s",
      parent,
    },
  });
};
const tool = () => defined(resolve("hub"));

const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const fetchMock =
  vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
let readBinaryFile: ReturnType<typeof vi.fn>;
const ctx = () => ({
  getSandbox: async () => ({ readBinaryFile }),
  session: {
    auth: {
      current: { principalId: "hub", principalType: "app" },
      initiator: null,
    },
    id: "s",
    parent: undefined,
  },
});
const send = (path: string) => tool().execute({ path }, ctx());

beforeEach(() => {
  readBinaryFile = vi.fn(async () => new Uint8Array([1, 2, 3, 4, 5]));
  hubFetch.mockReset().mockImplementation(async (path) =>
    path === "/api/bot/files"
      ? Response.json({
          fileId: "f1",
          uploadUrl: "https://blob.example.com/up?sig=1",
        })
      : new Response(null)
  );
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("send_file: who gets it", () => {
  it.each([
    ["The user's chat through the hub", "hub"],
    ["an unprotected local session", null],
  ])("is offered in %s", (_, principalId) => {
    expect(resolve(principalId)).not.toBeNull();
  });

  it("is hidden in a consultation: another bot never puts files in the user's chat", () => {
    expect(
      resolve("owner:t:project:bot-lawyer:environment:production")
    ).toBeNull();
  });

  it("is hidden in a child task so the root owns the user-facing delivery", () => {
    expect(resolve("hub", { callId: "call-1" })).toBeNull();
  });

  it("rejects a stale child call before reading or uploading the artifact", async () => {
    const child = {
      getSandbox: async () => ({ readBinaryFile: vi.fn() }),
      session: {
        auth: { current: { principalId: "hub" } },
        parent: { callId: "call-1" },
      },
    };
    const result = await tool().execute(
      { path: "/data/out/report.docx" },
      child
    );
    expect(result).toEqual({
      error:
        "Only the user-facing session can deliver files; return the artifact path to its parent.",
    });
    expect(hubFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["an absolute path", "/data/out/report.docx", true],
    ["a relative path", "out/report.docx", true],
    ["an empty path", "", false],
    ["no path", undefined, false],
  ])("input schema with %s → %s", (_, path, ok) => {
    expect(
      tool().inputSchema.safeParse(path === undefined ? {} : { path }).success
    ).toBe(ok);
  });
});

describe("send_file: sending", () => {
  it("reserves, uploads and completes, in that order", async () => {
    expect(await send("/data/out/report.docx")).toEqual({
      contentType: DOCX,
      fileId: "f1",
      name: "report.docx",
      size: 5,
    });
    expect(
      hubFetch.mock.calls.map(([p, init]) => `${init?.method} ${p}`)
    ).toEqual(["POST /api/bot/files", "POST /api/bot/files/f1/complete"]);
    expect(hubFetch.mock.calls[0]?.[1]?.headers).toEqual({
      "x-busy-session-id": "s",
    });
    expect(hubFetch.mock.calls[1]?.[1]?.headers).toEqual({
      "x-busy-session-id": "s",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(defined(fetchMock.mock.invocationCallOrder[0])).toBeLessThan(
      defined(hubFetch.mock.invocationCallOrder[1])
    );
  });

  it("tells the hub the name, type and size it reserves", async () => {
    await send("/data/out/report.docx");
    expect(
      JSON.parse(String(defined(hubFetch.mock.calls[0])[1]?.body))
    ).toEqual({
      contentType: DOCX,
      name: "report.docx",
      size: 5,
    });
  });

  it("PUTs the exact bytes with the same content type", async () => {
    await send("/data/out/report.docx");
    const [url, init] = defined(fetchMock.mock.calls[0]);
    expect(url).toBe("https://blob.example.com/up?sig=1");
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toEqual({ "content-type": DOCX });
    const body = init?.body;
    if (!body) {
      throw new Error("Expected an upload body.");
    }
    expect([...(body as Uint8Array)]).toEqual([1, 2, 3, 4, 5]);
  });

  it.each([
    ["/data/out/Photo.PNG", "Photo.PNG", "image/png"],
    [
      "/workspace/with spaces/final minutes.pdf",
      "final minutes.pdf",
      "application/pdf",
    ],
    ["/data/out/notes", "notes", "application/octet-stream"],
    ["/data/out/data.csv.json", "data.csv.json", "application/json"],
    [
      "report.xlsx",
      "report.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  ])("sends %s as %s (%s)", async (path, name, contentType) => {
    expect(await send(path)).toMatchObject({ contentType, name });
  });

  it("sends an empty file with size 0", async () => {
    readBinaryFile.mockResolvedValueOnce(new Uint8Array(0));
    expect(await send("/data/out/empty.txt")).toMatchObject({ size: 0 });
  });

  it("reads the file from the bot's computer at the given path", async () => {
    await send("/data/out/report.docx");
    expect(readBinaryFile).toHaveBeenCalledWith({
      path: "/data/out/report.docx",
    });
  });
});

describe("send_file: failures the model sees", () => {
  it("says so when the file doesn't exist, without touching the hub", async () => {
    readBinaryFile.mockResolvedValueOnce(null);
    expect(await send("/data/out/missing.pdf")).toEqual({
      error: "/data/out/missing.pdf doesn't exist",
    });
    expect(hubFetch).not.toHaveBeenCalled();
  });

  it.each([400, 413, 500])(
    "stops when the hub won't reserve (%i)",
    async (status) => {
      hubFetch.mockResolvedValueOnce(new Response(null, { status }));
      expect(await send("/data/out/a.pdf")).toEqual({
        error: `Couldn't reserve the file (${status})`,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([403, 500])(
    "stops when the upload fails (%i) and never completes",
    async (status) => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status }));
      expect(await send("/data/out/a.pdf")).toEqual({
        error: `Couldn't upload the file (${status})`,
      });
      expect(hubFetch).toHaveBeenCalledTimes(1);
    }
  );

  it.each([404, 409, 500])(
    "reports a failed completion (%i)",
    async (status) => {
      hubFetch.mockImplementation(async (path) =>
        path === "/api/bot/files"
          ? Response.json({
              fileId: "f1",
              uploadUrl: "https://blob.example.com/up",
            })
          : new Response(null, { status })
      );
      expect(await send("/data/out/a.pdf")).toEqual({
        error: `Couldn't finish sending the file (${status})`,
      });
    }
  );
});
