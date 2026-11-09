import { describe, expect, it } from "vitest";
import { blobPathname } from "./files";

const PLAIN = /^bots\/bot-id\/file-id-[0-9a-f]{16}-a \(1\)\.png$/u;
const SAFE_PATH = /^[\w ./()+,'-]+$/u;

describe("blobPathname", () => {
  it("keeps plain names readable", () => {
    expect(blobPathname("bot-id", "file-id", "a (1).png")).toMatch(PLAIN);
  });

  it("keeps the path to safe ASCII and distinct per name", () => {
    const names = [
      "Captura 1.37.38 a. m..png",
      "Captura 1.37.38_a. m..png",
      "canción.png",
      "a#b.png",
      // A plain name crafted to look like a cleaned one's path.
      blobPathname("bot-id", "file-id", "a#b.png").slice(
        "bots/bot-id/file-id-".length
      ),
    ];
    const paths = names.map((n) => blobPathname("bot-id", "file-id", n));
    for (const p of paths) {
      expect(p).toMatch(SAFE_PATH);
    }
    expect(new Set(paths).size).toBe(names.length);
  });
});
