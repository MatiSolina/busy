import type { SessionView } from "eve/events";
import { describe, expect, it, vi } from "vitest";
import { lazyResult } from "../lib/lazy-tools";
import { defined } from "../test-utils";
import findSkills from "./find_skills";
import dynamic from "./install_skill";
import previewSkill from "./preview_skill";

const install = vi.hoisted(() => vi.fn());
const find = vi.hoisted(() => vi.fn());
const preview = vi.hoisted(() => vi.fn());
vi.mock("../lib/skill-catalog", async (original) => ({
  ...(await original<typeof import("../lib/skill-catalog")>()),
  findCatalogSkills: find,
  installCatalogSkill: install,
  previewCatalogSkill: preview,
}));
vi.mock("eve/events", async (original) => ({
  ...(await original<typeof import("eve/events")>()),
  calls: () => [],
}));

const LEGACY_PEER = "owner:team:project:bot-lawyer:environment:production";
const SIGNED_PEER =
  "busy-hub:consultation:11111111-1111-4111-8111-111111111111";

interface Tool {
  execute: (
    input: { id: string; hash: string },
    ctx: { session: { auth: { current: { principalId: string } } } }
  ) => Promise<unknown>;
}
function resolveIn<T>(definition: unknown, principalId: string): T | null {
  const fn = (definition as Record<symbol, (ctx: unknown) => T | null>)[
    Symbol.for("eve.dynamic")
  ];
  return defined(fn)({
    session: { auth: { current: { principalId } } },
    view: {} as SessionView,
  });
}
const resolve = (principalId: string) => resolveIn<Tool>(dynamic, principalId);
const as = (principalId: string) => ({
  abortSignal: new AbortController().signal,
  session: { auth: { current: { principalId } } },
});

describe("skill installation ownership", () => {
  it("is offered in the bot's own chat and hidden in consultations", () => {
    expect(resolve("hub")).not.toBeNull();
    expect(resolve(LEGACY_PEER)).toBeNull();
  });

  it("checks read-only status again before a previously offered call executes", async () => {
    await expect(
      defined(resolve("hub")).execute(
        { hash: "a".repeat(64), id: "owner/repo/skill" },
        as(LEGACY_PEER)
      )
    ).rejects.toThrow("read-only consultation");
    expect(install).not.toHaveBeenCalled();
  });
});

// H-01 (ACCEPTED_RISK, PR #109 / a6ebb7f3): The user's chat keeps installing from the shared catalog.
// What stays enforced is the consultation guard, for both consultation principals, on discovery
// and on execution, including the deferred copy eve__tool reaches.
describe("skill installation in consultations, both principals", () => {
  it.each([LEGACY_PEER, SIGNED_PEER])(
    "is never offered to %s",
    (principalId) => {
      expect(resolve(principalId)).toBeNull();
    }
  );

  it.each([LEGACY_PEER, SIGNED_PEER])(
    "rejects a previously offered or deferred call from %s",
    async (principalId) => {
      install.mockClear();
      const offered = defined(resolve("busy-hub:hub"));
      const deferred = lazyResult(
        "skills",
        {} as SessionView,
        offered as never,
        true
      ) as unknown as Tool & { deferred?: boolean };
      expect(deferred.deferred).toBe(true);
      for (const call of [offered, deferred]) {
        // biome-ignore lint/performance/noAwaitInLoops: the same rejection, checked per path
        await expect(
          call.execute(
            { hash: "a".repeat(64), id: "owner/repo/skill" },
            as(principalId)
          )
        ).rejects.toThrow("read-only consultation");
      }
      expect(install).not.toHaveBeenCalled();
    }
  );
});

// H-07: skill search and preview send the query or id to skills.sh, outside Busy.
describe("skills.sh search and preview in consultations", () => {
  interface Callable {
    execute: (input: Record<string, string>, ctx: unknown) => unknown;
  }
  it.each([
    ["find_skills", findSkills, { query: "contracts" }],
    ["preview_skill", previewSkill, { id: "owner/repo/skill" }],
  ] as const)(
    "%s is hidden from consultations and re-checked on execution",
    async (_, definition, input) => {
      find.mockClear();
      preview.mockClear();
      expect(resolveIn(definition, LEGACY_PEER)).toBeNull();
      expect(resolveIn(definition, SIGNED_PEER)).toBeNull();
      const offered = defined(resolveIn<Callable>(definition, "busy-hub:hub"));
      await expect(
        Promise.resolve().then(() =>
          offered.execute({ ...input }, as(SIGNED_PEER))
        )
      ).rejects.toThrow("read-only consultation");
      expect(find).not.toHaveBeenCalled();
      expect(preview).not.toHaveBeenCalled();
    }
  );
});
