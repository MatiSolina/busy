import { readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDirectory, PEER_SLOTS, type Peer } from "../lib/peers";
import { defined } from "../test-utils";

// The real subagent modules (peer-1.ts … peer-12.ts), resolved the way eve does per turn, against
// the directory the hub serves. They must line up with the tool names formatDirectory advertises.
const hubFetch = vi.hoisted(() =>
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>()
);
vi.mock("../lib/hub", () => ({ hubFetch }));

const PEER_FILE_RE = /^peer-\d+\.ts$/u;
const PEER_NUMBER_RE = /\d+/u;

const FILES = readdirSync(new URL("./", import.meta.url)).filter((f) =>
  PEER_FILE_RE.test(f)
);
const SLOTS = FILES.map((f) => Number(PEER_NUMBER_RE.exec(f)?.[0])).sort(
  (a, b) => a - b
);
const MODULES = new Map<number, unknown>(
  await Promise.all(
    SLOTS.map(
      async (n) =>
        [
          n,
          ((await import(`./peer-${n}.ts`)) as { default: unknown }).default,
        ] as const
    )
  )
);

const peer = (i: number): Peer => ({
  description: `Does task ${i}.`,
  name: `Bot ${i}`,
  slug: `bot${i}`,
  url: `https://bot${i}.bots.example.com`,
});
const dir = (n: number) => Array.from({ length: n }, (_, i) => peer(i + 1));

const auth = (principalId: string) => ({
  current: { principalId, principalType: "service" },
  initiator: null,
});
const HUB = auth("busy-hub:hub");
const BOT = auth(
  "https://oidc.vercel.com/t:owner:t:project:bot-lawyer:environment:production"
);

/** What eve does with a subagent module each turn: run its resolver for the session. */
function resolve(n: number, sessionAuth = HUB) {
  const slot = MODULES.get(n) as Record<
    symbol,
    (ctx: unknown) => Promise<unknown>
  >;
  const key = Object.getOwnPropertySymbols(slot).find(
    (k) => typeof slot[k] === "function"
  );
  return defined(slot[defined(key)])({
    session: { auth: sessionAuth, id: "s" },
  }) as Promise<{
    url: string;
    description: string;
  } | null>;
}

let now = 1_900_000_000_000;
beforeEach(() => {
  // fetchDirectory caches for 30 s in-process: a fresh hour per test.
  vi.useFakeTimers({ toFake: ["Date"] });
  now += 3_600_000;
  vi.setSystemTime(now);
  hubFetch.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("subagent slots", () => {
  it("has exactly one file per slot the directory can name", () => {
    expect(SLOTS).toEqual(Array.from({ length: PEER_SLOTS }, (_, i) => i + 1));
  });

  it.each(SLOTS)(
    "peer-%i consults the bot the directory lists as peer-%i",
    async (n) => {
      const bots = dir(PEER_SLOTS).map((p, i) => ({
        ...p,
        name: `Bot ${String.fromCharCode(65 + i)}`,
      }));
      hubFetch.mockResolvedValue(Response.json(bots));
      const line = defined(
        formatDirectory(bots)
          .split("\n")
          .find((l) => l.includes(`(tool peer-${n})`))
      );
      const listed = defined(
        bots.find((b) => line.startsWith(`- ${b.name} (`))
      );
      const agent = await resolve(n);
      expect(agent?.url).toBe(listed.url);
      expect(agent?.description.startsWith(`${listed.name}: `)).toBe(true);
    }
  );

  it.each(SLOTS)("peer-%i is empty while fewer bots exist", async (n) => {
    hubFetch.mockResolvedValue(Response.json(dir(n - 1)));
    expect(await resolve(n)).toBeNull();
  });

  it("leaves every slot empty in a consultation, without asking the hub (one hop)", async () => {
    hubFetch.mockResolvedValue(Response.json(dir(PEER_SLOTS)));
    expect(await Promise.all(SLOTS.map((n) => resolve(n, BOT)))).toEqual(
      SLOTS.map(() => null)
    );
    expect(hubFetch).not.toHaveBeenCalled();
  });

  it("fills the slots in directory order as bots are created", async () => {
    hubFetch.mockResolvedValue(Response.json(dir(5)));
    const agents = await Promise.all(SLOTS.map((n) => resolve(n)));
    expect(agents.map((a) => a?.url ?? null)).toEqual(
      SLOTS.map((n) => (n <= 5 ? peer(n).url : null))
    );
    expect(hubFetch).toHaveBeenCalledTimes(1);
  });
});
