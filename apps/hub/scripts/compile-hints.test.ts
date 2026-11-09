import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it as test } from "vitest";
import { browserCompileHints } from "./compile-hints";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack");
const JAVASCRIPT = /\.js$/u;
const SOURCE_MAP = /\n\/\/# sourceMappingURL=.*$/u;

function build(
  context: string,
  output: string,
  hinted: boolean
): Promise<void> {
  const compiler = webpack({
    context,
    devtool: "source-map",
    entry: "./entry.js",
    mode: "production",
    name: "browser-hints-fixture",
    optimization: { minimize: false },
    output: {
      chunkFilename: "[id].[contenthash].js",
      filename: "main.[contenthash].js",
      path: output,
    },
    plugins: [
      ...(hinted
        ? browserCompileHints({ dev: false, isServer: false, webpack })
        : []),
    ],
    target: "web",
  });
  return new Promise((resolve, reject) => {
    compiler.run(
      (
        error: Error | null,
        stats: { hasErrors: () => boolean; toString: () => string }
      ) => {
        compiler.close((closeError: Error | null) => {
          if (error || closeError) {
            reject(error || closeError);
          } else if (stats.hasErrors()) {
            reject(new Error(stats.toString()));
          } else {
            resolve();
          }
        });
      }
    );
  });
}

test.each([
  { dev: true, isServer: false },
  { dev: false, isServer: true },
])("does not change development or server assets ($dev/$isServer)", (mode) => {
  expect(browserCompileHints({ ...mode, webpack })).toEqual([]);
});

test("preserves source maps and cache invalidation for entry and lazy chunks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "busy-compile-hints-"));
  const plain = join(directory, "plain");
  const hinted = join(directory, "hinted");
  try {
    await writeFile(
      join(directory, "entry.js"),
      'globalThis.load = () => import("./child.js");'
    );
    await writeFile(
      join(directory, "child.js"),
      'export const answer = "synthetic compiler fixture";'
    );
    await build(directory, plain, false);
    await build(directory, hinted, true);
    const plainFiles = (await readdir(plain)).filter((name) =>
      JAVASCRIPT.test(name)
    );
    const hintedFiles = (await readdir(hinted)).filter((name) =>
      JAVASCRIPT.test(name)
    );
    expect(plainFiles).toHaveLength(2);
    expect(hintedFiles).toHaveLength(2);
    expect(hintedFiles.some((name) => plainFiles.includes(name))).toBe(false);
    const outputs = await Promise.all(
      hintedFiles.map(async (name) => ({
        code: await readFile(join(hinted, name), "utf8"),
        map: JSON.parse(
          await readFile(join(hinted, `${name}.map`), "utf8")
        ) as { mappings: string },
      }))
    );
    expect(
      outputs.every(({ code }) =>
        code.startsWith("//# allFunctionsCalledOnLoad\n")
      )
    ).toBe(true);
    expect(outputs.every(({ map }) => map.mappings.startsWith(";"))).toBe(true);
    const plainChild = plainFiles.find((name) => !name.startsWith("main."));
    const hintedChild = hintedFiles.find((name) => !name.startsWith("main."));
    if (!(plainChild && hintedChild)) {
      throw new Error("Missing lazy fixture chunk");
    }
    const plainCode = await readFile(join(plain, plainChild), "utf8");
    const hintedCode = await readFile(join(hinted, hintedChild), "utf8");
    expect(
      hintedCode
        .replace("//# allFunctionsCalledOnLoad\n", "")
        .replace(SOURCE_MAP, "")
    ).toBe(plainCode.replace(SOURCE_MAP, ""));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 20_000);
