import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const entries = [
  "apps/hub/.next/server/app/api/bots/route.js",
  "apps/hub/.next/server/app/api/bots/[slug]/route.js",
];

// Use only Next's traced files, as a deployment does. The source node_modules
// would otherwise hide dependencies that the production trace has excluded.
const traces = await Promise.all(
  entries.map(async (entry) => {
    const source = path.join(root, entry);
    const trace = JSON.parse(await readFile(`${source}.nft.json`, "utf8"));
    return [
      source,
      ...trace.files.map((file) => path.resolve(path.dirname(source), file)),
    ];
  })
);
const files = new Set(traces.flat());

const stage = await mkdtemp(path.join(tmpdir(), "busy-server-runtime-"));
try {
  for (const source of files) {
    const destination = path.join(stage, path.relative(root, source));
    mkdirSync(path.dirname(destination), { recursive: true });
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(source), destination);
    } else if (stat.isFile()) {
      copyFileSync(source, destination);
    }
  }

  await Promise.all(
    entries.map(async (entry) => {
      const loadedRoute = await import(
        pathToFileURL(path.join(stage, entry)).href
      );
      // Next loads route dependencies lazily; importing the shell is insufficient.
      await loadedRoute.default.routeModule.ensureUserland();
      if (entry === entries[0]) {
        const response = await loadedRoute.default.routeModule.userland.POST(
          new Request("http://busy.test/api/bots", {
            body: "{}",
            headers: { "Content-Type": "application/json" },
            method: "POST",
          })
        );
        if (response.status !== 400) {
          throw new Error(
            `Bot creation validation returned ${response.status}`
          );
        }
      }
      console.log(`Runtime OK: ${entry}`);
    })
  );
} finally {
  await rm(stage, { force: true, recursive: true });
}
