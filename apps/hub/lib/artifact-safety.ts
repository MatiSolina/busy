const TEXT_CONTENT_TYPES = new Set([
  "application/javascript",
  "application/json",
  "application/toml",
  "application/x-javascript",
  "application/x-sh",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "text/css",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
  "text/xml",
]);

const SENSITIVE_NAME =
  /^(?:\.env(?:\.(?!(?:example|sample|template)$)[a-z0-9._-]+)?|(?:credentials?|service-account|secret(?:s)?|token)\.(?:json|txt|ya?ml)|id_(?:rsa|ed25519))$/iu;

// Require an assignment-like shape so ordinary prose about passwords or tokens
// remains deliverable. This is intentionally a narrow guard, not a secret scanner.
const ASSIGNMENT_KEY =
  /(?<![\p{L}\p{N}_])["']?(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|secret|authorization|bearer|contraseña|clave|credencial)["']?\s*[:=][ \t]*/gimu;
const ASSIGNMENT_KEY_AT = new RegExp(ASSIGNMENT_KEY.source, "iuy");
const REDACTED_PLACEHOLDERS = new Set([
  "<masked>",
  "<placeholder>",
  "<redacted>",
  "<removed>",
  "<your-api-key>",
  "<your-password>",
  "<your-secret>",
  "<your-token>",
  "<your_api_key>",
  "[masked]",
  "[redacted]",
  "[removed]",
]);
const LOGIN_LABELS = [
  "contraseña",
  "username",
  "credencial",
  "log-in",
  "log in",
  "password",
  "usuario",
  "correo",
  "login",
  "clave",
  "email",
  "user",
] as const;
const WELL_KNOWN_TOKEN =
  /(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})/u;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u;
const PATH_SEPARATOR = /[\\/]/u;
const PLAIN_DELIMITER = /[\s"'`,;{}]/u;
const WHITESPACE = /\s/u;
// Login-pair values deliberately exclude `=` and `:` so assignment-form
// inputs are consumed once by the assignment parser and never rescanned.
const LOGIN_VALUE_CHAR = /[A-Za-z0-9_./+~!@#$%^&*-]/u;
const DIGIT = /\d/u;
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const LOGIN_CONTEXT_LABEL =
  /^(?:login|log[- ]?in|usuario|username|user|correo|email)$/u;
const TEXT_FILE_EXTENSION =
  /\.(?:env|cfg|conf|ini|json|jsonl|js|jsx|mjs|cjs|ts|tsx|css|csv|md|markdown|txt|log|sh|yaml|yml|xml|pem|key)$/iu;

/**
 * Small bodies are decoded and scanned even when their MIME type is
 * misleading. Larger declared-text bodies are blocked; larger unknown/binary
 * bodies are left to format-specific controls that are outside this guard.
 */
export const MAX_SCANNABLE_TEXT_BYTES = 5 * 1024 * 1024;

export type ArtifactSafetyReason =
  | "credential_pattern"
  | "sensitive_filename"
  | "unscannable_text";

function isPlainDelimiter(char: string | undefined): boolean {
  return Boolean(char && PLAIN_DELIMITER.test(char));
}

function hasAllowedSuffix(text: string, start: number): boolean {
  let cursor = start;
  while (text[cursor] === " " || text[cursor] === "\t") {
    cursor += 1;
  }
  if (cursor >= text.length || ",;\r\n}`]#".includes(text[cursor] ?? "")) {
    return true;
  }
  if (text[cursor] === "/" && text[cursor + 1] === "/") {
    return true;
  }
  // A subsequent assignment terminates this value even if its own value is
  // redacted. Check only this position without disturbing the main iterator.
  ASSIGNMENT_KEY_AT.lastIndex = cursor;
  return ASSIGNMENT_KEY_AT.test(text);
}

function skipBearerPrefix(text: string, start: number): number {
  if (text.slice(start, start + 6).toLowerCase() !== "bearer") {
    return start;
  }
  const after = start + 6;
  if (text[after] !== " " && text[after] !== "\t") {
    return start;
  }
  let cursor = after + 1;
  while (text[cursor] === " " || text[cursor] === "\t") {
    cursor += 1;
  }
  return cursor;
}

interface PlainValueRange {
  end: number;
  start: number;
  validSuffix: boolean;
}

function readPlainAssignmentValue(
  text: string,
  cursor: number,
  cache: { plain?: PlainValueRange }
): { value: string; validSuffix: boolean } {
  let { plain } = cache;
  if (!plain || cursor < plain.start || cursor >= plain.end) {
    let end = cursor;
    while (end < text.length && !isPlainDelimiter(text[end])) {
      end += 1;
    }
    plain = { end, start: cursor, validSuffix: hasAllowedSuffix(text, end) };
    cache.plain = plain;
  }
  return {
    validSuffix: plain.validSuffix,
    // Rejected long tokens can contain many labels. Reuse their scan result
    // without allocating or trimming the same long suffix for every label.
    value: plain.validSuffix ? text.slice(cursor, plain.end) : "",
  };
}

function readAssignmentValue(
  text: string,
  start: number,
  cache: { plain?: PlainValueRange }
): { value: string; validSuffix: boolean } {
  let cursor = start;
  while (WHITESPACE.test(text[cursor] ?? "")) {
    cursor += 1;
  }
  cursor = skipBearerPrefix(text, cursor);
  const quote = text[cursor];
  if (quote === '"' || quote === "'" || quote === "`") {
    let escaped = false;
    for (let index = cursor + 1; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        return {
          validSuffix: true,
          value: text.slice(cursor + 1, index),
        };
      }
    }
    return {
      validSuffix: true,
      // An unclosed quote is not an exact redacted example.
      // Inspect its remainder conservatively rather than exempting a prefix.
      value: text.slice(cursor + 1),
    };
  }
  return readPlainAssignmentValue(text, cursor, cache);
}

// Inspect every label without splitting a password at an embedded label.
// Cache plain token boundaries so nested assignments cannot cause rescans.
function hasCredentialAssignment(text: string): boolean {
  ASSIGNMENT_KEY.lastIndex = 0;
  const cache: { plain?: PlainValueRange } = {};
  let match = ASSIGNMENT_KEY.exec(text);
  while (match) {
    const valueStart = ASSIGNMENT_KEY.lastIndex;
    const read = readAssignmentValue(text, valueStart, cache);
    const value = read.value.trim();
    if (
      read.validSuffix &&
      value.length >= 8 &&
      !REDACTED_PLACEHOLDERS.has(value.toLowerCase())
    ) {
      return true;
    }
    match = ASSIGNMENT_KEY.exec(text);
  }
  return false;
}

function readLoginValue(text: string, start: number): number | null {
  if (!WHITESPACE.test(text[start] ?? "")) {
    return null;
  }
  let cursor = start;
  while (WHITESPACE.test(text[cursor] ?? "")) {
    cursor += 1;
  }
  for (const word of ["is", "es"]) {
    if (
      text.slice(cursor, cursor + word.length).toLowerCase() === word &&
      WHITESPACE.test(text[cursor + word.length] ?? "")
    ) {
      cursor += word.length;
      while (WHITESPACE.test(text[cursor] ?? "")) {
        cursor += 1;
      }
      break;
    }
  }
  const startValue = cursor;
  let hasDigit = false;
  while (LOGIN_VALUE_CHAR.test(text[cursor] ?? "")) {
    hasDigit ||= DIGIT.test(text[cursor] ?? "");
    cursor += 1;
  }
  return cursor - startValue >= 8 && hasDigit ? cursor : null;
}

function isWordCharacter(char: string | undefined): boolean {
  return Boolean(char && WORD_CHARACTER.test(char));
}

function hasLoginCredentialPair(text: string): boolean {
  let previousContextEnd = Number.NEGATIVE_INFINITY;
  let previousCredentialValueEnd: number | null = null;
  const lowerText = text.toLowerCase();
  let cursor = 0;
  while (cursor < lowerText.length) {
    let label: string | null = null;
    for (const candidate of LOGIN_LABELS) {
      if (
        lowerText.startsWith(candidate, cursor) &&
        !isWordCharacter(lowerText[cursor - 1]) &&
        !isWordCharacter(lowerText[cursor + candidate.length])
      ) {
        label = candidate;
        break;
      }
    }
    if (!label) {
      cursor += 1;
      continue;
    }
    const end = cursor + label.length;
    const context = LOGIN_CONTEXT_LABEL.test(label);
    if (context) {
      if (
        previousCredentialValueEnd !== null &&
        cursor - previousCredentialValueEnd <= 120
      ) {
        return true;
      }
      previousContextEnd = end;
    } else {
      const valueEnd = readLoginValue(text, end);
      if (valueEnd !== null && end - previousContextEnd <= 120) {
        return true;
      }
      previousCredentialValueEnd = valueEnd;
    }
    cursor = end;
  }
  return false;
}

export function isSensitiveArtifactName(name: string): boolean {
  const base = name.trim().split(PATH_SEPARATOR).at(-1) ?? "";
  return SENSITIVE_NAME.test(base);
}

export function isTextArtifact(contentType: string, name: string): boolean {
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized.startsWith("text/") || TEXT_CONTENT_TYPES.has(normalized)) {
    return true;
  }
  return TEXT_FILE_EXTENSION.test(name);
}

export function scanTextArtifact(
  name: string,
  contentType: string,
  bytes: Uint8Array
): ArtifactSafetyReason | null {
  if (isSensitiveArtifactName(name)) {
    return "sensitive_filename";
  }
  const declaredText = isTextArtifact(contentType, name);
  if (bytes.byteLength > MAX_SCANNABLE_TEXT_BYTES) {
    return declaredText ? "unscannable_text" : null;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return declaredText ? "unscannable_text" : null;
  }
  // Sniff small, valid UTF-8 bodies even when a caller lies about the MIME
  // type or renames the file. Sparse/binary formats are outside this guard;
  // PDF/DOCX extraction is intentionally out of scope.
  return hasCredentialAssignment(text) ||
    hasLoginCredentialPair(text) ||
    WELL_KNOWN_TOKEN.test(text) ||
    PRIVATE_KEY.test(text)
    ? "credential_pattern"
    : null;
}
