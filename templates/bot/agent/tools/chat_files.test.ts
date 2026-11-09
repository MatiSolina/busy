import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defined } from "../test-utils";
import definition from "./chat_files";

const hubFetch = vi.hoisted(() =>
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>()
);
vi.mock("../lib/hub", () => ({ hubFetch }));

const tool = definition as unknown as {
  inputSchema: { safeParse: (v: unknown) => { success: boolean } };
  execute: (
    input: { id?: string },
    ctx: unknown
  ) => Promise<Record<string, unknown>>;
};

const ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const fetchMock =
  vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const DOT_NAME = /^\.{1,2}$/u;
const OTHER_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
// A tiny in-memory sandbox: files by path, and the one `mv` the tool runs.
let sandboxFiles: Map<string, Uint8Array>;
let writeBinaryFile: ReturnType<typeof vi.fn>;
let runCommand: ReturnType<typeof vi.fn>;
let removePath: ReturnType<typeof vi.fn>;
const ctx = () => ({
  getSandbox: async () => ({ removePath, run: runCommand, writeBinaryFile }),
});
const run = (id?: string) =>
  tool.execute(id === undefined ? {} : { id }, ctx());
const file = (filename: string) =>
  Response.json({ filename, url: "https://blob.example.com/f?sig=1" });

beforeEach(() => {
  sandboxFiles = new Map();
  writeBinaryFile = vi.fn(
    ({ content, path }: { content: Uint8Array; path: string }) => {
      sandboxFiles.set(path, content);
      return Promise.resolve();
    }
  );
  runCommand = vi.fn(
    ({ env }: { command: string; env: Record<string, string> }) => {
      const from = defined(env.BUSY_CHAT_PART);
      const content = sandboxFiles.get(from);
      if (!content) {
        return Promise.resolve({ exitCode: 1, stderr: "missing", stdout: "" });
      }
      sandboxFiles.delete(from);
      sandboxFiles.set(defined(env.BUSY_CHAT_PATH), content);
      return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
    }
  );
  removePath = vi.fn(({ path }: { path: string }) => {
    sandboxFiles.delete(path);
    return Promise.resolve();
  });
  hubFetch.mockReset();
  fetchMock
    .mockReset()
    .mockImplementation(async () => new Response(new Uint8Array([9, 8, 7])));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("chat_files: input", () => {
  it.each([
    ["no id (list)", {}, true],
    ["a uuid", { id: ID }, true],
    ["a non-uuid id", { id: "report.pdf" }, false],
    ["a path-like id", { id: `../${ID}` }, false],
    ["an empty id", { id: "" }, false],
  ])("schema with %s → %s", (_, input, ok) => {
    expect(tool.inputSchema.safeParse(input).success).toBe(ok);
  });
});

describe("chat_files: listing", () => {
  it("lists the chat's files from the hub", async () => {
    const files = [{ filename: "minutes.pdf", id: ID }];
    hubFetch.mockResolvedValueOnce(Response.json(files));
    expect(await run()).toEqual({ files });
    expect(hubFetch).toHaveBeenCalledWith("/api/bot/files");
  });

  it("lists an empty chat", async () => {
    hubFetch.mockResolvedValueOnce(Response.json([]));
    expect(await run()).toEqual({ files: [] });
  });

  it.each([401, 500])("reports a failed list (%i)", async (status) => {
    hubFetch.mockResolvedValueOnce(new Response(null, { status }));
    expect(await run()).toEqual({
      error: `Couldn't list the files (${status})`,
    });
  });
});

const dest = (name: string, id = ID) => `/workspace/chat/${id}-${name}`;

describe("chat_files: copying one file", () => {
  it("copies the latest version into /workspace/chat under its id and returns the path", async () => {
    hubFetch.mockResolvedValueOnce(file("minutes.pdf"));
    expect(await run(ID)).toEqual({ path: dest("minutes.pdf") });
    expect(hubFetch).toHaveBeenCalledWith(`/api/bot/files/${ID}`);
    expect(defined(fetchMock.mock.calls[0])[0]).toBe(
      "https://blob.example.com/f?sig=1"
    );
    expect([...defined(sandboxFiles.get(dest("minutes.pdf")))]).toEqual([
      9, 8, 7,
    ]);
    // Nothing else is left behind: the partial file was renamed into place.
    expect([...sandboxFiles.keys()]).toEqual([dest("minutes.pdf")]);
  });

  it("writes to a partial file first and renames it, so the destination is never half-written", async () => {
    hubFetch.mockResolvedValueOnce(file("minutes.pdf"));
    await run(ID);
    const written = (
      defined(writeBinaryFile.mock.calls[0])[0] as {
        path: string;
      }
    ).path;
    expect(written).not.toBe(dest("minutes.pdf"));
    expect(written.startsWith(`/workspace/chat/.${ID}.`)).toBe(true);
    expect(defined(runCommand.mock.calls[0])[0]).toMatchObject({
      env: { BUSY_CHAT_PART: written, BUSY_CHAT_PATH: dest("minutes.pdf") },
    });
  });

  it("keeps two files with the same name (two versions) apart", async () => {
    hubFetch.mockResolvedValueOnce(file("minutes.pdf"));
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1])));
    hubFetch.mockResolvedValueOnce(file("minutes.pdf"));
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([2])));
    const first = await run(ID);
    const second = await run(OTHER_ID);
    expect(first).toEqual({ path: dest("minutes.pdf") });
    expect(second).toEqual({ path: dest("minutes.pdf", OTHER_ID) });
    expect([...defined(sandboxFiles.get(dest("minutes.pdf")))]).toEqual([1]);
    expect([
      ...defined(sandboxFiles.get(dest("minutes.pdf", OTHER_ID))),
    ]).toEqual([2]);
  });

  it("lands a retry of the same id on the same path, replacing it", async () => {
    hubFetch.mockResolvedValueOnce(file("minutes.pdf"));
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1])));
    hubFetch.mockResolvedValueOnce(file("minutes.pdf"));
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([2])));
    expect(await run(ID)).toEqual(await run(ID));
    expect([...sandboxFiles.keys()]).toEqual([dest("minutes.pdf")]);
    expect([...defined(sandboxFiles.get(dest("minutes.pdf")))]).toEqual([2]);
  });

  it.each([
    ["a nested name", "folder/minutes.pdf", "folder_minutes.pdf"],
    [
      "a parent-directory escape",
      "../../data/memory.md",
      ".._.._data_memory.md",
    ],
    ["an absolute name", "/etc/passwd", "_etc_passwd"],
    ["a backslash path", "..\\..\\x.txt", ".._.._x.txt"],
    ["a control character", "a\nb\u0000c\u007f.txt", "a_b_c_.txt"],
    ["exactly .", ".", "file"],
    ["exactly ..", "..", "file"],
    ["an empty name", "", "file"],
    ["only spaces", "   ", "file"],
    [
      "spaces and accents",
      "Café meeting résumé.docx",
      "Café meeting résumé.docx",
    ],
  ])(
    "keeps %s inside /workspace/chat as a regular file",
    async (_, filename, expected) => {
      hubFetch.mockResolvedValueOnce(file(filename));
      const result = (await run(ID)) as { path: string };
      expect(result).toEqual({ path: dest(expected) });
      const [dir, name] = [
        result.path.slice(0, result.path.lastIndexOf("/")),
        result.path.slice(result.path.lastIndexOf("/") + 1),
      ];
      expect(dir).toBe("/workspace/chat");
      expect(name).not.toMatch(DOT_NAME);
      expect(sandboxFiles.has(result.path)).toBe(true);
    }
  );

  it("caps a very long name below the filesystem's limit", async () => {
    hubFetch.mockResolvedValueOnce(file(`${"é".repeat(300)}.pdf`));
    const { path } = (await run(ID)) as { path: string };
    const name = path.slice("/workspace/chat/".length);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
  });

  it("reports a failed rename and removes the partial file", async () => {
    hubFetch.mockResolvedValueOnce(file("minutes.pdf"));
    runCommand.mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" });
    expect(await run(ID)).toEqual({
      error: "Couldn't save the file in /workspace/chat",
    });
    expect([...sandboxFiles.keys()]).toEqual([]);
    expect(removePath).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404])(
    "reports a file the hub doesn't have (%i)",
    async (status) => {
      hubFetch.mockResolvedValueOnce(new Response(null, { status }));
      expect(await run(ID)).toEqual({
        error: `Couldn't find the file (${status})`,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([403, 410])(
    "reports a failed download (%i) and writes nothing",
    async (status) => {
      hubFetch.mockResolvedValueOnce(file("minutes.pdf"));
      fetchMock.mockResolvedValueOnce(new Response(null, { status }));
      expect(await run(ID)).toEqual({
        error: `Couldn't download the file (${status})`,
      });
      expect(writeBinaryFile).not.toHaveBeenCalled();
    }
  );
});
