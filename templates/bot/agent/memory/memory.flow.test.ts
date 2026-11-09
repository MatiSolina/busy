import { beforeEach, describe, expect, it, it as test, vi } from "vitest";
import { defined } from "../test-utils";
import directory from "./directory";
import memory from "./memory";
import recall from "./recall";

// The three memories wired together against a fake hub that stores the bot's one document the way
// /api/bot/memory does: GET → 404 or { content, version }, PUT with expectedVersion → 409 if stale.
const hubFetch = vi.hoisted(() =>
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>()
);
vi.mock("../lib/hub", () => ({ hubFetch }));

type Recall = (
  ctx: unknown
) => Promise<{ messages: { id: string; content: string }[] } | null>;
interface Tool {
  execute: (input: unknown, ctx: unknown) => Promise<unknown>;
}
interface Memory {
  provider: {
    recall?: Record<string, Recall>;
    tools?: (ctx: unknown) => Promise<Record<string, Tool>>;
  };
}
const [mem, rec, dir] = [memory, recall, directory] as unknown as Memory[];

const signal = () => new AbortController().signal;
const memoryCtx = () => ({
  abortSignal: signal(),
  memory: { scope: { key: "bot" }, slot: "memory" },
  session: { auth: { current: { principalId: "busy-hub:hub" } }, id: "normal" },
});
const tools = async () => defined(mem.provider.tools)(memoryCtx());
const save = async (text: string) =>
  (await tools()).save_memory.execute({ text }, { abortSignal: signal() });
const remove = async (index: number) =>
  (await tools()).remove_memory.execute({ index }, { abortSignal: signal() });
const chatRecall = async () =>
  (
    await defined(defined(mem.provider.recall)["turn.started"])(memoryCtx())
  )?.messages
    .map((m) => m.content)
    .join("\n") ?? "";
const consultRecall = async () =>
  defined(await defined(defined(rec.provider.recall)["turn.started"])({}))
    .messages.map((m) => m.content)
    .join("\n");

let doc: { content: string; version: number } | null;
let puts: { content: string; expectedVersion: number | null }[];
/** Lets a test slip another writer's save in right before the next PUT lands. */
let beforePut: (() => Promise<unknown>) | undefined;

beforeEach(() => {
  doc = null;
  puts = [];
  beforePut = undefined;
  hubFetch.mockReset().mockImplementation(async (path, init) => {
    if (path !== "/api/bot/memory") {
      return new Response(null, { status: 404 });
    }
    if (!init?.method || init.method === "GET") {
      return doc ? Response.json(doc) : new Response(null, { status: 404 });
    }
    const body = JSON.parse(String(init.body)) as {
      content: string;
      expectedVersion: number | null;
    };
    puts.push(body);
    const sneak = beforePut;
    beforePut = undefined;
    await sneak?.();
    if ((doc?.version ?? null) !== body.expectedVersion) {
      return new Response(null, { status: 409 });
    }
    doc = { content: body.content, version: (doc?.version ?? 0) + 1 };
    return Response.json(doc);
  });
});

describe("memory → hub → recall", () => {
  it("saves a fact from the user's chat in the hub", async () => {
    await save("The user prefers reports in Excel");
    expect(puts).toHaveLength(1);
    expect(defined(puts[0]).expectedVersion).toBeNull();
    expect(defined(doc).content).toContain("The user prefers reports in Excel");
  });

  it("recalls it in the chat's next turn", async () => {
    await save("Signs as DNC");
    expect(await chatRecall()).toContain("Signs as DNC");
  });

  it("shows a consultation every fact the chat saved, in order, in one memory block", async () => {
    await save("Signs as DNC");
    await save("Amounts are in pesos");
    const seen = await consultRecall();
    expect(seen.startsWith("<memory>\n")).toBe(true);
    expect(seen.endsWith("\n</memory>")).toBe(true);
    expect(seen.match(/<\/memory>/gu)).toHaveLength(1);
    expect(seen.indexOf("Signs as DNC")).toBeLessThan(
      seen.indexOf("Amounts are in pesos")
    );
  });

  it("drops a removed fact for consultations too", async () => {
    await save("Uses the old logo");
    await save("Amounts are in pesos");
    await remove(0);
    const seen = await consultRecall();
    expect(seen).not.toContain("Uses the old logo");
    expect(seen).toContain("Amounts are in pesos");
  });

  // Fixed bug: recall.ts only skips a document whose content is "". After memory removes the last fact
  // the hub keeps eve's file header ("<!-- eve-memory-file-v1 lastAllocatedIndex=0 -->\n"), so every
  // consultation gets an empty <memory> block holding that header; expected no message, as with no
  // document at all.
  it("recalls nothing for a consultation once every fact was removed", async () => {
    await save("Uses the old logo");
    await remove(0);
    expect(
      defined(await defined(defined(rec.provider.recall)["turn.started"])({}))
        .messages
    ).toEqual([]);
  });

  it("sends each save with the version it read, so a stale write can't clobber", async () => {
    await save("one");
    await save("two");
    expect(puts.map((p) => p.expectedVersion)).toEqual([null, 1]);
  });

  it("keeps both facts when another writer saved in between (409, then retry)", async () => {
    await save("one");
    // Another save lands between this save's read and its write.
    beforePut = () => save("written by someone else");
    await save("two");
    expect(puts.length).toBeGreaterThan(2);
    expect(defined(doc).content).toContain("written by someone else");
    expect(defined(doc).content).toContain("two");
  });
});

describe("recall: a consultation only reads", () => {
  it("reads the hub every turn, so it sees what the chat saved since", async () => {
    expect(
      defined(await defined(defined(rec.provider.recall)["turn.started"])({}))
        .messages
    ).toEqual([]);
    await save("New client: ACME");
    expect(await consultRecall()).toContain("New client: ACME");
    expect(
      hubFetch.mock.calls.filter(([, init]) => !init?.method).length
    ).toBeGreaterThanOrEqual(2);
  });

  it("never writes, however many turns it recalls", async () => {
    doc = { content: "0: a fact", version: 4 };
    for (let i = 0; i < 3; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential recalls model separate turn boundaries.
      await consultRecall();
    }
    expect(puts).toEqual([]);
    expect(
      hubFetch.mock.calls.every(([, init]) => init?.method === undefined)
    ).toBe(true);
  });

  it.each([
    ["recall", rec],
    ["directory", dir],
  ])("%s gives the model no tools", (_, slot) => {
    expect(slot.provider.tools).toBeUndefined();
  });

  it("memory gives the model exactly save and remove", async () => {
    expect(Object.keys(await tools()).sort()).toEqual([
      "remove_memory",
      "save_memory",
    ]);
  });
});

test("keeps full fireside memory writable and isolated using verified context, even with Eve's hashed scope key", async () => {
  const ctx = {
    ...memoryCtx(),
    memory: { scope: { key: "memscope1_an_opaque_hash" }, slot: "memory" },
    session: {
      auth: {
        current: {
          principalId: `busy-hub:hub:fireside:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:${"a".repeat(64)}`,
        },
      },
      id: "isolated-session",
    },
  };
  await save("Source memory");
  const source = defined(doc);
  let privateDoc = { content: source.content, version: 0 };
  hubFetch.mockImplementation((path, init) => {
    expect(path).toBe("/api/bot/firesides/memory");
    expect(new Headers(init?.headers).get("x-busy-fireside-session")).toBe(
      "isolated-session"
    );
    if (init?.method === "PUT") {
      privateDoc = {
        content: JSON.parse(String(init.body)).content,
        version: privateDoc.version + 1,
      };
    }
    return Promise.resolve(Response.json(privateDoc));
  });
  const fireTools = await defined(mem.provider.tools)(ctx);
  await fireTools.save_memory.execute(
    { text: "Fire-only conclusion" },
    { abortSignal: signal() }
  );
  expect(privateDoc.content).toContain("Fire-only conclusion");
  expect(privateDoc.content).toContain("Source memory");
  expect(doc).toEqual(source);
});
