import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defined } from "../test-utils";
import { contentTypeOf } from "./mime";

const EXTENSION_RE = /^[a-z0-9]{0,8}$/u;
const UNKNOWN_EXTENSION_RE = /^[a-z0-9]{1,8}$/u;
const UNKNOWN_WORD_RE = /^[a-z]{1,6}$/u;

const OCTET = "application/octet-stream";

const KNOWN: [ext: string, type: string][] = [
  ["pdf", "application/pdf"],
  [
    "docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [
    "pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  ["csv", "text/csv"],
  ["txt", "text/plain"],
  ["md", "text/markdown"],
  ["json", "application/json"],
  ["html", "text/html"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["mp4", "video/mp4"],
  ["webm", "video/webm"],
  ["mov", "video/quicktime"],
];

describe("contentTypeOf: the formats the bot produces", () => {
  it.each(KNOWN)("types .%s as %s", (ext, type) => {
    expect(contentTypeOf(`report.${ext}`)).toBe(type);
  });

  it.each([
    ["PHOTO.JPG", "image/jpeg"],
    ["Photo.Jpeg", "image/jpeg"],
    ["Planilla.XlSx", defined(KNOWN[2])[1]],
    ["Notes.mD", "text/markdown"],
    ["video.MoV", "video/quicktime"],
  ])("ignores mixed case in %s", (name, type) => {
    expect(contentTypeOf(name)).toBe(type);
  });
});

describe("contentTypeOf: names with more than one dot", () => {
  it.each([
    ["report.final.v2.pdf", "application/pdf"],
    ["2026.10.31 cierre.xlsx", defined(KNOWN[2])[1]],
    ["Screen Shot 12.30.45.png", "image/png"],
    ["data.csv.json", "application/json"],
  ])("uses the last extension of %s", (name, type) => {
    expect(contentTypeOf(name)).toBe(type);
  });

  it.each([
    ["report.pdf.exe", "a known type followed by an unknown one"],
    ["backup.tar.gz", "a compound archive extension"],
    ["report.pdf.bak", "a backup copy"],
  ])("does not trust an inner extension in %s (%s)", (name) => {
    expect(contentTypeOf(name)).toBe(OCTET);
  });
});

describe("contentTypeOf: everything else downloads as octet-stream", () => {
  it.each([
    ["doc", "legacy Word"],
    ["xls", "legacy Excel"],
    ["ppt", "legacy PowerPoint"],
    ["zip", "archives"],
    ["mp3", "audio"],
    ["htm", "the short html spelling"],
    ["jpe", "a rare jpeg spelling"],
    ["heic", "phone photos"],
    ["js", "scripts"],
    ["exe", "executables"],
    ["odt", "OpenDocument"],
  ])("types .%s (%s) as octet-stream", (ext) => {
    expect(contentTypeOf(`file.${ext}`)).toBe(OCTET);
  });

  it.each([
    ["report.", "a trailing dot"],
    ["", "an empty name"],
    ["README", "a name without extension"],
    ["Makefile", "a capitalized name without extension"],
    ["report.pdf ", "a trailing space after the extension"],
    ["report. pdf", "a space before the extension"],
    ["report.pdf\n", "a trailing newline"],
    ["report.p df", "a space inside the extension"],
    ["report.pdff", "an extension that only starts like a known one"],
    ["report.pd", "an extension that is a prefix of a known one"],
  ])("types %j (%s) as octet-stream", (name) => {
    expect(contentTypeOf(name)).toBe(OCTET);
  });

  it.each(["hasOwnProperty", "toString", "valueOf", "isPrototypeOf"])(
    "types a .%s file as octet-stream: camelCase prototype names miss once lower-cased",
    (ext) => {
      expect(contentTypeOf(`x.${ext}`)).toBe(OCTET);
    }
  );

  // Fixed bug: TYPES is a plain object literal, so the lookup walks Object.prototype.
  // contentTypeOf("x.constructor") → the Object function, contentTypeOf("x.__proto__") →
  // Object.prototype; expected "application/octet-stream". enviar_archivo would then send a
  // non-string content type to the hub and as the PUT header.
  it.each(["x.constructor", "x.__proto__", "X.CONSTRUCTOR"])(
    "types %s as octet-stream",
    (name) => {
      expect(contentTypeOf(name)).toBe(OCTET);
    }
  );
});

describe("contentTypeOf: unusual names", () => {
  it.each([
    ["café-report.docx", defined(KNOWN[1])[1]],
    ["résumé.pdf", "application/pdf"],
    ["写真.png", "image/png"],
    ["🙂.gif", "image/gif"],
    ["with spaces and (parentheses).txt", "text/plain"],
    ["[draft] notes.md", "text/markdown"],
  ])("types %s by its extension", (name, type) => {
    expect(contentTypeOf(name)).toBe(type);
  });

  it.each([".env", ".gitignore", ".bashrc"])(
    "types the dotfile %s as octet-stream",
    (name) => {
      expect(contentTypeOf(name)).toBe(OCTET);
    }
  );

  it("types a 10k-character name", () => {
    expect(contentTypeOf(`${"a".repeat(10_000)}.pdf`)).toBe("application/pdf");
  });

  // Fixed bug: a name without a dot is taken whole as its extension. contentTypeOf("pdf") →
  // "application/pdf" (same for "png", "json"…); expected "application/octet-stream", since a
  // file literally named `pdf` has no extension.
  it.each(["pdf", "PNG", "json"])(
    "types the extension-less file %s as octet-stream",
    (name) => {
      expect(contentTypeOf(name)).toBe(OCTET);
    }
  );
});

describe("contentTypeOf: properties", () => {
  const known = fc.constantFrom(...KNOWN);
  const stem = fc.string({ maxLength: 20 });

  it("is case-insensitive in the extension", () => {
    fc.assert(
      fc.property(
        stem,
        known,
        fc.array(fc.boolean(), { maxLength: 5, minLength: 5 }),
        (s, [ext, type], ups) => {
          const mixed = [...ext]
            .map((c, i) => (ups[i % ups.length] ? c.toUpperCase() : c))
            .join("");
          expect(contentTypeOf(`${s}.${mixed}`)).toBe(type);
        }
      ),
      { numRuns: 300, seed: 1 }
    );
  });

  it("depends only on what follows the last dot", () => {
    fc.assert(
      fc.property(stem, stem, known, (a, b, [ext]) => {
        expect(contentTypeOf(`${a}.${ext}`)).toBe(contentTypeOf(`${b}.${ext}`));
      }),
      { numRuns: 300, seed: 1 }
    );
  });

  it("always returns one of the known types or octet-stream", () => {
    const allowed = new Set([...KNOWN.map(([, t]) => t), OCTET]);
    const word = fc.stringMatching(EXTENSION_RE);
    fc.assert(
      fc.property(stem, word, (s, ext) => {
        expect(allowed.has(contentTypeOf(`${s}.${ext}`))).toBe(true);
      }),
      { numRuns: 300, seed: 1 }
    );
  });

  it("treats any unknown alphanumeric extension as octet-stream", () => {
    const names = new Set(KNOWN.map(([e]) => e));
    const unknown = fc
      .stringMatching(UNKNOWN_EXTENSION_RE)
      .filter((e) => !names.has(e));
    fc.assert(
      fc.property(stem, unknown, (s, ext) => {
        expect(contentTypeOf(`${s}.${ext}`)).toBe(OCTET);
      }),
      { numRuns: 300, seed: 1 }
    );
  });

  it("is never fooled by a known extension earlier in the name", () => {
    const names = new Set(KNOWN.map(([e]) => e));
    const unknown = fc
      .stringMatching(UNKNOWN_WORD_RE)
      .filter((e) => !names.has(e));
    fc.assert(
      fc.property(known, unknown, ([ext], tail) => {
        expect(contentTypeOf(`report.${ext}.${tail}`)).toBe(OCTET);
      }),
      { numRuns: 200, seed: 1 }
    );
  });
});
