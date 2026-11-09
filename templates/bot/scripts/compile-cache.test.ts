import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundleCompileCache } from "./compile-cache.mjs";

const ACCEPTED = /app\.mjs was accepted/u;
const ANY_ACCEPTED = /was accepted/u;

// A function shaped like eve's output: index.mjs loads the app with a dynamic import.
function fakeFunction(root: string) {
  const dir = join(root, "build", "flow.func");
  mkdirSync(join(dir, "_libs"), { recursive: true });
  const body = Array.from(
    { length: 400 },
    (_, i) => `export function f${i}(x) { return x * ${i} + ${i}; }`
  ).join("\n");
  writeFileSync(join(dir, "_libs", "app.mjs"), body);
  writeFileSync(
    join(dir, "index.mjs"),
    'const app = await import("./_libs/app.mjs");\nexport default { fetch: () => app.f1(2) };\n'
  );
  writeFileSync(
    join(dir, ".vc-config.json"),
    JSON.stringify({ handler: "index.mjs", runtime: "nodejs24.x" })
  );
  return dir;
}

function runEntry(dir: string, tmp: string) {
  const run = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(join(dir, "compile-cache-entry.mjs"))}); console.log(m.default.fetch());`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, NODE_DEBUG_NATIVE: "COMPILE_CACHE", TMPDIR: tmp },
    }
  );
  return { log: run.stderr, out: run.stdout.trim() };
}

describe("bundled compile cache", () => {
  const root = mkdtempSync(join(tmpdir(), "compile-cache-test-"));
  const built = fakeFunction(root);
  const summary = bundleCompileCache(built);
  // Deployed: another absolute path, read-only, and an empty /tmp.
  const deployed = join(root, "var", "task", "flow.func");
  cpSync(built, deployed, { recursive: true });
  chmodSync(join(deployed, "_compile-cache"), 0o555);

  it("records an entry per cached module and wraps the handler", () => {
    expect(summary.entries).toBe(summary.files);
    expect(summary.entries).toBeGreaterThanOrEqual(2);
    expect(
      JSON.parse(readFileSync(join(built, ".vc-config.json"), "utf8")).handler
    ).toBe("compile-cache-entry.mjs");
  });

  it("is used after the function moves, from a read-only directory", () => {
    const tmp = mkdtempSync(join(root, "instance-"));
    const { log, out } = runEntry(deployed, tmp);
    expect(out).toContain('"status":1');
    expect(out.endsWith("3")).toBe(true);
    expect(log).toMatch(ACCEPTED);
  });

  it("falls back to compiling when this Node can't use the entries", () => {
    const other = join(root, "other", "flow.func");
    cpSync(built, other, { recursive: true });
    const manifestPath = join(other, "_compile-cache", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, tag: "v0.0.0-x64-00000000-0" })
    );
    const { log, out } = runEntry(other, mkdtempSync(join(root, "instance-")));
    expect(out).toContain('"status":"mismatch');
    expect(out.endsWith("3")).toBe(true);
    expect(log).not.toMatch(ANY_ACCEPTED);
  });
});
