import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { sandboxName } from "../../../../apps/hub/lib/sandbox-name";

// The eve the bots run: the template pins it, and its dist holds the private naming the hub's
// fallback copies (H-18). Read it from the installed package, not from a copy in this test. It lives
// in the template's suite because only that CI job installs the template's eve.
const template = fileURLToPath(new URL("../../", import.meta.url));
const eveRoot = realpathSync(join(template, "node_modules/eve"));
const pinned = (
  JSON.parse(readFileSync(join(template, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  }
).dependencies.eve;
const installed = (
  JSON.parse(readFileSync(join(eveRoot, "package.json"), "utf8")) as {
    version: string;
  }
).version;
const binding = readFileSync(
  join(eveRoot, "dist/src/execution/sandbox/bindings/vercel.js"),
  "utf8"
);
const NAMING =
  /function vercelSessionName\((?<arg>\w+)\)\{return`(?<prefix>[^`$]*)\$\{createSandboxProviderIdentity\(\{sessionId:\k<arg>,version:(?<version>\d+)\}\)\.slice\(0,(?<length>\d+)\)\}`\}/u;

describe("sandboxName matches the installed eve's vercelSessionName", () => {
  it("runs against the eve the template pins", () => {
    expect(installed).toBe(pinned);
    expect(dirname(eveRoot)).toContain("node_modules");
  });

  it("finds eve's naming in its dist; a change here means updating lib/live.ts's fallback", () => {
    const match = NAMING.exec(binding);
    expect(
      match,
      "eve changed vercelSessionName: update sandboxName in lib/live.ts (bots report the real name, but sessions without a report use this fallback)"
    ).not.toBeNull();
    expect(match?.groups).toMatchObject({
      length: "32",
      prefix: "eve-sbx-vercel-",
      version: "2",
    });
  });

  it.each([
    "4b0f3e0f-2d1c-4c9a-9a52-0c1a3f6f7d10",
    "sess_01JBM1Z2Q3R4S5T6V7W8X9Y0Z1",
  ])("derives eve's exact name for session %s", async (sessionId) => {
    const { createSandboxProviderIdentity } = (await import(
      pathToFileURL(
        join(eveRoot, "dist/src/execution/sandbox/provider-identity.js")
      ).href
    )) as { createSandboxProviderIdentity: (value: unknown) => string };
    const groups = NAMING.exec(binding)?.groups;
    const eveName = `${groups?.prefix}${createSandboxProviderIdentity({
      sessionId,
      version: Number(groups?.version),
    }).slice(0, Number(groups?.length))}`;
    expect(sandboxName(sessionId)).toBe(eveName);
  });
});
