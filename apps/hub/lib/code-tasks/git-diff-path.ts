interface ParsedToken {
  next: number;
  value: string;
}

export interface GitDiffHeader {
  path: string;
  previousPath: string;
}

const HEADER_PREFIX = "diff --git ";
const OCTAL_DIGIT = /^[0-7]$/u;
const UNQUOTED_HEADER = /^a\/(?<previous>.+?) b\/(?<path>.+)$/u;

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd8_00 && code <= 0xdb_ff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc_00 || next > 0xdf_ff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc_00 && code <= 0xdf_ff) {
      return true;
    }
  }
  return false;
}

interface DecodedEscape {
  byte: number;
  next: number;
}

function decodeEscape(input: string, start: number): DecodedEscape | null {
  const escapeCharacter = input[start];
  if (escapeCharacter === undefined) {
    return null;
  }

  const escapedByte = {
    '"': 0x22,
    "\\": 0x5c,
    a: 0x07,
    b: 0x08,
    f: 0x0c,
    n: 0x0a,
    r: 0x0d,
    t: 0x09,
    v: 0x0b,
  }[escapeCharacter];
  if (escapedByte !== undefined) {
    return { byte: escapedByte, next: start + 1 };
  }

  if (!OCTAL_DIGIT.test(escapeCharacter)) {
    return null;
  }
  let value = 0;
  let digits = 0;
  while (digits < 3 && OCTAL_DIGIT.test(input[start + digits] ?? "")) {
    value = value * 8 + Number(input[start + digits]);
    digits += 1;
  }
  return value > 0xff ? null : { byte: value, next: start + digits };
}

function decodeQuotedToken(input: string, start: number): ParsedToken | null {
  if (input[start] !== '"') {
    return null;
  }

  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let index = start + 1;
  let textStart = index;

  const appendText = (end: number): boolean => {
    const text = input.slice(textStart, end);
    if (hasUnpairedSurrogate(text)) {
      return false;
    }
    bytes.push(...encoder.encode(text));
    return true;
  };

  while (index < input.length) {
    const character = input[index];
    if (character === '"') {
      if (!appendText(index)) {
        return null;
      }
      try {
        return {
          next: index + 1,
          value: new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(Uint8Array.from(bytes)),
        };
      } catch {
        return null;
      }
    }

    if (character !== "\\") {
      index += 1;
      continue;
    }

    if (!appendText(index)) {
      return null;
    }
    index += 1;
    const decodedEscape = decodeEscape(input, index);
    if (!decodedEscape) {
      return null;
    }
    bytes.push(decodedEscape.byte);
    index = decodedEscape.next;
    textStart = index;
  }

  return null;
}

function stripPathPrefix(value: string, prefix: "a/" | "b/"): string | null {
  return value.startsWith(prefix) ? value.slice(prefix.length) : null;
}

function parseQuotedHeader(input: string): GitDiffHeader | null {
  const previous = decodeQuotedToken(input, 0);
  if (!previous || input[previous.next] !== " ") {
    return null;
  }

  let secondStart = previous.next;
  while (input[secondStart] === " ") {
    secondStart += 1;
  }
  const current = decodeQuotedToken(input, secondStart);
  if (!current || current.next !== input.length) {
    return null;
  }

  const previousPath = stripPathPrefix(previous.value, "a/");
  const path = stripPathPrefix(current.value, "b/");
  return previousPath === null || path === null ? null : { path, previousPath };
}

function parseUnquotedHeader(input: string): GitDiffHeader | null {
  const match = UNQUOTED_HEADER.exec(input);
  if (!match?.groups) {
    return null;
  }
  return {
    path: match.groups.path,
    previousPath: match.groups.previous,
  };
}

/** Parse the two path operands from a `git diff --git` header. */
export function parseGitDiffHeader(line: string): GitDiffHeader | null {
  if (!line.startsWith(HEADER_PREFIX)) {
    return null;
  }

  const input = line.slice(HEADER_PREFIX.length);
  return input.startsWith('"')
    ? parseQuotedHeader(input)
    : parseUnquotedHeader(input);
}
