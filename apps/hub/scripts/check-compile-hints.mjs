import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const chunks = new URL("../.next/static/chunks/", import.meta.url);
const javascript = /\.m?js$/u;
const files = (await readdir(chunks, { recursive: true })).filter(
  (name) => javascript.test(name) && !name.startsWith("polyfills-")
);
if (files.length === 0) {
  throw new Error("The production build has no browser JavaScript chunks");
}
const missing = (
  await Promise.all(
    files.map(async (name) => {
      const source = await readFile(new URL(name, chunks), "utf8");
      return source.startsWith("//# allFunctionsCalledOnLoad\n") ? null : name;
    })
  )
).filter(Boolean);
if (missing.length > 0) {
  throw new Error(`Missing browser compile hints: ${missing.join(", ")}`);
}
console.log(
  `Verified compile hints in ${files.length} production chunks (${fileURLToPath(chunks)})`
);
