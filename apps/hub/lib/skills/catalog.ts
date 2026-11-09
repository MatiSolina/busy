import { createHash } from "node:crypto";
import { getVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";
import { parseSkillMarkdown } from "@/lib/capabilities/import";
import {
  type CapabilityRow,
  installRegistryCapability,
  publicCapability,
} from "@/lib/capabilities/store";
import type {
  CapabilityInput,
  CapabilitySkill,
  SkillOrigin,
} from "@/lib/capabilities/types";
import { parseCapabilityInput } from "@/lib/capabilities/validation";

const SKILLS_API_ORIGIN = "https://www.skills.sh";
const SKILLS_API_PREFIX = "/api/v1/skills";
const SEARCH_LIMIT_DEFAULT = 20;
const SEARCH_LIMIT_MAX = 50;
const MAX_SEARCH_QUERY = 120;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Registry paths reject ASCII control characters explicitly.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const SAFE_CATALOG_PATH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/u;
export const SHA256_HASH = /^[a-f0-9]{64}$/iu;

export interface CatalogSkill {
  files: Array<{ path: string; contents: string }>;
  hash: string;
  id: string;
  installs: number;
  name: string;
  registryHash?: string;
  slug: string;
  source: string;
  url: string;
}

export type CatalogSearchSkill = Omit<
  CatalogSkill,
  "hash" | "registryHash" | "files"
>;

export class SkillsValidationError extends Error {}
export class SkillsUnavailableError extends Error {}
export class SkillsNotFoundError extends Error {}
export class SkillsChangedError extends Error {}
export class SkillsSnapshotUnavailableError extends Error {}
export class SkillsRateLimitError extends Error {
  readonly retryAfter: string | null;

  constructor(message: string, retryAfter: string | null) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
type TokenProvider = () => Promise<string>;

const defaultToken: TokenProvider = () => getVercelOidcToken();

export interface SkillsCatalogDeps {
  fetcher?: Fetcher;
  token?: TokenProvider;
}

export const installInputSchema = z
  .object({ hash: z.string().regex(SHA256_HASH), id: z.string() })
  .strict();
export type InstallSkillInput = z.infer<typeof installInputSchema>;

export async function searchSkills(
  query: string,
  owner?: string,
  limit: number | undefined = SEARCH_LIMIT_DEFAULT,
  deps: SkillsCatalogDeps = {}
): Promise<CatalogSearchSkill[]> {
  const parsedQuery = normalizeQuery(query);
  const parsedOwner =
    owner === undefined || owner.trim() === ""
      ? undefined
      : normalizeOwner(owner);
  const parsedLimit = normalizeLimit(limit);
  const params = new URLSearchParams({
    limit: String(parsedLimit),
    q: parsedQuery,
  });
  if (parsedOwner) {
    params.set("owner", parsedOwner);
  }
  const body = await requestJson(
    `${SKILLS_API_ORIGIN}${SKILLS_API_PREFIX}/search?${params.toString()}`,
    deps
  );
  if (!(isRecord(body) && Array.isArray(body.data))) {
    throw new SkillsUnavailableError(
      "Skills catalog returned an invalid search response."
    );
  }
  return body.data
    .slice(0, parsedLimit)
    .map((value, index) => parseSearchSkill(value, index));
}

export async function previewSkill(
  id: string,
  deps: SkillsCatalogDeps = {}
): Promise<{
  skill: CatalogSkill;
  capability: CapabilityInput;
  hash: string;
  origin: SkillOrigin;
}> {
  const parsed = parseSkillId(id);
  const canonicalId = canonicalSkillId(parsed);
  const url = `${SKILLS_API_ORIGIN}${SKILLS_API_PREFIX}/${parsed.path.map(encodeURIComponent).join("/")}`;
  const body = await requestJson(url, deps);
  if (!isRecord(body)) {
    throw new SkillsUnavailableError(
      "Skills catalog returned an invalid skill response."
    );
  }
  if (body.files === null) {
    throw new SkillsSnapshotUnavailableError(
      "This skill has no downloadable snapshot yet."
    );
  }
  const files = parseFiles(body.files);
  const registryHash = stringField(body.hash);
  if (!(registryHash && SHA256_HASH.test(registryHash))) {
    throw new SkillsUnavailableError(
      "This skill has no immutable snapshot yet."
    );
  }
  const source = stringField(body.source);
  const slug = stringField(body.slug);
  if (
    source !== parsed.source ||
    slug !== parsed.slug ||
    stringField(body.id).toLowerCase() !== canonicalId
  ) {
    throw new SkillsUnavailableError(
      "Skills catalog returned mismatched skill metadata."
    );
  }
  const skillEntries = files.filter(
    (file) => file.path.split("/").at(-1)?.toLowerCase() === "skill.md"
  );
  if (skillEntries.length === 0) {
    throw new SkillsNotFoundError("The selected skill has no SKILL.md file.");
  }
  if (skillEntries.length > 1) {
    throw new SkillsValidationError(
      "The selected skill contains multiple SKILL.md files."
    );
  }
  const [skillEntry] = skillEntries;
  if (!skillEntry) {
    throw new SkillsNotFoundError("The selected skill has no SKILL.md file.");
  }
  const root = dirname(skillEntry.path);
  const outsideRoot = root
    ? files.some(
        (file) => file !== skillEntry && !file.path.startsWith(`${root}/`)
      )
    : false;
  if (outsideRoot) {
    throw new SkillsValidationError(
      "The selected snapshot contains files outside its skill folder."
    );
  }
  const parsedSkill = parseSkillMarkdown(skillEntry.contents, slug);
  const supportingFiles = Object.fromEntries(
    files
      .filter((file) => file !== skillEntry)
      .map((file) => [relativePath(root, file.path), file.contents])
  );
  const capabilitySkill: CapabilitySkill = {
    content: parsedSkill.content,
    description: parsedSkill.description,
    files: supportingFiles,
    name: safeSkillName(parsedSkill.name, slug),
  };
  const hash = reviewedHash(canonicalId, files);
  const capability: CapabilityInput = parseCapabilityInput({
    description: capabilitySkill.description,
    kind: "skill",
    name: stableCapabilityName(canonicalId),
    skills: [capabilitySkill],
    version: hash,
  });
  const skill: CatalogSkill = {
    files,
    hash,
    id: canonicalId,
    installs: finiteInstallCount(body.installs),
    name: parsedSkill.name,
    registryHash,
    slug,
    source,
    url: `https://skills.sh/${canonicalId}`,
  };
  return {
    capability,
    hash,
    origin: { hash, id: canonicalId, registry: "skills.sh", registryHash },
    skill,
  };
}

export async function installSkillForBot(
  input: InstallSkillInput,
  deps: SkillsCatalogDeps = {}
): Promise<{
  row: CapabilityRow;
  capability: ReturnType<typeof publicCapability>;
  hash: string;
  reused: boolean;
}> {
  const parsedResult = installInputSchema.safeParse(input);
  if (!parsedResult.success) {
    throw new SkillsValidationError(
      "Provide a skills.sh id and a SHA-256 snapshot hash."
    );
  }
  const parsed = parsedResult.data;
  const preview = await previewSkill(parsed.id, deps);
  if (preview.hash.toLowerCase() !== parsed.hash.toLowerCase()) {
    throw new SkillsChangedError(
      "The skill changed while it was being reviewed. Preview it again."
    );
  }
  const installed = await installRegistryCapability(
    preview.capability,
    preview.origin
  );
  return {
    capability: publicCapability(installed.row),
    hash: preview.hash,
    reused: installed.reused,
    row: installed.row,
  };
}

export function stableCapabilityName(id: string): string {
  const parsed = parseSkillId(id);
  const slug = parsed.slug.replace(/[^A-Za-z0-9_-]+/gu, "_");
  const digest = createHash("sha256")
    .update(canonicalSkillId(parsed))
    .digest("hex")
    .slice(0, 12);
  return `${slug.slice(0, 43)}-${digest}`.slice(0, 64);
}

export function parseSkillId(id: string): {
  source: string;
  slug: string;
  path: string[];
} {
  if (
    typeof id !== "string" ||
    id.length < 3 ||
    id.length > 260 ||
    id.includes("\\") ||
    id.includes("?") ||
    id.includes("#")
  ) {
    throw new SkillsValidationError("Choose a valid skills.sh skill id.");
  }
  const parts = id.split("/");
  if (
    parts.some(
      (part) => !SAFE_SEGMENT.test(part) || part === "." || part === ".."
    )
  ) {
    throw new SkillsValidationError("Choose a valid skills.sh skill id.");
  }
  if (parts.length !== 2 && parts.length !== 3) {
    throw new SkillsValidationError("Choose a valid skills.sh skill id.");
  }
  const sourceParts =
    parts.length === 3 ? parts.slice(0, 2) : parts.slice(0, 1);
  const slug = parts.at(-1);
  if (!slug) {
    throw new SkillsValidationError("Choose a valid skills.sh skill id.");
  }
  const source = sourceParts.join("/");
  if (
    sourceParts.length === 2 &&
    !(
      sourceParts[0] &&
      sourceParts[1] &&
      GITHUB_OWNER.test(sourceParts[0]) &&
      SAFE_SEGMENT.test(sourceParts[1])
    )
  ) {
    throw new SkillsValidationError("Choose a valid skills.sh source.");
  }
  return { path: parts, slug, source };
}

function canonicalSkillId(parsed: { source: string; slug: string }): string {
  return `${parsed.source}/${parsed.slug}`.toLowerCase();
}

export function reviewedHash(
  id: string,
  files: Array<{ path: string; contents: string }>
): string {
  const sorted = [...files].sort((a, b) => {
    if (a.path < b.path) {
      return -1;
    }
    if (a.path > b.path) {
      return 1;
    }
    return 0;
  });
  // Property order is part of the persisted digest. Ordered entries protect
  // both the envelope and its files from formatter-driven object key changes.
  const canonicalFiles = sorted.map(({ path, contents }) =>
    Object.fromEntries([
      ["path", path],
      ["contents", contents],
    ])
  );
  const snapshot = Object.fromEntries([
    ["id", id.toLowerCase()],
    ["files", canonicalFiles],
  ]);
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

async function requestJson(
  url: string,
  deps: SkillsCatalogDeps
): Promise<unknown> {
  const fetcher = deps.fetcher ?? fetch;
  const token = await (deps.token ?? defaultToken)().catch(() => {
    throw new SkillsUnavailableError(
      "Skills catalog authentication is unavailable."
    );
  });
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // biome-ignore lint/style/useErrorCause: Upstream errors may contain tokens or URLs; expose only the stable catalog error.
    throw new SkillsUnavailableError("Skills catalog is unavailable.");
  }
  if (response.status >= 300 && response.status < 400) {
    throw new SkillsUnavailableError(
      "Skills catalog returned an unsafe redirect."
    );
  }
  if (response.status === 404) {
    throw new SkillsNotFoundError("Skill not found in the skills catalog.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new SkillsUnavailableError(
      "Skills catalog authentication was rejected."
    );
  }
  if (response.status === 429) {
    throw new SkillsRateLimitError(
      "Skills catalog rate limit reached.",
      response.headers.get("retry-after")
    );
  }
  if (!response.ok) {
    throw new SkillsUnavailableError("Skills catalog request failed.");
  }
  const text = await readLimited(response, MAX_BODY_BYTES);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // biome-ignore lint/style/useErrorCause: Parser details can contain untrusted response data.
    throw new SkillsUnavailableError("Skills catalog returned invalid JSON.");
  }
}

async function readLimited(
  response: Response,
  maxBytes: number
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new SkillsValidationError("Skill preview is too large.");
  }
  if (!response.body) {
    const text = await response.text();
    if (utf8(text) > maxBytes) {
      throw new SkillsValidationError("Skill preview is too large.");
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: The response stream must be decoded in arrival order.
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new SkillsValidationError("Skill preview is too large.");
      }
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function normalizeQuery(value: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (result.length < 2 || result.length > MAX_SEARCH_QUERY) {
    throw new SkillsValidationError("Search with 2–120 characters.");
  }
  return result;
}

function normalizeOwner(value: string): string {
  const result = value.trim().toLowerCase();
  if (!GITHUB_OWNER.test(result)) {
    throw new SkillsValidationError("Choose a valid GitHub owner.");
  }
  return result;
}

function normalizeLimit(value: number): number {
  const result = Number.isInteger(value) ? value : SEARCH_LIMIT_DEFAULT;
  if (result < 1 || result > SEARCH_LIMIT_MAX) {
    throw new SkillsValidationError(
      `Limit must be between 1 and ${SEARCH_LIMIT_MAX}.`
    );
  }
  return result;
}

function parseSearchSkill(value: unknown, index: number): CatalogSearchSkill {
  if (!isRecord(value)) {
    throw new SkillsUnavailableError(
      `Skills catalog returned an invalid result at index ${index}.`
    );
  }
  const id = stringField(value.id);
  const parsed = parseSkillId(id);
  const name = stringField(value.name) || parsed.slug;
  const source = stringField(value.source) || parsed.source;
  if (source !== parsed.source) {
    throw new SkillsUnavailableError(
      "Skills catalog returned a mismatched source."
    );
  }
  const slug = stringField(value.slug) || parsed.slug;
  if (slug !== parsed.slug) {
    throw new SkillsUnavailableError(
      "Skills catalog returned a mismatched slug."
    );
  }
  return {
    id,
    installs: finiteInstallCount(value.installs),
    name: name.slice(0, 160),
    slug,
    source,
    url: `https://skills.sh/${id}`,
  };
}

function parseFiles(value: unknown): Array<{ path: string; contents: string }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new SkillsValidationError("Skill file tree is invalid or too large.");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new SkillsValidationError(`Skill file ${index + 1} is invalid.`);
    }
    const path = stringField(entry.path);
    const contents = typeof entry.contents === "string" ? entry.contents : "";
    if (!isSafeCatalogPath(path) || seen.has(path)) {
      throw new SkillsValidationError(`Skill file ${index + 1} is invalid.`);
    }
    if (path.split("/").at(-1)?.toLowerCase() === "skill.md" && !contents) {
      throw new SkillsValidationError(`Skill file ${index + 1} is invalid.`);
    }
    seen.add(path);
    return { contents, path };
  });
}

function safeSkillName(name: string, fallback: string): string {
  const normalized = (name || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  if (!normalized || normalized === "eve" || normalized.startsWith("eve__")) {
    throw new SkillsValidationError("The selected skill has an invalid name.");
  }
  return normalized;
}

function relativePath(root: string, path: string): string {
  if (!root) {
    return path;
  }
  if (path === root) {
    return "";
  }
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function finiteInstallCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function utf8(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeCatalogPath(value: string): boolean {
  if (
    !value ||
    value.length > 180 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    CONTROL_CHARACTERS.test(value)
  ) {
    return false;
  }
  return (
    SAFE_CATALOG_PATH.test(value) &&
    value
      .split("/")
      .every(
        (part) =>
          part &&
          part !== "." &&
          part !== ".." &&
          !["__proto__", "prototype", "constructor"].includes(
            part.toLowerCase()
          )
      )
  );
}
