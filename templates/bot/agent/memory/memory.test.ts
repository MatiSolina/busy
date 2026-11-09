import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatDirectory } from "../lib/peers";
import { defined } from "../test-utils";
import directory from "./directory";
import memory from "./memory";
import recallSlot from "./recall";

const hubFetch = vi.hoisted(() =>
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>()
);
vi.mock("../lib/hub", () => ({ hubFetch }));

interface Memory {
  provider: {
    recall?: Record<
      string,
      () => Promise<{ messages: { id: string; content: string }[] }>
    >;
  };
  scope: (ctx: unknown) => string | null;
}
const [mem, rec, dir] = [memory, recallSlot, directory] as unknown as Memory[];

const ctx = (principalId: string | null) => ({
  session: {
    auth: {
      current:
        principalId === null ? null : { principalId, principalType: "app" },
      initiator: null,
    },
    id: "s",
  },
});
const BOT = "owner:mati-solina:project:bot-lawyer:environment:production";
const MEMORY_ID_RE = /^[a-z0-9-]{1,12}$/u;
// The session context is optional here: only the directory's recall reads it.
const recallTurn = (m: Memory, session?: unknown) =>
  (
    defined(defined(m.provider.recall)["turn.started"]) as (
      context?: unknown
    ) => ReturnType<
      NonNullable<NonNullable<Memory["provider"]["recall"]>["turn.started"]>
    >
  )(session);

beforeEach(() => hubFetch.mockReset());

describe("memory scopes", () => {
  it.each<
    [
      string,
      string | null,
      {
        memory: string | null;
        recall: string | null;
        directory: string | null;
      },
    ]
  >([
    [
      "The user's chat",
      "hub",
      { directory: "bot", memory: "bot", recall: null },
    ],
    [
      "an unprotected local session",
      null,
      { directory: "bot", memory: "bot", recall: null },
    ],
    [
      "a consultation from another bot",
      BOT,
      { directory: null, memory: null, recall: "bot" },
    ],
  ])("in %s", (_, principalId, expected) => {
    const c = ctx(principalId);
    expect({
      directory: dir.scope(c),
      memory: mem.scope(c),
      recall: rec.scope(c),
    }).toEqual(expected);
  });

  it("always has exactly one memory active: writable in the chat, read-only in a consultation", () => {
    const id = fc.oneof(
      fc.constant(null),
      fc.constantFrom("hub", "eve:app", "local-dev"),
      fc
        .stringMatching(MEMORY_ID_RE)
        .map((s) => `owner:t:project:bot-${s}:environment:production`),
      fc
        .stringMatching(MEMORY_ID_RE)
        .map((s) => `owner:t:project:${s}:environment:production`)
    );
    fc.assert(
      fc.property(id, (principalId) => {
        const c = ctx(principalId);
        expect([mem.scope(c), rec.scope(c)].filter((s) => s !== null)).toEqual([
          "bot",
        ]);
      }),
      { numRuns: 200, seed: 1 }
    );
  });

  it("never shows the directory where the writable memory is off", () => {
    for (const principalId of ["hub", BOT, null]) {
      const c = ctx(principalId);
      expect(dir.scope(c)).toBe(mem.scope(c));
    }
  });
});

describe("recall: what a consultation remembers", () => {
  it("wraps the document in a memory block", async () => {
    hubFetch.mockResolvedValueOnce(
      Response.json({ content: "0: prefers Excel", version: 3 })
    );
    expect(await recallTurn(rec)).toEqual({
      messages: [
        { content: "<memory>\n0: prefers Excel\n</memory>", id: "memory" },
      ],
    });
    expect(hubFetch).toHaveBeenCalledWith("/api/bot/memory");
  });

  it.each([
    ["no document yet", () => new Response(null, { status: 404 })],
    ["a hub error", () => new Response(null, { status: 500 })],
    ["an empty document", () => Response.json({ content: "", version: 1 })],
  ])("recalls nothing with %s", async (_, res) => {
    hubFetch.mockResolvedValueOnce(res());
    expect(await recallTurn(rec)).toEqual({ messages: [] });
  });
});

describe("directory: the peers recalled every turn", () => {
  it("recalls the formatted directory", async () => {
    const peers = [
      {
        description: "Contracts.",
        name: "Lawyer",
        slug: "a",
        url: "https://a.example.com",
      },
    ];
    hubFetch.mockResolvedValueOnce(Response.json(peers));
    hubFetch.mockResolvedValueOnce(Response.json({ content: "", version: 1 }));
    expect(await recallTurn(dir, { session: { auth: null, id: "s" } })).toEqual(
      {
        messages: [{ content: formatDirectory(peers), id: "directory" }],
      }
    );
    // The main memory's read starts alongside, for the recall eve runs next.
    expect(hubFetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/bot/directory",
      "/api/bot/memory",
    ]);
  });
});
