// Bundles templates/bot into JSON so the hub can deploy it from a Function.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../templates/bot/", import.meta.url));
const out = fileURLToPath(
  new URL("../lib/bots/template.generated.json", import.meta.url)
);
const SKIP = new Set([
  ".git",
  ".claude",
  ".agents",
  ".codex",
  ".deepsec",
  "node_modules",
  ".vercel",
  ".eve",
  ".output",
  ".turbo",
  "dist",
]);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (
      SKIP.has(e.name) ||
      e.isSymbolicLink() ||
      e.name === ".env" ||
      e.name.startsWith(".env.")
    ) {
      return [];
    }
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      return walk(path);
    }
    return e.name.endsWith(".test.ts") ? [] : [relative(root, path)];
  });
}

const files = Object.fromEntries(
  walk(root)
    .sort()
    .map((f) => [f, readFileSync(join(root, f), "utf8")])
);
// Without it every bot deploy resolves fresh versions from npm (scripts/lock-template.sh).
if (!files["package-lock.json"]) {
  throw new Error("templates/bot/package-lock.json is missing");
}
const json = JSON.stringify(files, null, 2);
if (!existsSync(out) || readFileSync(out, "utf8") !== json) {
  writeFileSync(out, json);
}
console.log(
  `bundled ${Object.keys(files).length} template files (${Math.round(json.length / 1024)} KB)`
);
