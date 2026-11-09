import { defineDynamic, defineSkill } from "eve/skills";
import { type HubFetch, hubFetch } from "../lib/hub";

const CAPABILITIES_PATH = "/api/bot/capabilities";
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SKILL_FILE_PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: This validation rejects control characters from untrusted skill paths.
const SKILL_CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/u;

// These limits protect the dynamic manifest and the sandbox from a malformed
// or unexpectedly large hub response. The hub applies the same shape limits;
// keep the bot defensive because this endpoint is authenticated, not trusted.
// The endpoint flattens enabled capabilities into one list. Keep this at the
// app-wide aggregate ceiling rather than the per-capability import ceiling.
export const MAX_SKILLS = 256;
export const MAX_SKILL_DESCRIPTION_BYTES = 2000;
export const MAX_SKILL_CONTENT_BYTES = 200_000;
export const MAX_SKILL_FILES = 128;
export const MAX_SKILL_FILE_PATH_LENGTH = 180;
export const MAX_SKILL_FILE_BYTES = 256 * 1024;
export const MAX_SKILL_TOTAL_BYTES = 384 * 1024;
export const MAX_SKILL_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface MarketplaceSkill {
  content: string;
  description: string;
  files: Record<string, string>;
  name: string;
}

interface CapabilityResponse {
  skills: MarketplaceSkill[];
}

/**
 * Read the app-wide shared capabilities as an authenticated bot. Skills are intentionally fetched for
 * every model call: enabling or disabling one in the hub must affect all bots and an
 * already-running session without a redeploy or memoized stale result.
 */
export async function listMarketplaceSkills(
  fetcher: HubFetch = hubFetch
): Promise<MarketplaceSkill[]> {
  let response: Response;
  try {
    response = await fetcher(CAPABILITIES_PATH);
  } catch (error) {
    throw new Error("Skills marketplace is unavailable", { cause: error });
  }
  if (!response.ok) {
    throw new Error(
      `Skills marketplace is unavailable (HTTP ${response.status})`
    );
  }

  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch (error) {
    throw new Error("Skills marketplace returned an invalid response", {
      cause: error,
    });
  }
  return parseCapabilitiesResponse(body);
}

/** Build the named dynamic skill map consumed by Eve's skill resolver. */
export async function resolveMarketplaceSkills(fetcher: HubFetch = hubFetch) {
  const skills = await listMarketplaceSkills(fetcher);
  return Object.fromEntries(
    skills.map((skill) => [
      skill.name,
      defineSkill({
        content: skill.content,
        description: skill.description,
        files: skill.files,
      }),
    ])
  );
}

export default defineDynamic(async () => resolveMarketplaceSkills());

function parseCapabilitiesResponse(body: unknown): MarketplaceSkill[] {
  if (
    !(isRecord(body) && Array.isArray(body.skills)) ||
    body.skills.length > MAX_SKILLS
  ) {
    throw new Error("Skills marketplace returned an invalid response");
  }

  const names = new Set<string>();
  let totalBytes = 0;
  return body.skills.map((value, index) => {
    const skill = parseSkill(value, index);
    if (names.has(skill.name)) {
      throw new Error(
        `Skills marketplace returned duplicate skill at index ${index}`
      );
    }
    names.add(skill.name);
    totalBytes += skillBytes(skill);
    if (totalBytes > MAX_SKILL_RESPONSE_BYTES) {
      throw new Error("Skills marketplace returned too much content");
    }
    return skill;
  });
}

function parseSkill(value: unknown, index: number): MarketplaceSkill {
  if (!isRecord(value)) {
    throw new Error(
      `Skills marketplace returned an invalid skill at index ${index}`
    );
  }

  const name = stringField(value.name);
  const description = stringField(value.description);
  const content = typeof value.content === "string" ? value.content : "";
  const { files } = value;
  if (
    !(isSkillName(name) && description && content.trim() && isRecord(files))
  ) {
    throw new Error(
      `Skills marketplace returned an invalid skill at index ${index}`
    );
  }

  const descriptionBytes = utf8Bytes(description);
  const contentBytes = utf8Bytes(content);
  if (
    descriptionBytes > MAX_SKILL_DESCRIPTION_BYTES ||
    contentBytes > MAX_SKILL_CONTENT_BYTES
  ) {
    throw new Error(
      `Skills marketplace returned an oversized skill at index ${index}`
    );
  }

  const fileEntries = Object.entries(files);
  if (fileEntries.length > MAX_SKILL_FILES) {
    throw new Error(
      `Skills marketplace returned too many files at index ${index}`
    );
  }

  const parsedFiles: Record<string, string> = {};
  let totalBytes = descriptionBytes + contentBytes;
  for (const [path, raw] of fileEntries) {
    if (!isSkillFilePath(path) || typeof raw !== "string") {
      throw new Error(
        `Skills marketplace returned an invalid file in skill at index ${index}`
      );
    }
    const bytes = utf8Bytes(raw);
    if (bytes > MAX_SKILL_FILE_BYTES) {
      throw new Error(
        `Skills marketplace returned an oversized file in skill at index ${index}`
      );
    }
    totalBytes += utf8Bytes(path) + bytes;
    if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
      throw new Error(
        `Skills marketplace returned an oversized skill at index ${index}`
      );
    }
    parsedFiles[path] = raw;
  }

  return { content, description, files: parsedFiles, name };
}

// Eve materializes dynamic map entries by their map key. The hub prefixes each
// name with a short content-derived identity (`s_<hash>_...`) before sending
// it here; the bot still validates the exact shell-safe name grammar Eve uses
// for authored and dynamic skills.
function isSkillName(value: string): boolean {
  if (value.length === 0 || value.length > 64) {
    return false;
  }
  return SKILL_NAME_RE.test(value);
}

function isSkillFilePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_SKILL_FILE_PATH_LENGTH ||
    value.split("/").at(-1)?.toLowerCase() === "skill.md" ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    SKILL_CONTROL_CHAR_RE.test(value)
  ) {
    return false;
  }
  return (
    SKILL_FILE_PATH_RE.test(value) &&
    value.split("/").every((segment) => {
      const lower = segment.toLowerCase();
      return (
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        lower !== "__proto__" &&
        lower !== "constructor" &&
        lower !== "prototype"
      );
    })
  );
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function skillBytes(skill: MarketplaceSkill): number {
  return (
    utf8Bytes(skill.name) +
    utf8Bytes(skill.description) +
    utf8Bytes(skill.content) +
    Object.entries(skill.files).reduce(
      (total, [path, content]) => total + utf8Bytes(path) + utf8Bytes(content),
      0
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Exported for focused parser tests without exposing a second runtime route.
export const parseMarketplaceCapabilities = parseCapabilitiesResponse;

export type { CapabilityResponse };
