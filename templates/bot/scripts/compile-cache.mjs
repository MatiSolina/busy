// Post-build step: bundles a Node compile cache into the bot's functions so a cold instance skips
// most of the module compilation (docs/flow-cold-start.md). Run after `eve build` on Vercel.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32 } from "node:zlib";

const ENTRY = "compile-cache-entry.mjs";
const FUNCTIONS = [".well-known/workflow/v1/flow.func", "__server.func"];
// Node's code types: 0 CommonJS, 1 ESM.
const TYPES = [1, 0];
const SCRIPT = /\.[cm]?js$/u;
const hex = (n) => n.toString(16).padStart(8, "0");

function scripts(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      return e.name === "_compile-cache" ? [] : scripts(path);
    }
    return SCRIPT.test(e.name) ? [path] : [];
  });
}

/** Loads the function once with the cache on, then records which module each entry belongs to. */
export function bundleCompileCache(target) {
  // Node keys entries by real paths: a symlinked tmp or build dir must not change them.
  const dir = realpathSync(target);
  const cache = join(dir, "_compile-cache");
  rmSync(cache, { force: true, recursive: true });
  const index = pathToFileURL(join(dir, "index.mjs")).href;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { enableCompileCache, flushCompileCache } from "node:module";
enableCompileCache({ directory: ${JSON.stringify(cache)}, portable: true });
await import(${JSON.stringify(index)});
flushCompileCache();
process.exit(0);`,
    ],
    { stdio: ["ignore", "ignore", "inherit"] }
  );
  const [tag] = readdirSync(cache);
  if (!tag) {
    throw new Error(`compile cache: nothing cached for ${dir}`);
  }
  const files = new Set(readdirSync(join(cache, tag)));
  const entries = scripts(dir).flatMap((path) => {
    const module = relative(dir, path);
    const rel = relative(join(cache, tag), path);
    return TYPES.flatMap((type) => {
      const file = hex(crc32(rel, crc32(Buffer.from([type]))));
      return files.has(file) ? [{ file, module, type }] : [];
    });
  });
  writeFileSync(join(cache, "manifest.json"), JSON.stringify({ entries, tag }));
  copyFileSync(new URL(ENTRY, import.meta.url), join(dir, ENTRY));
  const configPath = join(dir, ".vc-config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(
    configPath,
    JSON.stringify({ ...config, handler: ENTRY }, null, 2)
  );
  return { entries: entries.length, files: files.size, tag };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const out = process.argv[2] ?? ".vercel/output/functions";
  for (const name of FUNCTIONS) {
    const dir = join(out, name);
    // Route functions are symlinks to __server.func: patching the target covers them.
    if (existsSync(dir) && !lstatSync(dir).isSymbolicLink()) {
      console.info(`compile cache ${name}`, bundleCompileCache(dir));
    }
  }
}
