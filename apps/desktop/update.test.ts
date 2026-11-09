import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeBundle, toolsBin } from "./update.fixture";
import { isNewer, UPDATER_SCRIPT } from "./update.mjs";

describe("isNewer", () => {
  it("compares x.y.z numerically", () => {
    expect(isNewer("0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.1.1", "0.1.0")).toBe(true);
  });

  it("is false for the same or an older version", () => {
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "0.2.0")).toBe(false);
    expect(isNewer("0.9.9", "0.10.0")).toBe(false);
  });

  it("never treats garbage as newer", () => {
    for (const v of [
      undefined,
      null,
      1,
      "",
      "v1.0.0",
      "1.0",
      "1.0.0-beta",
      "1.0.0\n",
    ]) {
      expect(isNewer(v, "0.1.0")).toBe(false);
    }
  });
});

describe("UPDATER_SCRIPT", () => {
  let root = "";
  afterEach(() => rmSync(root, { force: true, recursive: true }));

  // A real swap against throwaway bundles, then the new build's startup confirmation; `open` is a shell
  // function, so nothing launches.
  function update(newApp: (tmp: string) => string) {
    root = mkdtempSync(join(tmpdir(), "busy-swap-test-"));
    const app = join(root, "Busy.app");
    const tmp = join(root, "update");
    const state = join(root, "state");
    makeBundle(app, { build: "old", version: "0.2.0" });
    makeBundle(join(tmp, "new", "Busy.app"), {
      build: "new",
      version: "0.3.0",
    });
    const bin = toolsBin(join(root, "bin"));
    const sh = (args: string[]) =>
      spawnSync(
        "/bin/sh",
        [
          "-c",
          `open() { printf '%s' "$1" > "$OPENED"; }\n${UPDATER_SCRIPT}`,
          "busy-update",
          ...args,
        ],
        {
          encoding: "utf8",
          env: { OPENED: join(root, "opened"), PATH: bin },
          timeout: 10_000,
        }
      );
    const gone = String(spawnSync("true").pid);
    const swapped = sh(["swap", gone, newApp(tmp), app, tmp, "0.3.0", state]);
    const build = () =>
      readFileSync(join(app, "Contents", "MacOS", "Busy"), "utf8");
    const backupKept = existsSync(`${app}.old`);
    const confirmed = sh([
      "recover",
      state,
      app,
      build() === "new" ? "0.3.0" : "0.2.0",
    ]);
    return {
      app,
      backupKept,
      build: build(),
      confirmed: confirmed.stdout,
      opened: readFileSync(join(root, "opened"), "utf8"),
      status: swapped.status,
      tmp,
    };
  }

  // biome-ignore lint/suspicious/useExpect: sh -n communicates the assertion via its exit status
  it("is valid sh", () => {
    execFileSync("sh", ["-n"], { input: UPDATER_SCRIPT });
  });

  it.runIf(process.platform === "darwin")(
    "replaces the bundle, keeps the backup until the new build confirms, then cleans up",
    () => {
      const r = update((tmp) => join(tmp, "new", "Busy.app"));
      // biome-ignore lint/suspicious/noMisplacedAssertion: update() is a test helper invoked by this case
      expect(r).toMatchObject({
        backupKept: true,
        build: "new",
        confirmed: "installed\n",
        status: 0,
      });
      // biome-ignore lint/suspicious/noMisplacedAssertion: update() is a test helper invoked by this case
      expect(r.opened).toBe(r.app);
      // biome-ignore lint/suspicious/noMisplacedAssertion: update() is a test helper invoked by this case
      expect(existsSync(r.tmp)).toBe(false);
      // biome-ignore lint/suspicious/noMisplacedAssertion: update() is a test helper invoked by this case
      expect(existsSync(`${r.app}.old`) || existsSync(`${r.app}.new`)).toBe(
        false
      );
    }
  );

  it.runIf(process.platform === "darwin")(
    "keeps the old app when the update is missing, and reports it",
    () => {
      const r = update((tmp) => join(tmp, "missing", "Busy.app"));
      // biome-ignore lint/suspicious/noMisplacedAssertion: update() is a test helper invoked by this case
      expect(r.build).toBe("old");
      // biome-ignore lint/suspicious/noMisplacedAssertion: update() is a test helper invoked by this case
      expect(r.opened).toBe(r.app);
      // biome-ignore lint/suspicious/noMisplacedAssertion: update() is a test helper invoked by this case
      expect(
        r.confirmed.startsWith("failed\nThe download doesn't contain")
      ).toBe(true);
      // biome-ignore lint/suspicious/noMisplacedAssertion: update() is a test helper invoked by this case
      expect(existsSync(`${r.app}.new`)).toBe(false);
    }
  );
});
