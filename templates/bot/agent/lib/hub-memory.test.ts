import { MemoryDocumentConflictError } from "eve/memory/file";
import { describe, expect, it } from "vitest";
import { hubMemoryBackend } from "./hub-memory";

const { signal } = new AbortController();
const fake = (status: number, body?: unknown) => async () =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

describe("hubMemoryBackend", () => {
  it("reads a missing document as null", async () => {
    const backend = hubMemoryBackend(fake(404));
    expect(await backend.read({ key: "k", signal })).toBeNull();
  });

  it("turns a 409 into a conflict", async () => {
    const backend = hubMemoryBackend(fake(409));
    await expect(
      backend.write({ content: "x", expectedVersion: "1", key: "k", signal })
    ).rejects.toBeInstanceOf(MemoryDocumentConflictError);
  });

  it("returns the stored document after a write", async () => {
    const backend = hubMemoryBackend(fake(200, { content: "x", version: 2 }));
    expect(
      await backend.write({
        content: "x",
        expectedVersion: "1",
        key: "k",
        signal,
      })
    ).toEqual({
      content: "x",
      version: "2",
    });
  });
});
