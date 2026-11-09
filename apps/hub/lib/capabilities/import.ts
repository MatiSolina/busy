import type {
  CapabilityInput,
  CapabilitySkill,
} from "@/lib/capabilities/types";
import {
  MAX_SUPPORT_FILE_BYTES,
  parseCapabilityInput,
} from "@/lib/capabilities/validation";

/** Limits shared by the browser importer and the capabilities API. */
export const CAPABILITY_IMPORT_LIMITS = {
  maxBytes: 512 * 1024,
  maxCapabilityNameLength: 64,
  maxFiles: 128,
  maxSkillBytes: 384 * 1024,
  maxSkillNameLength: 64,
  maxSkills: 16,
} as const;

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const RESERVED_PREFIX = /^eve(?:__|$)/iu;
const UNSUPPORTED_PLUGIN_KEYS = [
  "hooks",
  "mcp",
  "mcpServers",
  "commands",
  "agents",
  "tools",
  "lspServers",
  "outputStyles",
  "apps",
  "dependencies",
  "userConfig",
  "channels",
  "experimental",
] as const;
const SAFE_FILE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/u;
const PLUGIN_ROOT_REFERENCE = /\$\{(?:CLAUDE|CODEX)_PLUGIN_ROOT\}/u;
const BOM = /^\uFEFF/u;
const WINDOWS_NEWLINE = /\r\n?/gu;
const LEADING_NEWLINE = /^\n/u;
// biome-ignore lint/style/useNamedCaptureGroup: Frontmatter parsing targets an ES2017 build and uses numeric captures.
const FRONTMATTER_KEY = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u;
const FRONTMATTER_BLOCK = /^[|>][-+]?$/u;
const INDENTED_LINE = /^\s+/u;
const TWO_SPACE_INDENT = /^\s{2}/u;
const WHITESPACE = /\s/u;
const QUOTES = /^['"]|['"]$/gu;
const LEADING_DOT_SLASH = /^\.\//u;
const TRAILING_SLASHES = /\/+$/u;

export type ImportKind = "skill" | "plugin";

export class CapabilityImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityImportError";
  }
}

type BrowserFile = File & { webkitRelativePath?: string };

/** Parse one SKILL.md or a folder selected through an input with webkitdirectory. */
export async function parseCapabilityFiles(
  files: Iterable<BrowserFile>,
  kind: ImportKind
): Promise<CapabilityInput> {
  const list = [...files];
  if (!list.length) {
    throw new CapabilityImportError(
      "Choose a SKILL.md file or a plugin folder."
    );
  }
  if (
    list.length > CAPABILITY_IMPORT_LIMITS.maxFiles ||
    list.reduce((sum, file) => sum + file.size, 0) >
      CAPABILITY_IMPORT_LIMITS.maxBytes
  ) {
    throw new CapabilityImportError(
      "Keep the import to 128 text files and under 512 KiB."
    );
  }
  const entries = await readFiles(list);
  if (entries.length > CAPABILITY_IMPORT_LIMITS.maxFiles) {
    throw new CapabilityImportError(
      `Too many files. Keep the import to ${CAPABILITY_IMPORT_LIMITS.maxFiles} files.`
    );
  }
  const totalBytes = entries.reduce((sum, item) => sum + item.bytes, 0);
  if (totalBytes > CAPABILITY_IMPORT_LIMITS.maxBytes) {
    throw new CapabilityImportError(
      "This import is too large. Keep it under 512 KiB."
    );
  }

  if (kind === "skill") {
    return parseSkillImport(entries);
  }
  return parsePluginImport(entries);
}

/** Parse a JSON capability payload for plugin imports. */
export function parseCapabilityJson(source: string): CapabilityInput {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    // biome-ignore lint/style/useErrorCause: Import errors intentionally expose a stable message, not parser internals.
    throw new CapabilityImportError("The plugin JSON is not valid JSON.");
  }
  if (!isRecord(value) || value.kind !== "plugin") {
    throw new CapabilityImportError("A plugin JSON must include kind: plugin.");
  }
  return validateInput(value);
}

export function validateCapabilityInput(
  value: unknown,
  expectedKind?: ImportKind
): CapabilityInput {
  return validateInput(value, expectedKind);
}

interface Entry {
  bytes: number;
  path: string;
  text: string;
}

function readFiles(files: BrowserFile[]): Promise<Entry[]> {
  return Promise.all(
    files.map(async (file) => {
      const path = file.webkitRelativePath?.trim() || file.name;
      assertSafePath(path);
      const buffer = await file.arrayBuffer();
      if (buffer.byteLength > CAPABILITY_IMPORT_LIMITS.maxBytes) {
        throw new CapabilityImportError("A file is too large for this import.");
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        // biome-ignore lint/style/useErrorCause: Import errors intentionally expose a stable message, not decoder internals.
        throw new CapabilityImportError(`“${path}” is not a UTF-8 text file.`);
      }
      if (text.includes("\0")) {
        throw new CapabilityImportError(`“${path}” looks like a binary file.`);
      }
      return { bytes: buffer.byteLength, path, text };
    })
  );
}

function parseSkillImport(entries: Entry[]): CapabilityInput {
  const skillFiles = entries.filter(
    (entry) => basename(entry.path).toUpperCase() === "SKILL.MD"
  );
  if (skillFiles.length !== 1) {
    throw new CapabilityImportError(
      "Choose exactly one SKILL.md for a skill import."
    );
  }
  const [skillEntry] = skillFiles;
  if (!skillEntry) {
    throw new CapabilityImportError(
      "Choose exactly one SKILL.md for a skill import."
    );
  }
  const fallbackName =
    basename(dirname(skillEntry.path)) || basename(skillEntry.path, ".md");
  const parsed = parseSkillMarkdown(skillEntry.text, fallbackName);
  const files = Object.fromEntries(
    entries
      .filter((entry) => entry.path !== skillEntry.path)
      .map((entry) => [
        relativeSupportPath(skillEntry.path, entry.path),
        entry.text,
      ])
  );
  const skillBytes =
    skillEntry.bytes +
    Object.entries(files).reduce(
      (sum, [path, text]) => sum + byteLength(path) + byteLength(text),
      0
    );
  if (skillBytes > CAPABILITY_IMPORT_LIMITS.maxSkillBytes) {
    throw new CapabilityImportError(
      "This skill is too large. Keep it under 384 KiB."
    );
  }
  return validateInput({
    description: parsed.description,
    kind: "skill",
    name: parsed.name,
    skills: [{ ...parsed, files }],
  });
}

function parsePluginImport(entries: Entry[]): CapabilityInput {
  const manifest = entries.find(
    (entry) =>
      basename(entry.path) === "plugin.json" &&
      (entry.path.includes(".claude-plugin/") ||
        entry.path.includes(".codex-plugin/") ||
        entry.path.endsWith("/plugin.json") ||
        dirname(entry.path) === "")
  );
  if (!manifest) {
    const json = entries.find((entry) =>
      basename(entry.path).toLowerCase().endsWith(".json")
    );
    if (json) {
      return parseCapabilityJson(json.text);
    }
    throw new CapabilityImportError(
      "A Claude plugin must include .claude-plugin/plugin.json, or a plugin JSON payload."
    );
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(manifest.text);
  } catch {
    // biome-ignore lint/style/useErrorCause: Import errors intentionally expose a stable message, not parser internals.
    throw new CapabilityImportError(
      ".claude-plugin/plugin.json is not valid JSON."
    );
  }
  if (!isRecord(metadata)) {
    throw new CapabilityImportError(
      "The plugin manifest must be a JSON object."
    );
  }
  const unsupported = findUnsupportedMetadata(metadata);
  if (unsupported.length) {
    throw new CapabilityImportError(
      `This plugin includes unsupported components: ${unsupported.join(", ")}. Import skills only.`
    );
  }
  let marker = "";
  if (manifest.path.includes(".claude-plugin/")) {
    marker = ".claude-plugin/";
  } else if (manifest.path.includes(".codex-plugin/")) {
    marker = ".codex-plugin/";
  }
  const manifestDirectory = dirname(manifest.path);
  let root = "";
  if (marker) {
    root = manifest.path.slice(0, manifest.path.indexOf(marker));
  } else if (manifestDirectory) {
    root = `${manifestDirectory}/`;
  }
  rejectUnsupportedPluginFiles(entries, root);
  let configuredSkills: unknown[] | null = null;
  if (Array.isArray(metadata.skills)) {
    configuredSkills = metadata.skills;
  } else if (typeof metadata.skills === "string") {
    configuredSkills = [metadata.skills];
  }
  const skillRoots = configuredSkills?.length
    ? configuredSkills.map((item) => resolvePluginPath(root, String(item)))
    : [`${root}skills/`];
  const skillEntries = entries.filter(
    (entry) =>
      skillRoots.some((path) => {
        const rootPath = path.endsWith("/") ? path : `${path}/`;
        return entry.path.startsWith(rootPath);
      }) && basename(entry.path).toUpperCase() === "SKILL.MD"
  );
  if (!skillEntries.length) {
    throw new CapabilityImportError(
      "The plugin has no skills/*/SKILL.md files to import."
    );
  }
  if (skillEntries.length > CAPABILITY_IMPORT_LIMITS.maxSkills) {
    throw new CapabilityImportError(
      `Too many skills. Keep the import to ${CAPABILITY_IMPORT_LIMITS.maxSkills}.`
    );
  }
  const skills = skillEntries.map((entry) => {
    const fallback = basename(dirname(entry.path));
    const parsed = parseSkillMarkdown(entry.text, fallback);
    const prefix = dirname(entry.path);
    const files = Object.fromEntries(
      entries
        .filter(
          (item) =>
            item.path.startsWith(`${prefix}/`) && item.path !== entry.path
        )
        .map((item) => [item.path.slice(prefix.length + 1), item.text])
    );
    return { ...parsed, files };
  });
  const name =
    stringValue(metadata.name) ||
    basename(root.replace(TRAILING_SLASHES, "")) ||
    "plugin";
  const description =
    stringValue(metadata.description) || `Imported skills from ${name}.`;
  return validateInput({
    description,
    kind: "plugin",
    name,
    skills,
    version: stringValue(metadata.version),
  });
}

export function parseSkillMarkdown(
  source: string,
  fallbackName: string
): Omit<CapabilitySkill, "files"> {
  if (PLUGIN_ROOT_REFERENCE.test(source)) {
    throw new CapabilityImportError(
      "This skill references plugin-root files. Import the referenced files into the skill folder first."
    );
  }
  const normalized = source.replace(BOM, "").replace(WINDOWS_NEWLINE, "\n");
  let body = normalized;
  let fields: Record<string, string> = {};
  if (normalized.startsWith("---\n")) {
    const end = normalized.indexOf("\n---", 4);
    if (end < 0) {
      throw new CapabilityImportError(
        "SKILL.md has an unfinished frontmatter block."
      );
    }
    fields = parseFrontmatter(normalized.slice(4, end));
    body = normalized.slice(end + 4).replace(LEADING_NEWLINE, "");
  }
  const unsupported = [
    "allowed-tools",
    "hooks",
    "model",
    "agent",
    "context",
  ].filter((key) => Object.hasOwn(fields, key));
  if (
    Object.hasOwn(fields, "disable-model-invocation") &&
    parseFrontmatterBoolean(fields["disable-model-invocation"]) !== false
  ) {
    unsupported.push("disable-model-invocation");
  }
  if (unsupported.length) {
    throw new CapabilityImportError(
      `This skill requires unsupported settings: ${unsupported.join(", ")}.`
    );
  }
  const name = (fields.name || fallbackName || "skill").trim();
  const description = (
    fields.description ||
    firstMeaningfulLine(body) ||
    `Instructions for the ${name} skill.`
  ).trim();
  if (!body.trim()) {
    throw new CapabilityImportError(`“${name}” has no instructions.`);
  }
  return { content: body.trim(), description, name };
}

function parseFrontmatterBoolean(value: string): boolean | undefined {
  let quote: '"' | "'" | null = null;
  let end = value.length;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (
      character === "#" &&
      (index === 0 || WHITESPACE.test(value[index - 1] ?? ""))
    ) {
      end = index;
      break;
    }
  }
  const normalized = value.slice(0, end).trim().replace(QUOTES, "");
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return undefined;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Frontmatter parsing handles multiline YAML-like values and import limits at one boundary.
function parseFrontmatter(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) {
      break;
    }
    const match = line.match(FRONTMATTER_KEY);
    if (!match) {
      continue;
    }
    const [, key] = match;
    if (!key) {
      continue;
    }
    let value = (match[2] ?? "").trim();
    if (FRONTMATTER_BLOCK.test(value)) {
      const block: string[] = [];
      while (
        i + 1 < lines.length &&
        (INDENTED_LINE.test(lines[i + 1] ?? "") ||
          (lines[i + 1] ?? "").trim() === "")
      ) {
        i += 1;
        block.push((lines[i] ?? "").replace(TWO_SPACE_INDENT, ""));
      }
      value = value.startsWith(">")
        ? block.join(" ").trim()
        : block.join("\n").trim();
    }
    result[key] = value.replace(QUOTES, "");
  }
  return result;
}

function validateInput(
  value: unknown,
  expectedKind?: ImportKind
): CapabilityInput {
  if (!isRecord(value)) {
    throw new CapabilityImportError(
      "The capability payload must be an object."
    );
  }
  const { kind } = value;
  if (kind !== "skill" && kind !== "plugin") {
    throw new CapabilityImportError("Capability kind must be skill or plugin.");
  }
  if (expectedKind && expectedKind !== kind) {
    throw new CapabilityImportError(
      `This file describes a ${kind}, not a ${expectedKind}.`
    );
  }
  const name = stringValue(value.name);
  const description = stringValue(value.description);
  if (
    !name ||
    name.length > CAPABILITY_IMPORT_LIMITS.maxCapabilityNameLength ||
    !SAFE_NAME.test(name) ||
    RESERVED_PREFIX.test(name)
  ) {
    throw new CapabilityImportError(
      "Use a capability name with letters, numbers, dashes or underscores (up to 64 characters)."
    );
  }
  if (!description || byteLength(description) > 2000) {
    throw new CapabilityImportError(
      "Add a short capability description (up to 2,000 bytes)."
    );
  }
  if (
    !Array.isArray(value.skills) ||
    value.skills.length < 1 ||
    value.skills.length > CAPABILITY_IMPORT_LIMITS.maxSkills
  ) {
    throw new CapabilityImportError(
      `Add between 1 and ${CAPABILITY_IMPORT_LIMITS.maxSkills} skills.`
    );
  }
  const seen = new Set<string>();
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Capability validation intentionally keeps all untrusted input limits in one boundary.
  const skills = value.skills.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new CapabilityImportError(`Skill ${index + 1} is invalid.`);
    }
    const skillName = stringValue(raw.name);
    const skillDescription = stringValue(raw.description);
    const content = stringValue(raw.content);
    if (
      !skillName ||
      skillName.length > CAPABILITY_IMPORT_LIMITS.maxSkillNameLength ||
      !SAFE_NAME.test(skillName) ||
      RESERVED_PREFIX.test(skillName)
    ) {
      throw new CapabilityImportError(
        `Skill ${index + 1} needs a safe name of up to 64 characters.`
      );
    }
    if (seen.has(skillName.toLowerCase())) {
      throw new CapabilityImportError(`Duplicate skill name: ${skillName}.`);
    }
    seen.add(skillName.toLowerCase());
    if (
      !skillDescription ||
      skillDescription.length > 2000 ||
      !content.trim()
    ) {
      throw new CapabilityImportError(
        `Skill “${skillName}” needs a description and instructions.`
      );
    }
    if (byteLength(content) > 200_000) {
      throw new CapabilityImportError(`Skill “${skillName}” is too large.`);
    }
    const files: Record<string, string> = {};
    if (raw.files !== undefined) {
      if (!isRecord(raw.files)) {
        throw new CapabilityImportError(
          `Supporting files for “${skillName}” are invalid.`
        );
      }
      const fileEntries = Object.entries(raw.files);
      if (fileEntries.length > CAPABILITY_IMPORT_LIMITS.maxFiles) {
        throw new CapabilityImportError(
          `Too many supporting files for “${skillName}”.`
        );
      }
      for (const [path, file] of fileEntries) {
        assertSafePath(path);
        if (path.toLowerCase() === "skill.md" || typeof file !== "string") {
          throw new CapabilityImportError(
            `Supporting file “${path}” is invalid.`
          );
        }
        if (byteLength(file) > MAX_SUPPORT_FILE_BYTES) {
          throw new CapabilityImportError(
            `Supporting file “${path}” is too large.`
          );
        }
        if (PLUGIN_ROOT_REFERENCE.test(file)) {
          throw new CapabilityImportError(
            `Supporting file “${path}” references plugin-root files, which are not supported.`
          );
        }
        files[path] = file;
      }
    }
    return { content, description: skillDescription, files, name: skillName };
  });
  const version =
    value.version === null || value.version === undefined
      ? undefined
      : stringValue(value.version);
  if (version && version.length > 64) {
    throw new CapabilityImportError("Version is too long.");
  }
  try {
    return parseCapabilityInput({
      description,
      kind,
      name,
      ...(version ? { version } : {}),
      skills,
    });
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: Validation errors intentionally expose only a stable message, not parser internals.
    throw new CapabilityImportError(
      error instanceof Error ? error.message : "Invalid capability."
    );
  }
}

function assertSafePath(path: string) {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    !SAFE_FILE_PATH.test(path) ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part === "__proto__" ||
          part === "constructor" ||
          part === "prototype"
      )
  ) {
    throw new CapabilityImportError(
      `Unsafe supporting file path: ${path || "(empty)"}.`
    );
  }
}

function resolvePluginPath(root: string, raw: string): string {
  const value = raw
    .trim()
    .replace(LEADING_DOT_SLASH, "")
    .replace(TRAILING_SLASHES, "");
  if (
    !value ||
    value.startsWith("/") ||
    value.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new CapabilityImportError(`Plugin skill path is unsafe: ${raw}.`);
  }
  return `${root}${value}`;
}

function isEmptyPluginPlaceholder(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(value).length === 0;
}

function findUnsupportedMetadata(value: unknown, parent = ""): string[] {
  if (!isRecord(value)) {
    return [];
  }
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = parent ? `${parent}.${key}` : key;
    if (
      (UNSUPPORTED_PLUGIN_KEYS as readonly string[]).includes(key) &&
      !isEmptyPluginPlaceholder(child)
    ) {
      found.push(path);
    }
    if (key !== "skills") {
      found.push(...findUnsupportedMetadata(child, path));
    }
  }
  return [...new Set(found)];
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Plugin file inspection intentionally handles all unsupported component forms in one boundary.
function rejectUnsupportedPluginFiles(entries: Entry[], root: string) {
  const unsupported = new Set([
    "hooks",
    "commands",
    "agents",
    "lspservers",
    "tools",
    "outputstyles",
    "hooks.json",
    ".hooks.json",
    ".lsp.json",
  ]);
  const found: string[] = [];
  for (const entry of entries) {
    if (root && !entry.path.startsWith(root)) {
      continue;
    }
    const relative = entry.path.slice(root.length);
    const first = relative.split("/")[0]?.toLowerCase();
    if (first && unsupported.has(first)) {
      found.push(first);
    }
    if (
      relative === ".mcp.json" ||
      relative === "mcp.json" ||
      relative === ".app.json"
    ) {
      try {
        const parsed = JSON.parse(entry.text) as unknown;
        const key = relative === ".app.json" ? "apps" : "mcpServers";
        if (!(isRecord(parsed) && isEmptyPluginPlaceholder(parsed[key]))) {
          found.push(key);
        }
      } catch {
        found.push(relative);
      }
    }
  }
  if (found.length) {
    throw new CapabilityImportError(
      `This plugin includes unsupported components: ${[...new Set(found)].join(", ")}. Import skills only.`
    );
  }
}

function relativeSupportPath(skillPath: string, filePath: string): string {
  const root = dirname(skillPath);
  return filePath.startsWith(`${root}/`)
    ? filePath.slice(root.length + 1)
    : basename(filePath);
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function basename(path: string, suffix?: string): string {
  const value = path.slice(path.lastIndexOf("/") + 1);
  return suffix && value.endsWith(suffix)
    ? value.slice(0, -suffix.length)
    : value;
}

function firstMeaningfulLine(source: string): string {
  return (
    source
      .split("\n")
      .map((line) => line.trim())
      .find(
        (line) => line && !line.startsWith("```") && !line.startsWith("#")
      ) || ""
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
