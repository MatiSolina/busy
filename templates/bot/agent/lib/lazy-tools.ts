import { calls, type SessionView } from "eve/events";
import { defineDynamic, defineTool } from "eve/tools";
import config from "../config.json" with { type: "json" };

// docs/lazy-tools.md: heavy, rarely used tool groups stay out of the prompt until a turn needs them.
// `true` defers the heavy groups; "core" also defers everyday tools, leaving ~10 fixed.
export type LazyLevel = false | "on" | "core";
export function lazyLevel(value: unknown): LazyLevel {
  if (value === true) {
    return "on";
  }
  return value === "core" ? "core" : false;
}
export const LAZY_LEVEL = lazyLevel(
  (config as typeof config & { lazyTools?: unknown }).lazyTools
);
export const LAZY_TOOLS = LAZY_LEVEL !== false;

export const ENABLE_TOOL = "enable_tools";

const ON_GROUPS = {
  browser:
    "Control the visible Chrome (open, snapshot, click, fill, type, tabs, waits).",
  code: "Remote coding tasks on a repository (prepare, start, follow, update, cancel).",
  routines: "Create, list, change or delete scheduled routines.",
  skills: "Search the skills.sh catalog, preview and install skills.",
} as const;
const CORE_GROUPS = {
  ...ON_GROUPS,
  files:
    "write_file, and chat_files (the latest files of your chat with the user).",
  history:
    "search_history and read_history (earlier chat), read_fireside (attached firesides).",
  plan: "manage_plan and bind_plan_execution: durable plans and bounded task bindings.",
  web: "web_fetch: fetch a URL as text.",
} as const;
export type LazyGroup = keyof typeof CORE_GROUPS;
export const groupsFor = (
  level: LazyLevel
): Partial<Record<LazyGroup, string>> =>
  level === "core" ? CORE_GROUPS : ON_GROUPS;
export const LAZY_GROUPS = groupsFor(LAZY_LEVEL);

// Only deferred at "core". Workflow tools (propose_skill, request_login, request_form) can't be dynamic,
// so at "core" they are statically `deferred` and called through eve__tool.
const CORE_ONLY: Record<string, LazyGroup> = {
  bind_plan_execution: "plan",
  chat_files: "files",
  dispatch_plan_step: "plan",
  manage_plan: "plan",
  propose_skill: "skills",
  read_fireside: "history",
  read_history: "history",
  request_form: "browser",
  request_login: "browser",
  search_history: "history",
  web_fetch: "web",
  write_file: "files",
};

const CODE = new Set([
  "cancel_code_task",
  "get_code_task",
  "prepare_code_repository",
  "start_code_task",
  "update_code_task",
]);
// propose_skill stays core: the instructions offer it proactively after repeated workflows.
const SKILLS = new Set(["find_skills", "install_skill", "preview_skill"]);

/** Static `deferred` for a workflow tool that "core" moves out of the prompt. */
export const deferredAtCore = (name: string) =>
  LAZY_LEVEL === "core" && name in CORE_ONLY;

export function groupOf(
  name: string,
  level: LazyLevel = LAZY_LEVEL
): LazyGroup | "core" {
  if (level === "core" && name in CORE_ONLY) {
    return CORE_ONLY[name] as LazyGroup;
  }
  if (name.startsWith("browser__")) {
    return "browser";
  }
  if (CODE.has(name)) {
    return "code";
  }
  if (SKILLS.has(name)) {
    return "skills";
  }
  return name === "manage_routines" ? "routines" : "core";
}

/** Groups opened in this session: an enable_tools call, or any group tool already used via eve__tool. */
export function enabledGroups(view: SessionView): Set<LazyGroup> {
  const groups = new Set<LazyGroup>();
  for (const call of calls(view)) {
    if (call.state === "failed") {
      continue;
    }
    if (call.name === ENABLE_TOOL) {
      const requested = (call.input as { groups?: unknown } | undefined)
        ?.groups;
      for (const g of Array.isArray(requested) ? requested : []) {
        if (typeof g === "string" && g in LAZY_GROUPS) {
          groups.add(g as LazyGroup);
        }
      }
      continue;
    }
    const group = groupOf(call.name);
    if (group !== "core" && group in LAZY_GROUPS) {
      groups.add(group);
    }
  }
  return groups;
}

// Keeps the definition's own brands and options; only `deferred` changes.
const deferredCopy = (tool: object) =>
  defineTool({ ...tool, deferred: true } as never);

/**
 * With the flag on, the tool is offered natively once its group is enabled and
 * stays deferred (reachable through eve__search / eve__tool) until then, so no
 * capability is lost. With the flag off the original definition is returned untouched.
 */
export function lazyTool<T extends object>(
  group: LazyGroup,
  tool: T,
  enabled = LAZY_TOOLS && group in LAZY_GROUPS
): T {
  if (!enabled) {
    return tool;
  }
  const deferred = deferredCopy(tool);
  return defineDynamic(
    (ctx) => (enabledGroups(ctx.view).has(group) ? tool : deferred) as never
  ) as T;
}

/** Same gate for a tool that is already dynamic (consultation, routine, code-task guards). */
export function lazyResult<T extends object | null>(
  group: LazyGroup,
  view: SessionView,
  tool: T,
  enabled = LAZY_TOOLS && group in LAZY_GROUPS
): T {
  if (!enabled || tool === null || enabledGroups(view).has(group)) {
    return tool;
  }
  return deferredCopy(tool) as T;
}
