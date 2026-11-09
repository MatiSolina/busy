import { MemoryDocumentConflictError } from "eve/memory/file";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defined } from "../test-utils";
import type { HubFetch } from "./hub";
import { hubMemoryBackend } from "./hub-memory";

const { signal } = new AbortController();

interface Call {
  init?: RequestInit;
  path: string;
}
const recording = (respond: (call: Call) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const fetchHub: HubFetch = (path, init) => {
    calls.push({ init, path });
    return Promise.resolve(respond({ init, path }));
  };
  return { backend: hubMemoryBackend(fetchHub), calls };
};
const reply = (status: number, body?: unknown) => () => {
  let payload: string | null = null;
  if (body !== undefined) {
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Response(payload, { status });
};
const sent = (call: Call) =>
  JSON.parse(String(call.init?.body)) as {
    content: string;
    expectedVersion: number | null;
  };

describe("read", () => {
  it.each([0, 1, 42, 2 ** 31, Number.MAX_SAFE_INTEGER])(
    "turns version %i into its string",
    async (version) => {
      const { backend } = recording(reply(200, { content: "x", version }));
      expect(await backend.read({ key: "bot", signal })).toEqual({
        content: "x",
        version: String(version),
      });
    }
  );

  it("keeps a version the hub already sent as a string", async () => {
    const { backend } = recording(reply(200, { content: "x", version: "7" }));
    expect((await backend.read({ key: "bot", signal }))?.version).toBe("7");
  });

  it.each([
    ["an empty document", ""],
    ["several lines", "v1\n0: prefers Excel\n1: signs as DNC"],
    ["accents and emoji", "The user takes café ☕ with no sugar"],
    ["quotes and backslashes", 'said "hi" and C:\\temp'],
    ["a 256 KiB document", "a".repeat(262_144)],
  ])("returns %s unchanged", async (_, content) => {
    const { backend } = recording(reply(200, { content, version: 3 }));
    expect((await backend.read({ key: "bot", signal }))?.content).toBe(content);
  });

  it("returns only content and version, dropping the hub's other fields", async () => {
    const { backend } = recording(
      reply(200, {
        botSlug: "lawyer",
        content: "x",
        updatedAt: "2026-01-01",
        version: 1,
      })
    );
    expect(
      Object.keys(defined(await backend.read({ key: "bot", signal }))).sort()
    ).toEqual(["content", "version"]);
  });

  it("reads a missing document as null", async () => {
    const { backend } = recording(reply(404, "not found"));
    expect(await backend.read({ key: "bot", signal })).toBeNull();
  });

  it.each([304, 401, 409, 429, 500, 503])(
    "fails on HTTP %i",
    async (status) => {
      const { backend } = recording(reply(status));
      await expect(backend.read({ key: "bot", signal })).rejects.toThrow(
        `hub memory read failed: ${status}`
      );
    }
  );

  it("treats a 409 on read as a failure, not a conflict", async () => {
    const { backend } = recording(reply(409));
    const error = await backend
      .read({ key: "bot", signal })
      .catch((e: unknown) => e);
    expect(MemoryDocumentConflictError.is(error)).toBe(false);
  });

  it("GETs /api/bot/memory with the caller's signal", async () => {
    const { calls, backend } = recording(reply(404));
    await backend.read({ key: "bot", signal });
    expect(calls).toEqual([{ init: { signal }, path: "/api/bot/memory" }]);
  });

  it("reads the bot's one document whatever the scope key", async () => {
    const { calls, backend } = recording(reply(404));
    await backend.read({ key: "bot", signal });
    await backend.read({ key: "otra", signal });
    expect(calls.map((c) => c.path)).toEqual([
      "/api/bot/memory",
      "/api/bot/memory",
    ]);
  });

  it("never calls the hub with an aborted signal", async () => {
    const { calls, backend } = recording(
      reply(200, { content: "x", version: 1 })
    );
    await expect(
      backend.read({ key: "bot", signal: AbortSignal.abort() })
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("propagates a network error", async () => {
    const backend = hubMemoryBackend(() =>
      Promise.reject(new TypeError("fetch failed"))
    );
    await expect(backend.read({ key: "bot", signal })).rejects.toThrow(
      "fetch failed"
    );
  });

  it("rejects a 200 whose body isn't JSON", async () => {
    const { backend } = recording(reply(200, "<html>"));
    await expect(backend.read({ key: "bot", signal })).rejects.toThrow(
      SyntaxError
    );
  });
});

describe("write", () => {
  it.each<[string | null, number | null]>([
    [null, null],
    ["0", 0],
    ["1", 1],
    ["42", 42],
    ["9007199254740991", Number.MAX_SAFE_INTEGER],
  ])("sends expected version %j as %j", async (expectedVersion, wire) => {
    const { calls, backend } = recording(
      reply(200, { content: "x", version: 1 })
    );
    await backend.write({ content: "x", expectedVersion, key: "bot", signal });
    expect(sent(defined(calls[0])).expectedVersion).toBe(wire);
  });

  // Versions are opaque to eve, but this backend only hands out integers. Anything else reaches
  // the hub as create-only, which it answers with a conflict when the document exists.
  it.each(["abc", "v2", "undefined"])(
    "sends a version it never handed out (%j) as create-only",
    async (expectedVersion) => {
      const { calls, backend } = recording(reply(409));
      await expect(
        backend.write({ content: "x", expectedVersion, key: "bot", signal })
      ).rejects.toBeInstanceOf(MemoryDocumentConflictError);
      expect(sent(defined(calls[0])).expectedVersion).toBeNull();
    }
  );

  it("PUTs JSON to /api/bot/memory with the caller's signal", async () => {
    const { calls, backend } = recording(
      reply(200, { content: "x", version: 2 })
    );
    await backend.write({
      content: "x",
      expectedVersion: "1",
      key: "bot",
      signal,
    });
    expect(calls).toHaveLength(1);
    expect(defined(calls[0]).path).toBe("/api/bot/memory");
    expect(defined(calls[0]).init?.method).toBe("PUT");
    expect(defined(calls[0]).init?.signal).toBe(signal);
    expect(sent(defined(calls[0]))).toEqual({
      content: "x",
      expectedVersion: 1,
    });
  });

  it("does not send the scope key", async () => {
    const { calls, backend } = recording(
      reply(200, { content: "x", version: 2 })
    );
    await backend.write({
      content: "x",
      expectedVersion: "1",
      key: "secret",
      signal,
    });
    expect(String(defined(calls[0]).init?.body)).not.toContain("secret");
  });

  it.each([
    ["a new document", null, 1],
    ["an update", "1", 2],
    ["a long-lived document", "999", 1000],
  ])(
    "returns the stored version as a string after %s",
    async (_, expectedVersion, version) => {
      const { backend } = recording(reply(200, { content: "new", version }));
      expect(
        await backend.write({
          content: "new",
          expectedVersion,
          key: "bot",
          signal,
        })
      ).toEqual({
        content: "new",
        version: String(version),
      });
    }
  );

  it("returns what the hub stored, not what it sent", async () => {
    const { backend } = recording(
      reply(200, { content: "normalizado", version: 5 })
    );
    expect(
      (
        await backend.write({
          content: "enviado",
          expectedVersion: "4",
          key: "bot",
          signal,
        })
      ).content
    ).toBe("normalizado");
  });

  it("turns a 409 into a conflict for that key", async () => {
    const { backend } = recording(reply(409, "version conflict"));
    const error = await backend
      .write({ content: "x", expectedVersion: "1", key: "bot", signal })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MemoryDocumentConflictError);
    expect(MemoryDocumentConflictError.is(error)).toBe(true);
    expect((error as MemoryDocumentConflictError).key).toBe("bot");
  });

  it("turns a 409 on a create-only write into a conflict too", async () => {
    const { backend } = recording(reply(409));
    await expect(
      backend.write({ content: "x", expectedVersion: null, key: "bot", signal })
    ).rejects.toBeInstanceOf(MemoryDocumentConflictError);
  });

  it.each([400, 401, 404, 413, 503])(
    "fails on HTTP %i without calling it a conflict",
    async (status) => {
      const { backend } = recording(reply(status));
      const error = await backend
        .write({ content: "x", expectedVersion: "1", key: "bot", signal })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        `hub memory write failed: ${status}`
      );
      expect(MemoryDocumentConflictError.is(error)).toBe(false);
    }
  );

  it("never calls the hub with an aborted signal", async () => {
    const { calls, backend } = recording(
      reply(200, { content: "x", version: 1 })
    );
    await expect(
      backend.write({
        content: "x",
        expectedVersion: null,
        key: "bot",
        signal: AbortSignal.abort(),
      })
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("propagates a network error", async () => {
    const backend = hubMemoryBackend(() =>
      Promise.reject(new TypeError("fetch failed"))
    );
    await expect(
      backend.write({ content: "x", expectedVersion: "1", key: "bot", signal })
    ).rejects.toThrow("fetch failed");
  });
});

// The hub's PUT /api/bot/memory, in memory: create-only on null, compare-and-set otherwise.
const fakeHub = () => {
  let row: { content: string; version: number } | undefined;
  const fetchHub: HubFetch = (_path, init) =>
    Promise.resolve().then(() => {
      if (init?.method !== "PUT") {
        return row ? Response.json(row) : new Response(null, { status: 404 });
      }
      const { content, expectedVersion } = JSON.parse(String(init.body)) as {
        content: string;
        expectedVersion: number | null;
      };
      if (
        expectedVersion === null
          ? row !== undefined
          : row?.version !== expectedVersion
      ) {
        return new Response(null, { status: 409 });
      }
      row = { content, version: (row?.version ?? 0) + 1 };
      return Response.json(row);
    });
  return hubMemoryBackend(fetchHub);
};

describe("against the hub's compare-and-set", () => {
  it("creates, reads back and updates a document", async () => {
    const backend = fakeHub();
    expect(await backend.read({ key: "bot", signal })).toBeNull();
    const created = await backend.write({
      content: "a",
      expectedVersion: null,
      key: "bot",
      signal,
    });
    expect(await backend.read({ key: "bot", signal })).toEqual(created);
    const updated = await backend.write({
      content: "b",
      expectedVersion: created.version,
      key: "bot",
      signal,
    });
    expect(updated).toEqual({ content: "b", version: "2" });
  });

  it("lets only one of two writers that read the same version win", async () => {
    const backend = fakeHub();
    const base = await backend.write({
      content: "a",
      expectedVersion: null,
      key: "bot",
      signal,
    });
    await backend.write({
      content: "b",
      expectedVersion: base.version,
      key: "bot",
      signal,
    });
    await expect(
      backend.write({
        content: "c",
        expectedVersion: base.version,
        key: "bot",
        signal,
      })
    ).rejects.toBeInstanceOf(MemoryDocumentConflictError);
    expect((await backend.read({ key: "bot", signal }))?.content).toBe("b");
  });

  it("refuses a second create", async () => {
    const backend = fakeHub();
    await backend.write({
      content: "a",
      expectedVersion: null,
      key: "bot",
      signal,
    });
    await expect(
      backend.write({ content: "b", expectedVersion: null, key: "bot", signal })
    ).rejects.toBeInstanceOf(MemoryDocumentConflictError);
  });

  it("accepts a write iff it names the current version (any history)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            content: fc.string({ maxLength: 20 }),
            stale: fc.boolean(),
          }),
          { maxLength: 15 }
        ),
        async (ops) => {
          const backend = fakeHub();
          let current: string | null = null;
          let contents: string | null = null;
          for (const op of ops) {
            let guess: string | null = current;
            if (op.stale) {
              guess = current === null ? "0" : String(Number(current) - 1);
            }
            const wins = guess === current;
            // biome-ignore lint/performance/noAwaitInLoops: Sequential writes model compare-and-set history.
            const result: unknown = await backend
              .write({
                content: op.content,
                expectedVersion: guess,
                key: "bot",
                signal,
              })
              .catch((e: unknown) => e);
            if (wins) {
              // biome-ignore lint/suspicious/noConditionalExpect: Property-based CAS test has distinct success and conflict branches.
              expect(result).toEqual({
                content: op.content,
                version: String(Number(current ?? 0) + 1),
              });
              current = (result as { version: string }).version;
              contents = op.content;
            } else {
              // biome-ignore lint/suspicious/noConditionalExpect: Property-based CAS test has distinct success and conflict branches.
              expect(MemoryDocumentConflictError.is(result)).toBe(true);
            }
          }
          const doc = await backend.read({ key: "bot", signal });
          expect(doc === null ? null : doc.content).toBe(contents);
        }
      ),
      { numRuns: 150, seed: 1 }
    );
  });
});

describe("properties", () => {
  it("sends any content and integer version unchanged in the body", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 200, unit: "grapheme" }),
        fc.option(fc.nat(), { nil: null }),
        async (content, version) => {
          const { calls, backend } = recording(
            reply(200, { content, version: 1 })
          );
          await backend.write({
            content,
            expectedVersion: version === null ? null : String(version),
            key: "bot",
            signal,
          });
          expect(sent(defined(calls[0]))).toEqual({
            content,
            expectedVersion: version,
          });
        }
      ),
      { numRuns: 200, seed: 1 }
    );
  });

  it("round-trips any version through read then write", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ max: Number.MAX_SAFE_INTEGER, min: 0 }),
        async (version) => {
          const { calls, backend } = recording(({ init }) =>
            init?.method === "PUT"
              ? Response.json({ content: "x", version: version + 1 })
              : Response.json({ content: "x", version })
          );
          const doc = await backend.read({ key: "bot", signal });
          await backend.write({
            content: "y",
            expectedVersion: defined(doc).version,
            key: "bot",
            signal,
          });
          expect(sent(defined(calls[1])).expectedVersion).toBe(version);
        }
      ),
      { numRuns: 200, seed: 1 }
    );
  });
});
