// scripts/release.mjs, run in-process from a temp cwd with @vercel/blob's `put` mocked, plus a few real
// `node scripts/release.mjs` runs where a module hook swaps @vercel/blob for a fake that writes to the temp dir.
// Nothing here can reach Blob: there is no token, and `put` never is the real one.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fc from "fast-check";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { release as hubRelease } from "../../hub/lib/install";

const SCRIPT = fileURLToPath(new URL("./release.mjs", import.meta.url));
const HUB_DIR = fileURLToPath(new URL("../../hub", import.meta.url));
const DOWNLOAD_ROUTE = fileURLToPath(
  new URL("../../hub/app/api/download/route.ts", import.meta.url)
);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const zipName = (v: string) => `Busy-${v}-arm64-mac.zip`;
const bytesOf = (s: string) => new TextEncoder().encode(s);
const present = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Expected a present test value");
  }
  return value;
};

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    rmSync(r, { force: true, recursive: true });
  }
});

/** A temp apps/desktop: package.json with this version and these files under dist/. */
function layout(pkg: unknown, dist: Record<string, Uint8Array> = {}) {
  const root = mkdtempSync(join(tmpdir(), "busy-release-"));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    typeof pkg === "string" ? pkg : JSON.stringify(pkg)
  );
  mkdirSync(join(root, "dist"));
  for (const [name, bytes] of Object.entries(dist)) {
    writeFileSync(join(root, "dist", name), bytes);
  }
  return root;
}

type Put = (
  pathname: string,
  body: Buffer,
  options: Record<string, unknown>
) => Promise<{ pathname: string; url: string }>;
const okPut: Put = async (pathname) => ({
  pathname,
  url: `https://store.private.blob.vercel-storage.com/${pathname}`,
});

const cwd = process.cwd();
afterEach(() => {
  process.chdir(cwd);
  vi.doUnmock("@vercel/blob");
});

/** Runs release.mjs with cwd = root. */
async function run(root: string, impl: Put = okPut) {
  const put = vi.fn(impl);
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.join(" "));
  });
  vi.resetModules();
  vi.doMock("@vercel/blob", () => ({ put }));
  process.chdir(root);
  let error: Error | undefined;
  try {
    await import("./release.mjs");
  } catch (e) {
    error = e as Error;
  } finally {
    process.chdir(cwd);
    log.mockRestore();
  }
  const out = lines.join("\n");
  const field = (name: string) =>
    new RegExp(`^${name}\\s+(\\S+)$`, "mu").exec(out)?.[1];
  return {
    body: put.mock.calls[0]?.[1],
    error,
    options: put.mock.calls[0]?.[2],
    out,
    put,
    sha256: field("sha256"),
    version: field("version"),
  };
}

describe("the version in package.json", () => {
  it.each(["0.2.0", "1.0.0", "10.20.30", "0.0.0"])("releases %s", async (v) => {
    const zip = bytesOf(`zip ${v}`);
    const r = await run(layout({ version: v }, { [zipName(v)]: zip }));
    expect(r.error).toBeUndefined();
    expect(r.put).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(present(r.body))).toEqual(zip);
    expect(r.version).toBe(v);
  });

  it.each([
    ["two parts", "0.2"],
    ["one part", "1"],
    ["four parts", "0.2.0.1"],
    ["a v prefix", "v0.2.0"],
    ["a prerelease", "0.2.0-beta.1"],
    ["build metadata", "0.2.0+build.5"],
    ["an empty string", ""],
    ["a leading space", " 0.2.0"],
    ["a trailing newline", "0.2.0\n"],
    ["a newline between two versions", "0.2.0\n0.3.0"],
    ["a wildcard", "0.2.x"],
    ["an empty part", "0..2"],
    ["a negative part", "-1.2.0"],
    ["fullwidth digits", "０.２.０"],
    ["a path traversal", "0.2.0/../../x"],
    ["the word latest", "latest"],
    ["a number", 1],
    ["null", null],
  ])("refuses %s before uploading anything", async (_label, version) => {
    // The zip a sloppy check would upload is there, so only the version check stands in the way.
    const r = await run(
      layout(
        { version },
        {
          [zipName(String(version))]: bytesOf("zip"),
          [zipName("0.2.0")]: bytesOf("zip"),
        }
      )
    );
    expect(r.error?.message).toBe(
      `package.json version must be x.y.z, got "${version}"`
    );
    expect(r.put).not.toHaveBeenCalled();
    expect(r.out).toBe("");
  });

  it("checks the version before looking for a build", async () => {
    const r = await run(layout({ version: "0.3" }));
    expect(r.error?.message).toBe(
      'package.json version must be x.y.z, got "0.3"'
    );
  });

  it("refuses a package.json without a version", async () => {
    const r = await run(
      layout({ name: "busy-desktop" }, { [zipName("0.2.0")]: bytesOf("zip") })
    );
    expect(r.error?.message).toContain('got "undefined"');
    expect(r.put).not.toHaveBeenCalled();
  });

  it("accepts every version the hub would publish, and only those", async () => {
    // Same rule on both ends: whatever release.mjs ships, the hub can vouch for, and vice versa.
    const versions = fc.oneof(
      fc.tuple(fc.nat(999), fc.nat(999), fc.nat(999)).map((p) => p.join(".")),
      fc.constantFrom(
        "1.2",
        "v1.2.3",
        "1.2.3-rc.1",
        "1.2.3.4",
        " 1.2.3",
        "1.2.3\n"
      )
    );
    await fc.assert(
      fc.asyncProperty(versions, async (v) => {
        const r = await run(
          layout({ version: v }, { [zipName(v)]: bytesOf(v) })
        );
        const hub = hubRelease({
          BUSY_APP_SHA256: "a".repeat(64),
          BUSY_APP_VERSION: v,
        });
        expect(r.error === undefined).toBe(hub !== null && hub.version === v);
      }),
      { numRuns: 30, seed: 7 }
    );
  });
});

describe("the zip it picks", () => {
  it.each([
    [
      "only older builds are in dist",
      { [zipName("0.2.0")]: bytesOf("a"), [zipName("0.1.0")]: bytesOf("b") },
    ],
    [
      "only the blockmap was kept",
      { [`${zipName("0.3.0")}.blockmap`]: bytesOf("map") },
    ],
    [
      "only an Intel build exists",
      { "Busy-0.3.0-x64-mac.zip": bytesOf("x64") },
    ],
    [
      "only a universal build exists",
      { "Busy-0.3.0-universal-mac.zip": bytesOf("u") },
    ],
    [
      "the build has a different product name",
      { "Busy Beta-0.3.0-arm64-mac.zip": bytesOf("beta") },
    ],
    ["dist is empty", {}],
  ])("refuses to release 0.3.0 when %s", async (_label, dist) => {
    const r = await run(layout({ version: "0.3.0" }, dist));
    expect(r.error?.message).toBe(
      "no dist/Busy-0.3.0-arm64-mac.zip; run pnpm dist first"
    );
    expect(r.put).not.toHaveBeenCalled();
  });

  it("refuses when the zip sits next to package.json instead of in dist/", async () => {
    const root = layout({ version: "0.3.0" });
    writeFileSync(join(root, zipName("0.3.0")), "zip");
    const r = await run(root);
    expect(r.error?.message).toContain("run pnpm dist first");
    expect(r.put).not.toHaveBeenCalled();
  });

  it("uploads the build of exactly that version when several are in dist", async () => {
    const dist = {
      [zipName("0.1.0")]: bytesOf("build 0.1.0"),
      [zipName("0.2.0")]: bytesOf("build 0.2.0"),
      [zipName("0.3.0")]: bytesOf("build 0.3.0"),
      [zipName("10.2.0")]: bytesOf("build 10.2.0"),
      [`${zipName("0.2.0")}.blockmap`]: bytesOf("blockmap"),
    };
    const r = await run(layout({ version: "0.2.0" }, dist));
    expect(Buffer.from(present(r.body)).toString()).toBe("build 0.2.0");
    expect(r.out).toContain(`released dist/${zipName("0.2.0")} →`);
  });
});

describe("the hash it prints", () => {
  const random = new Uint8Array(3 * 1024 * 1024);
  let seed = 42;
  for (let i = 0; i < random.length; i += 1) {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 32;
    random[i] = Math.floor(seed / 2 ** 24);
  }

  it.each([
    ["an empty file", new Uint8Array()],
    ["a single byte", new Uint8Array([0x50])],
    [
      "every byte value (not valid UTF-8)",
      Uint8Array.from({ length: 256 }, (_, i) => i),
    ],
    ["CRLF line endings", bytesOf("PK\r\n\r\nzip\r\n")],
    ["a 3 MB body", random],
  ])("is the SHA-256 of the bytes uploaded, for %s", async (_label, zip) => {
    const r = await run(
      layout({ version: "0.2.0" }, { [zipName("0.2.0")]: zip })
    );
    expect(Buffer.compare(present(r.body), zip)).toBe(0);
    expect(r.sha256).toBe(sha(zip));
  });

  it("is the SHA-256 of the uploaded bytes for any content", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 2048 }), async (zip) => {
        const r = await run(
          layout({ version: "0.2.0" }, { [zipName("0.2.0")]: zip })
        );
        expect(Buffer.compare(present(r.body), zip)).toBe(0);
        expect(r.sha256).toBe(sha(zip));
      }),
      { numRuns: 20, seed: 9 }
    );
  });

  it("is of the bytes uploaded even if the file changes during the upload", async () => {
    const root = layout(
      { version: "0.2.0" },
      { [zipName("0.2.0")]: bytesOf("first build") }
    );
    const r = await run(root, (pathname, _body) => {
      writeFileSync(join(root, "dist", zipName("0.2.0")), "rebuilt meanwhile");
      return Promise.resolve({ pathname, url: "" });
    });
    expect(Buffer.from(present(r.body)).toString()).toBe("first build");
    expect(r.sha256).toBe(sha(bytesOf("first build")));
  });

  it("is what the hub accepts as BUSY_APP_SHA256, and the version as BUSY_APP_VERSION", async () => {
    const zip = bytesOf("zip for the hub");
    const r = await run(
      layout({ version: "1.4.2" }, { [zipName("1.4.2")]: zip })
    );
    expect(
      hubRelease({ BUSY_APP_SHA256: r.sha256, BUSY_APP_VERSION: r.version })
    ).toEqual({ sha256: sha(zip), version: "1.4.2" });
  });

  it("puts the same version and hash in the commands it tells you to run", async () => {
    const zip = bytesOf("zip");
    const r = await run(
      layout({ version: "1.4.2" }, { [zipName("1.4.2")]: zip })
    );
    expect(r.out).toContain(
      "vercel env add BUSY_APP_VERSION production --value 1.4.2 "
    );
    expect(r.out).toContain(
      `vercel env add BUSY_APP_SHA256 production --value ${sha(zip)} `
    );
  });

  it("points the commands at the hub app", async () => {
    const r = await run(
      layout({ version: "0.2.0" }, { [zipName("0.2.0")]: bytesOf("zip") })
    );
    const dirs = [...r.out.matchAll(/--cwd '(?<cwd>[^']+)'/gu)].map(
      (m) => m.groups?.cwd ?? ""
    );
    expect(dirs).toHaveLength(3);
    for (const d of dirs) {
      expect(d).toBe(HUB_DIR);
    }
    expect(
      JSON.parse(readFileSync(join(HUB_DIR, "package.json"), "utf8"))
        .dependencies
    ).toHaveProperty("next");
  });
});

describe("the upload", () => {
  it("goes to the fixed path the hub's /api/download serves", async () => {
    const route = readFileSync(DOWNLOAD_ROUTE, "utf8");
    // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
    const served = /RELEASE_PATH = "(?<path>[^"]+)"/u.exec(route)?.groups?.path;
    const r = await run(
      layout({ version: "0.2.0" }, { [zipName("0.2.0")]: bytesOf("zip") })
    );
    expect(r.put.mock.calls[0]?.[0]).toBe(served);
    // A random suffix would move it; refusing to overwrite would fail every release after the first.
    expect(r.options).toMatchObject({
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  });

  it("stays private (the hub hands out short-lived signed URLs)", async () => {
    const r = await run(
      layout({ version: "0.2.0" }, { [zipName("0.2.0")]: bytesOf("zip") })
    );
    expect(r.options).toMatchObject({
      access: "private",
      contentType: "application/zip",
    });
  });

  it("never puts the hash next to the zip in Blob", async () => {
    const zip = bytesOf("zip");
    const r = await run(
      layout({ version: "0.2.0" }, { [zipName("0.2.0")]: zip })
    );
    expect(r.put).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(r.options)).not.toContain(sha(zip));
  });

  it.each([
    ["a missing token", new Error("Vercel Blob: No token found.")],
    ["a network error", new TypeError("fetch failed")],
  ])("fails without printing a hash to publish on %s", async (_label, err) => {
    const r = await run(
      layout({ version: "0.2.0" }, { [zipName("0.2.0")]: bytesOf("zip") }),
      () => {
        throw err;
      }
    );
    expect(r.error).toBe(err);
    expect(r.out).toBe("");
  });
});

// The script for real, under node, from a temp cwd: a resolve hook maps @vercel/blob to a fake `put`
// that writes what it was given into the temp dir.
describe("run with node", () => {
  const home = mkdtempSync(join(tmpdir(), "busy-release-node-"));
  roots.push(home);
  const fakeBlob = join(home, "fake-blob.mjs");
  writeFileSync(
    fakeBlob,
    `import { writeFileSync } from "node:fs"
export async function put(pathname, body, options) {
  writeFileSync(process.env.FAKE_BLOB_OUT, body)
  writeFileSync(process.env.FAKE_BLOB_OUT + ".json", JSON.stringify({ pathname, options }))
  return { pathname, url: "" }
}
`
  );
  const hooks = join(home, "hooks.mjs");
  writeFileSync(
    hooks,
    `import { registerHooks } from "node:module"
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@vercel/blob") return { url: ${JSON.stringify(pathToFileURL(fakeBlob).href)}, shortCircuit: true }
    return next(specifier, context)
  },
})
`
  );

  const node = (root: string) => {
    const out = join(root, "uploaded.bin");
    const r = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(hooks).href, SCRIPT],
      {
        cwd: root,
        encoding: "utf8",
        env: { FAKE_BLOB_OUT: out, HOME: root, PATH: process.env.PATH },
        timeout: 10_000,
      }
    );
    return { ...r, out };
  };

  it("uploads the zip and prints its hash", () => {
    const zip = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7) % 256);
    const root = layout({ version: "0.4.1" }, { [zipName("0.4.1")]: zip });
    const r = node(root);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(new Uint8Array(readFileSync(r.out))).toEqual(zip);
    expect(r.stdout).toMatch(new RegExp(`^sha256\\s+${sha(zip)}$`, "mu"));
    expect(JSON.parse(readFileSync(`${r.out}.json`, "utf8")).pathname).toBe(
      "releases/Busy-mac-arm64.zip"
    );
  });

  it("exits non-zero on a bad version without uploading", () => {
    const r = node(
      layout(
        { version: "0.4.1-beta" },
        { [zipName("0.4.1-beta")]: bytesOf("zip") }
      )
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(
      'package.json version must be x.y.z, got "0.4.1-beta"'
    );
    expect(existsSync(r.out)).toBe(false);
  });

  it("exits non-zero when the build is missing, without uploading", () => {
    const r = node(
      layout({ version: "0.4.1" }, { [zipName("0.4.0")]: bytesOf("zip") })
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(
      "no dist/Busy-0.4.1-arm64-mac.zip; run pnpm dist first"
    );
    expect(existsSync(r.out)).toBe(false);
  });
});
