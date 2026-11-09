// Copied next to a function's index.mjs by compile-cache.mjs (docs/flow-cold-start.md). Node names
// its cache directory after the uid, and the function's files are read-only, so this links the
// bundled entries into /tmp under the keys Node computes for this instance, then loads the app.
import { mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { enableCompileCache } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { cachedDataVersionTag } from "node:v8";
import { crc32 } from "node:zlib";

const hex = (n) => n.toString(16).padStart(8, "0");

function linkCompileCache() {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, "_compile-cache");
  const { entries, tag } = JSON.parse(
    readFileSync(join(bundled, "manifest.json"), "utf8")
  );
  const runtime = `${process.version}-${process.arch}-${hex(cachedDataVersionTag())}`;
  // Another Node or V8 build can't use these entries: Node would only ignore them.
  if (!tag.startsWith(`${runtime}-`)) {
    return `mismatch ${tag} ${runtime}`;
  }
  const directory = join(
    realpathSync(tmpdir()),
    "eve-compile-cache",
    basename(here)
  );
  const tagDir = join(directory, `${runtime}-${process.getuid?.() ?? 0}`);
  mkdirSync(tagDir, { recursive: true });
  for (const entry of entries) {
    // Node's key: crc32 of the code type byte, then of the module path relative to the tag dir.
    const key = crc32(
      relative(tagDir, join(here, entry.module)),
      crc32(Buffer.from([entry.type]))
    );
    try {
      symlinkSync(join(bundled, tag, entry.file), join(tagDir, hex(key)));
    } catch {
      // Already linked by an earlier start of this instance.
    }
  }
  return enableCompileCache({ directory, portable: true }).status;
}

let status;
try {
  status = linkCompileCache();
} catch (error) {
  status = `error ${error?.code ?? "unknown"}`;
}
// Once per cold start: whether this instance's Node could use the bundled cache (1 = enabled).
console.info(JSON.stringify({ event: "compile_cache", status }));

export default (await import("./index.mjs")).default;
