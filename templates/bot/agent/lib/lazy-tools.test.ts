import type { SessionView } from "eve/events";
import { defineTool } from "eve/tools";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import enableToolsDynamic, { enableTools } from "../tools/enable_tools";
import {
  enabledGroups,
  groupOf,
  LAZY_TOOLS,
  lazyLevel,
  lazyResult,
  lazyTool,
} from "./lazy-tools";

const history = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("eve/events", () => ({ calls: () => history.calls }));

const view = (calls: unknown[]): SessionView => {
  history.calls = calls;
  return {} as SessionView;
};
const run = (definition: unknown, ctx: unknown) =>
  (definition as Record<symbol, (c: unknown) => unknown>)[
    Symbol.for("eve.dynamic")
  ]?.(ctx);

const tool = defineTool({
  description: "Open a page.",
  execute: () => "ok",
  inputSchema: z.object({ url: z.string() }),
});

describe("lazy tool groups", () => {
  it("is off unless the bot's config opts in", () => {
    expect(LAZY_TOOLS).toBe(false);
    expect(lazyTool("browser", tool)).toBe(tool);
    expect(lazyResult("code", view([]), tool)).toBe(tool);
    expect(run(enableToolsDynamic, { view: view([]) })).toBeNull();
  });

  it("maps tools to groups and leaves the rest in core", () => {
    expect(groupOf("browser__click")).toBe("browser");
    expect(groupOf("start_code_task")).toBe("code");
    expect(groupOf("prepare_code_repository")).toBe("code");
    expect(groupOf("manage_routines")).toBe("routines");
    expect(groupOf("install_skill")).toBe("skills");
    expect(groupOf("propose_skill")).toBe("core");
    expect(groupOf("send_file")).toBe("core");
    expect(groupOf("peer-1")).toBe("core");
    expect(groupOf("write_file")).toBe("core");
  });

  it('"core" also defers everyday tools behind new groups', () => {
    expect([lazyLevel(true), lazyLevel("core"), lazyLevel("x")]).toEqual([
      "on",
      "core",
      false,
    ]);
    expect(groupOf("write_file", "core")).toBe("files");
    expect(groupOf("chat_files", "core")).toBe("files");
    expect(groupOf("search_history", "core")).toBe("history");
    expect(groupOf("manage_plan", "core")).toBe("plan");
    expect(groupOf("bind_plan_execution", "core")).toBe("plan");
    expect(groupOf("dispatch_plan_step", "core")).toBe("plan");
    expect(groupOf("web_fetch", "core")).toBe("web");
    expect(groupOf("propose_skill", "core")).toBe("skills");
    expect(groupOf("request_login", "core")).toBe("browser");
    for (const fixed of ["send_file", "suggest_replies", "bash", "agent"]) {
      expect(groupOf(fixed, "core")).toBe("core");
    }
    expect(enableTools("core").groups).toEqual([
      "browser",
      "code",
      "routines",
      "skills",
      "files",
      "history",
      "plan",
      "web",
    ]);
    expect(enableTools("on").groups).toHaveLength(4);
  });

  it("enables a group from enable_tools or from any earlier use of its tools", () => {
    const groups = enabledGroups(
      view([
        {
          input: { groups: ["routines", "bogus"] },
          name: "enable_tools",
          state: "completed",
        },
        { name: "browser__open", state: "completed" },
        { name: "start_code_task", state: "failed" },
        {
          input: { groups: ["skills"] },
          name: "enable_tools",
          state: "failed",
        },
        { name: "send_file", state: "completed" },
      ])
    );
    expect([...groups].sort()).toEqual(["browser", "routines"]);
  });

  it("defers a group's tools until the session enables it", () => {
    const lazy = lazyTool("browser", tool, true);
    const before = run(lazy, { view: view([]) }) as { deferred?: boolean };
    expect(before).toMatchObject({
      deferred: true,
      description: tool.description,
    });
    expect(
      run(lazy, {
        view: view([
          {
            input: { groups: ["browser"] },
            name: "enable_tools",
            state: "completed",
          },
        ]),
      })
    ).toBe(tool);
  });

  it("keeps dynamic guards: a hidden tool stays hidden", () => {
    expect(lazyResult("code", view([]), null, true)).toBeNull();
    expect(lazyResult("code", view([]), tool, true)).toMatchObject({
      deferred: true,
    });
    expect(
      lazyResult(
        "code",
        view([{ name: "get_code_task", state: "completed" }]),
        tool,
        true
      )
    ).toBe(tool);
  });
});
