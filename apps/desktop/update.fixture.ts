// Throwaway Busy.app bundles and a tool dir for running UPDATER_SCRIPT for real in update*.test.ts and
// main.update.test.ts. Nothing here touches an installed app: every path is under a mkdtemp dir.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXCHANGE_PROGRAM, SYSTEM_PERL } from "./update.mjs";

export const BUSY_ID = "com.matisolina.busy";

/** The Info.plist electron-builder writes, reduced to the keys the updater reads. */
export function infoPlist({
  executable = "Busy",
  id = BUSY_ID,
  version,
}: {
  executable?: string;
  id?: string;
  version: string;
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${executable}</string>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>
`;
}

/**
 * Writes a complete fake Busy.app at `path`: Info.plist, an executable Contents/MacOS/Busy whose content is
 * `build`, and Contents/only-in-<build>.
 */
export function makeBundle(
  path: string,
  { build, version, id }: { build: string; version: string; id?: string }
) {
  mkdirSync(join(path, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    join(path, "Contents", "Info.plist"),
    infoPlist({ id, version })
  );
  writeFileSync(join(path, "Contents", "MacOS", "Busy"), build);
  chmodSync(join(path, "Contents", "MacOS", "Busy"), 0o755);
  writeFileSync(join(path, "Contents", `only-in-${build}`), build);
}

/** The external tools UPDATER_SCRIPT runs; `open` is never among them, so nothing can launch. */
export const UPDATER_TOOLS = [
  "cat",
  "ditto",
  "mkdir",
  "mv",
  "perl",
  "plutil",
  "rm",
  "sleep",
] as const;

/**
 * The script with its pinned perl called by name, so a test's `perl()` shell function can wrap (count, fail or
 * kill after) the exchange; `command perl` inside that function reaches the toolsBin symlink to the same perl.
 */
export const withPerlHook = (script: string) =>
  script.replaceAll(`${SYSTEM_PERL} -e`, "perl -e");

/**
 * Whether the atomic exchange works here: the same perl and program UPDATER_SCRIPT runs, on two dirs in the same
 * temp dir the tests use. Where it doesn't, the updater falls back to two renames (tested either way).
 */
export function exchangeAvailable() {
  const dir = mkdtempSync(join(tmpdir(), "busy-exchange-probe-"));
  try {
    for (const side of ["a", "b"]) {
      mkdirSync(join(dir, side));
      writeFileSync(join(dir, side, "side"), side);
    }
    const r = spawnSync(SYSTEM_PERL, [
      "-e",
      EXCHANGE_PROGRAM,
      "--",
      join(dir, "a"),
      join(dir, "b"),
    ]);
    return (
      r.status === 0 && readFileSync(join(dir, "a", "side"), "utf8") === "b"
    );
  } catch {
    return false;
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

/** A dir of symlinks to the real tools, for a PATH that reaches nothing else. */
export function toolsBin(
  dir: string,
  tools: readonly string[] = UPDATER_TOOLS
) {
  mkdirSync(dir, { recursive: true });
  for (const tool of tools) {
    symlinkSync(
      // The updater pins its perl; a test wrapping it must reach that same one, not whatever PATH finds first.
      tool === "perl"
        ? SYSTEM_PERL
        : execFileSync("/usr/bin/which", [tool]).toString().trim(),
      join(dir, tool)
    );
  }
  return dir;
}
