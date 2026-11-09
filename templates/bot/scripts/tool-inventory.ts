// Inventory of the tool definitions the model receives on an ordinary user turn, offline.
// Run from templates/bot: `pnpm dlx tsx scripts/tool-inventory.ts [--lazy] [--json]` (Node 24).
// --lazy simulates `"lazyTools": true` before any group is enabled; --core, `"lazyTools": "core"`.
// Bytes = JSON of { name, description, input_schema }, the payload a provider gets per tool.
// ponytail: eve's catalog tools and peer tools are internal/remote, so they are estimated from
// eve's dist text and a typical directory entry; everything else is built from the real modules.
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { emptySessionView } from "eve/events";
import { z } from "zod";
import {
  groupOf,
  groupsFor,
  LAZY_LEVEL,
  type LazyLevel,
} from "../agent/lib/lazy-tools";
import { enableTools } from "../agent/tools/enable_tools";

const DYNAMIC = Symbol.for("eve.dynamic");
const DISABLED = Symbol.for("eve.disabled-tool");
const root = new URL("..", import.meta.url).pathname;

export interface ToolInventoryRow {
  bytes: number;
  group: string;
  name: string;
}

export interface ToolInventory {
  groups: Record<string, { bytes: number; count: number }>;
  promptBytes: number;
  rows: ToolInventoryRow[];
  total: number;
}

export interface ToolInventoryOptions {
  peerCount?: number;
}

interface ToolLike {
  deferred?: boolean;
  description?: string;
  inputSchema?: unknown;
}

function jsonSchema(schema: unknown): unknown {
  if (schema && typeof schema === "object" && "_zod" in schema) {
    return z.toJSONSchema(schema as z.ZodType, {
      io: "input",
      unrepresentable: "any",
    });
  }
  const std = (
    schema as {
      "~standard"?: { jsonSchema?: { input: (o: object) => unknown } };
    } | null
  )?.["~standard"];
  if (std?.jsonSchema) {
    return std.jsonSchema.input({ target: "draft-2020-12" });
  }
  if (std) {
    return (
      (schema as { jsonSchema?: unknown }).jsonSchema ?? { type: "object" }
    );
  }
  return schema ?? { type: "object" };
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export async function collectToolInventory(
  level: LazyLevel = LAZY_LEVEL,
  { peerCount = Number(process.env.PEERS ?? 8) }: ToolInventoryOptions = {}
): Promise<ToolInventory> {
  const lazy = level !== false;
  const lazyGroups = groupsFor(level);
  const rows: ToolInventoryRow[] = [];
  function add(name: string, tool: ToolLike, group = groupOf(name, level)) {
    if (!tool || typeof tool !== "object") {
      throw new Error(`Tool ${name} is not an object definition.`);
    }
    if (typeof tool.description !== "string") {
      throw new Error(`Tool ${name} has no description.`);
    }
    const payload = {
      description: tool.description,
      input_schema: jsonSchema(tool.inputSchema),
      name,
    };
    rows.push({
      bytes: Buffer.byteLength(JSON.stringify(payload)),
      group:
        tool.deferred || (lazy && group in lazyGroups)
          ? `${group} (deferred)`
          : group,
      name,
    });
  }

  // A plain user in the user's chat: not a consultation, routine, fireside, or code-task delivery.
  const ctx = {
    channel: { kind: "eve", metadata: {} },
    session: {
      auth: { current: { principalId: "mati", principalType: "user" } },
      id: "inventory",
    },
    turn: { id: "t1" },
    view: emptySessionView(),
  };

  async function resolve(mod: unknown): Promise<unknown> {
    if (mod && typeof mod === "object" && DYNAMIC in mod) {
      const fn = (mod as Record<symbol, (c: unknown) => unknown>)[DYNAMIC];
      if (typeof fn !== "function") {
        throw new Error("Dynamic tool definition has no resolver.");
      }
      return await fn(ctx);
    }
    return mod;
  }

  async function addModule(name: string, path: string) {
    const definition = (await import(path)).default;
    const value = await resolve(definition);
    if (!value || typeof value !== "object") {
      if (
        definition &&
        typeof definition === "object" &&
        DYNAMIC in definition
      ) {
        return;
      }
      throw new Error(`Tool module ${path} did not export a definition.`);
    }
    if (DISABLED in value) {
      return;
    }
    if ("description" in value) {
      add(name, value as ToolLike);
      return;
    }
    const entries = Object.entries(value);
    if (entries.length === 0) {
      throw new Error(`Tool module ${path} exported an empty tool map.`);
    }
    for (const [key, tool] of entries) {
      add(key, tool as ToolLike);
    }
  }

  const isSource = (f: string) => f.endsWith(".ts") && !f.includes(".test.");

  // 1. Bot's own tools.
  const own = join(root, "agent/tools");
  await Promise.all(
    readdirSync(own)
      .filter(isSource)
      .map((file) => addModule(basename(file, ".ts"), join(own, file)))
  );

  // 2. Browser extension: a slot override in agent/extensions/browser/tools wins
  // (disableTool() resolves to no definition and is skipped).
  const ext = join(
    root,
    "node_modules/@agent-browser/eve/dist/extension/tools"
  );
  const overrides = join(root, "agent/extensions/browser/tools");
  const overridden = new Set(
    readdirSync(overrides)
      .filter(isSource)
      .map((f) => basename(f, ".ts"))
  );
  const extensionFiles = readdirSync(ext).filter((f) => f.endsWith(".mjs"));
  const extensionSlugs = new Set(
    extensionFiles.map((file) => basename(file, ".mjs"))
  );
  await Promise.all([
    ...extensionFiles.map((file) => {
      const slug = basename(file, ".mjs");
      return addModule(
        `browser__${slug}`,
        overridden.has(slug) ? join(overrides, `${slug}.ts`) : join(ext, file)
      );
    }),
    ...[...overridden]
      .filter((slug) => !extensionSlugs.has(slug))
      .map((slug) =>
        addModule(`browser__${slug}`, join(overrides, `${slug}.ts`))
      ),
  ]);

  // 3. eve defaults this agent keeps (see `eve info`); an agent/tools/<name>.ts override was added in 1.
  const ownNames = new Set(readdirSync(own).map((f) => basename(f, ".ts")));
  const builtins = (
    [
      ["bash", "eve/tools/bash", "bash"],
      ["read_file", "eve/tools/read_file", "readFile"],
      ["write_file", "eve/tools/write_file", "writeFile"],
      ["web_fetch", "eve/tools/web_fetch", "webFetch"],
      ["agent", "eve/tools/agent", "agent"],
    ] as [string, string, string][]
  ).filter(([name]) => !ownNames.has(name));
  const mods = await Promise.all(builtins.map(([, spec]) => import(spec)));
  for (const [[name, , exportName], mod] of builtins.map(
    (b, i) => [b, mods[i]] as const
  )) {
    const tool = mod[exportName] ?? mod.default;
    if (!tool || typeof tool !== "object") {
      throw new Error(`Built-in eve tool ${name} has no definition.`);
    }
    add(name, tool as ToolLike, "eve");
  }
  // Memory provider tools (agent/memory/memory.ts uses fileMemory), named memory__<tool>.
  const { fileMemory } = await import("eve/memory/file");
  const memory = fileMemory({
    backend: {
      read: () => Promise.resolve(null),
      write: () => Promise.resolve(),
    },
  });
  if (typeof memory.tools !== "function") {
    throw new Error("The eve memory provider has no tool factory.");
  }
  const memoryTools = await memory.tools({
    ...ctx,
    memory: { scope: { key: "bot" }, slot: "memory" },
  } as never);
  if (!memoryTools || typeof memoryTools !== "object") {
    throw new Error("The eve memory provider returned no tools.");
  }
  const memoryEntries = Object.entries(memoryTools);
  if (memoryEntries.length === 0) {
    throw new Error("The eve memory provider returned an empty tool map.");
  }
  for (const [key, tool] of memoryEntries) {
    add(`memory__${key}`, tool as ToolLike, "memory");
  }
  if (lazy) {
    add("enable_tools", enableTools(level).tool, "core");
  }
  // web_search is a provider tool: the provider gets only its name and options.
  add("web_search", { description: "", inputSchema: {} }, "eve");

  // 4. Estimates (see header): eve__search/eve__tool/eve__skill and peer remote agents.
  const catalogSchema = {
    properties: {
      input: {
        description: "Arguments matching the tool's signature.",
        type: "object",
      },
      name: {
        description: "The tool's exact name, as eve__search returns it.",
        type: "string",
      },
    },
    required: ["name"],
    type: "object",
  };
  for (const name of ["eve__search", "eve__tool", "eve__skill"]) {
    add(
      name,
      {
        description:
          "Call a tool that isn't in your tool list by its exact name from eve__search. Prefer connected services over web search or general knowledge when a request relates to them.",
        inputSchema: catalogSchema,
      },
      "eve catalog (est.)"
    );
  }
  for (let i = 1; i <= peerCount; i += 1) {
    add(
      `peer-${i}`,
      {
        description:
          "Ventas: Answers questions about the pipeline, accounts and pricing. Ask it a question; it replies with text only.",
        inputSchema: {
          additionalProperties: false,
          properties: {
            message: { type: "string" },
            taskId: { type: "string" },
          },
          required: ["message"],
          type: "object",
        },
      },
      "peers (est.)"
    );
  }

  // Sort ties explicitly: readdir order is not a portable ordering contract.
  rows.sort(
    (a, b) =>
      b.bytes - a.bytes ||
      compareStrings(a.name, b.name) ||
      compareStrings(a.group, b.group)
  );
  const groups = new Map<string, { bytes: number; count: number }>();
  for (const row of rows) {
    const g = groups.get(row.group) ?? { bytes: 0, count: 0 };
    g.bytes += row.bytes;
    g.count += 1;
    groups.set(row.group, g);
  }
  const total = rows.reduce((sum, r) => sum + r.bytes, 0);
  const inPrompt = rows.filter((r) => !r.group.endsWith("(deferred)"));
  const promptBytes = inPrompt.reduce((sum, r) => sum + r.bytes, 0);

  return {
    groups: Object.fromEntries(groups),
    promptBytes,
    rows,
    total,
  };
}

export function levelFromArgs(args: string[]): LazyLevel {
  if (args.includes("--core")) {
    return "core";
  }
  if (args.includes("--lazy")) {
    return "on";
  }
  return LAZY_LEVEL;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const level = levelFromArgs(process.argv);
  const report = await collectToolInventory(level);
  const tokens = (bytes: number) => Math.round(bytes / 4);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ...report, level }));
  } else {
    const inPrompt = report.rows.filter((r) => !r.group.endsWith("(deferred)"));
    console.log(
      `In prompt: ${inPrompt.length} tools, ${report.promptBytes} B, ~${tokens(report.promptBytes)} tok (lazyTools=${level}; +${report.rows.length - inPrompt.length} deferred)\n`
    );
    console.log("By group:");
    for (const [name, g] of Object.entries(report.groups).sort(
      (a, b) => b[1].bytes - a[1].bytes || compareStrings(a[0], b[0])
    )) {
      console.log(
        `  ${name.padEnd(26)} ${String(g.count).padStart(3)}  ${String(g.bytes).padStart(6)} B  ~${tokens(g.bytes)} tok`
      );
    }
    console.log("\nBy tool:");
    for (const r of report.rows) {
      console.log(
        `  ${r.name.padEnd(28)} ${r.group.padEnd(22)} ${String(r.bytes).padStart(6)} B`
      );
    }
  }
}
