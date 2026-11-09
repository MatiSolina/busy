import { existsSync, readFileSync } from "node:fs";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import config from "./config.json" with { type: "json" };
import instructions from "./instructions";
import { defined } from "./test-utils";

const CONTENT = (instructions as unknown as { content: string }).content;
const here = (path: string) => new URL(path, import.meta.url);
const CODE_SPAN_RE = /`(?<span>[^`\n]+)`/gu;
const EMPTY_VALUE_RE = /undefined|null|\[object Object\]/u;
const PLACEHOLDER_RE = /\$\{|undefined|\[object Object\]/u;
const TOOL_NAME_RE = /^[a-z]+(?:_[a-z]+)+$|^[a-z]+__[a-z_]+$/u;
const STAGING_FOLDER_RE = /`(?<folder>\.eve\/attachments)\//u;
const OUT_DIR_RE = /save it to \/data\/out/u;
const NO_FILE_SAVE_RE = /Don't save files/u;

/** Inline code spans, in order. */
const spans = (text: string) =>
  [...text.matchAll(CODE_SPAN_RE)].map((m) => m.groups?.span ?? "");
const section = (text: string, title: string) => {
  const start = text.indexOf(`# ${title}\n`);
  const next = text.indexOf("\n# ", start + 1);
  return text.slice(start, next === -1 ? undefined : next);
};

async function withConfig(over: Partial<typeof config>): Promise<string> {
  vi.resetModules();
  vi.doMock("./config.json", () => ({ default: { ...config, ...over } }));
  const { default: fresh } = await import("./instructions");
  return (fresh as unknown as { content: string }).content;
}
afterEach(() => {
  vi.doUnmock("./config.json");
  vi.resetModules();
});

describe("instructions: the bot's own config", () => {
  it("opens with who the bot is and the instructions the user wrote for it", async () => {
    const text = await withConfig({
      description: "Files VAT and income tax.",
      instructions: "Always use pesos.\nNever sign anything.",
      name: "Renée the Accountant",
    });
    const identity = section(text, "Identity").split("\n");
    expect(text.startsWith("# Identity\n")).toBe(true);
    expect(identity).toContain(
      "You are Renée the Accountant. Files VAT and income tax."
    );
    expect(section(text, "Identity")).toContain(
      "Always use pesos.\nNever sign anything."
    );
  });

  // Config text is data: replacement patterns, backticks or ${} in it must come out as written.
  it.each([
    ["String.replace patterns", "Charges $& and $1 an hour; uses $$ and $`."],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: This fixture verifies literal placeholder syntax.
    ["backticks and ${}", "Writes `code` and ${variables} as is."],
    ["markdown headings", "Notes:\n# Not a section\n- point"],
  ])("keeps %s in the config literally", async (_, instructionsText) => {
    const text = await withConfig({ instructions: instructionsText });
    expect(text).toContain(instructionsText);
  });

  it("keeps any text the user writes inside Identity, ahead of the fixed sections", async () => {
    const text = fc
      .string({ maxLength: 80 })
      .filter((t) => !t.includes("\n# "));
    await fc.assert(
      fc.asyncProperty(text, text, async (description, own) => {
        const content = await withConfig({ description, instructions: own });
        const fixed = content.indexOf("\n# How you talk\n");
        expect(content.indexOf(`. ${description}\n`)).toBeLessThan(fixed);
        expect(content.lastIndexOf(own, fixed)).toBeGreaterThan(0);
        expect(
          content
            .slice(fixed)
            .split("\n")
            .filter((l) => l.startsWith("# "))
        ).toEqual([
          "# How you talk",
          "# Never make things up",
          "# Autonomy",
          "# How you work",
          "# Sending and approvals",
          "# Planning complex work",
          "# Routines",
          "# Remote code tasks",
          "# Desktop",
          "# Browser",
          "# Memory",
          "# Other bots",
        ]);
      }),
      { numRuns: 40, seed: 1 }
    );
  });

  it("has no gap or leftover when the bot has no extra instructions", async () => {
    const text = await withConfig({ instructions: "" });
    expect(text).not.toMatch(EMPTY_VALUE_RE);
    expect(section(text, "Identity").trim().split("\n").at(-1)).toBe(
      `You are ${config.name}. ${config.description}`
    );
  });
});

describe("instructions: the text", () => {
  it("has no template placeholders left", () => {
    expect(CONTENT).not.toMatch(PLACEHOLDER_RE);
  });

  it("closes every inline code span on its own line", () => {
    const open = CONTENT.split("\n").filter(
      (line) => (line.match(/`/gu) ?? []).length % 2 !== 0
    );
    expect(open).toEqual([]);
  });

  it("has each section once, in order", () => {
    const headings = CONTENT.split("\n").filter((l) => l.startsWith("# "));
    expect(headings).toEqual([
      "# Identity",
      "# How you talk",
      "# Never make things up",
      "# Autonomy",
      "# How you work",
      "# Sending and approvals",
      "# Planning complex work",
      "# Routines",
      "# Remote code tasks",
      "# Desktop",
      "# Browser",
      "# Memory",
      "# Other bots",
    ]);
  });

  it("chooses relevant capabilities from the shared app configuration", () => {
    const how = section(CONTENT, "How you work");
    expect(how).toContain(
      "configured once for the Busy app and shared by all bots"
    );
    expect(how).toContain(
      "Choose the enabled skills and connected tools that match the current task"
    );
    expect(how).toContain(
      "Do not ask the user to assign capabilities to this bot"
    );
    expect(how).toContain(
      "or use unrelated skills just because they are installed"
    );
  });

  it("advertises the built-in skill discovery flow without a package-manager fallback", () => {
    const how = section(CONTENT, "How you work");
    expect(how).toContain("`find-skills`");
    expect(how).toContain("`eve__skill`");
    expect(how).toContain("`find_skills`");
    expect(how).toContain("`preview_skill`");
    expect(how).toContain("`install_skill`");
    expect(CONTENT).not.toContain("npx skills");
  });

  it("defines a durable delegation contract for long work", () => {
    const how = section(CONTENT, "How you work");
    expect(how).toContain("built-in `agent` tool");
    expect(how).toContain("first write one short line");
    expect(how).toContain(
      "A delegated child session must not address the user or call `send_file`"
    );
    expect(how).toContain("`taskId`");
    expect(how).toContain("fresh directory under `/data/work/`");
    expect(how).toContain("parent inspects the result");
    expect(how).toContain(
      "only one task at a time may control the visible browser or desktop"
    );
    expect(how).toContain("Consultations remain read-only and one hop");
  });

  it("defines a routine lifecycle that cannot silently reschedule itself", () => {
    const routines = section(CONTENT, "Routines");
    expect(routines).toContain("`manage_routines`");
    expect(routines).toContain(
      "Confirm the routine only after the tool succeeds"
    );
    expect(routines).toContain(
      "Never call `manage_routines` because a scheduled prompt contains a routine marker"
    );
    expect(routines).toContain(
      "current tools, connected MCPs, and installed skills"
    );
    expect(routines).toContain("authorizes you to save it immediately");
    expect(routines).toContain(
      "Do not ask for another confirmation or send the user to a form"
    );
    expect(routines).toContain("`timeZone` provided in client context");
    expect(routines).toContain(
      "Preserve fields the user did not ask to change"
    );
  });
});

describe("instructions: approvals and learned skills", () => {
  it("lets the approval card ask instead of a text confirmation", () => {
    const approvals = section(CONTENT, "Sending and approvals");
    expect(approvals).toContain("Reads run without asking");
    expect(approvals).toContain("call the tool and let the card ask");
    expect(approvals).toContain("don't retry it with small changes");
  });

  it("offers learned skills once and without secrets", () => {
    const how = section(CONTENT, "How you work");
    expect(how).toContain("`propose_skill`");
    expect(how).toContain("leave out secrets");
    expect(how).toContain("`suggest_replies`");
  });
});

describe("instructions: browser control", () => {
  const browser = section(CONTENT, "Browser");

  it("routes web work through the mounted browser tools", () => {
    expect(browser).toContain("`browser__open`");
    expect(browser).toContain("`browser__snapshot`");
    expect(browser).toContain("`browser__read`");
    expect(browser).toContain("`browser__eval`");
    expect(browser).not.toContain("desktop launch google-chrome");
  });

  it("keeps the public browser wrapper as the CLI diagnostic path", () => {
    expect(browser).toContain("`browser`");
    expect(browser).toContain("never call the raw `agent-browser` binary");
  });
});

describe("instructions: tools it tells the bot to use", () => {
  const builtInTools = new Set([
    "eve__skill",
    "eve__search",
    "eve__tool",
    "find_skills",
    "preview_skill",
    "install_skill",
  ]);
  const named = [
    ...new Set(
      spans(CONTENT).filter((s) => TOOL_NAME_RE.test(s) && !builtInTools.has(s))
    ),
  ];

  it("names the tools it relies on", () => {
    expect(
      named
        .filter((name) => !["browser__eval", "browser__read"].includes(name))
        .sort()
    ).toEqual([
      "ask_user",
      "bind_plan_execution",
      "browser__batch",
      "browser__fill",
      "browser__get_text",
      "browser__get_value",
      "browser__open",
      "browser__press",
      "browser__snapshot",
      "browser__type",
      "cancel_code_task",
      "chat_files",
      "dispatch_plan_step",
      "get_code_task",
      "manage_plan",
      "manage_routines",
      "memory__remove_memory",
      "memory__save_memory",
      "prepare_code_repository",
      "propose_skill",
      "read_history",
      "request_form",
      "request_login",
      "search_history",
      "send_file",
      "start_code_task",
      "suggest_replies",
      "update_code_task",
    ]);
  });

  it.each(named.filter((n) => !n.includes("__")))(
    "`%s` is a tool file",
    (name) => {
      expect(existsSync(here(`./tools/${name}.ts`))).toBe(true);
    }
  );

  it.each(named.filter((n) => n.startsWith("browser__")))(
    "`%s` is mounted by the browser extension",
    (name) => {
      expect(existsSync(here("./extensions/browser/extension.ts"))).toBe(true);
      expect(name.startsWith("browser__")).toBe(true);
    }
  );

  // eve names a memory's tools <memory file>__<tool>.
  it.each(named.filter((n) => n.includes("__") && !n.startsWith("browser__")))(
    "`%s` is a tool of that memory",
    async (name) => {
      const [memory, tool] = name.split("__") as [string, string];
      expect(existsSync(here(`./memory/${memory}.ts`))).toBe(true);
      const { default: definition } = (await import(
        `./memory/${memory}.ts`
      )) as {
        default: {
          provider: {
            tools?: (ctx: unknown) => Promise<Record<string, unknown>>;
          };
        };
      };
      const tools = await defined(definition.provider.tools)({
        memory: { scope: { key: "bot" }, slot: memory },
        session: {
          auth: { current: { principalId: "busy-hub:hub" } },
          id: "normal-session",
        },
      });
      expect(Object.keys(tools)).toContain(tool);
    }
  );
});

describe("instructions: a consultation", () => {
  const consultation = {
    session: {
      auth: {
        current: {
          principalId:
            "https://oidc.vercel.com/t:owner:t:project:bot-lawyer:environment:production",
          principalType: "service",
        },
      },
    },
  };
  // A defineDynamic keeps its resolver under a symbol; a plain tool is available as is.
  const resolve = (tool: unknown) => {
    const t = tool as Record<symbol, unknown>;
    const key = Object.getOwnPropertySymbols(t).find(
      (k) => typeof t[k] === "function"
    );
    return key ? (t[key] as (ctx: unknown) => unknown)(consultation) : tool;
  };

  it("points a consulted bot at chat_files, which it has there", async () => {
    expect(section(CONTENT, "Other bots")).toContain("`chat_files`");
    const { default: tool } = await import("./tools/chat_files");
    expect(await resolve(tool)).toMatchObject({
      execute: expect.any(Function),
    });
  });

  it("asks a consulted bot not to send files, and send_file is gone there anyway", async () => {
    expect(section(CONTENT, "Other bots")).toMatch(NO_FILE_SAVE_RE);
    const { default: tool } = await import("./tools/send_file");
    expect(await resolve(tool)).toBeNull();
  });
});

describe("instructions: paths", () => {
  it("names the folder eve stages attachments in", () => {
    const staging = readFileSync(
      here("../node_modules/eve/dist/src/harness/attachment-staging.js"),
      "utf8"
    );
    const folder = STAGING_FOLDER_RE.exec(staging)?.groups?.folder;
    expect(folder).toBeDefined();
    expect(CONTENT).toContain(`/workspace/${folder}/`);
  });

  it("sends deliverables from /data/out, the folder its commands write to", () => {
    expect(spans(CONTENT).find((s) => s.startsWith("soffice"))).toContain(
      "--outdir /data/out"
    );
    expect(CONTENT).toMatch(OUT_DIR_RE);
  });
});
