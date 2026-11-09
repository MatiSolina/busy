import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, it as test } from "vitest";
import { makeBundle } from "./update.fixture";
import { isNewer, UPDATER_SCRIPT } from "./update.mjs";

describe("isNewer cases", () => {
  it.each([
    {
      a: "2.0.0",
      b: "1.0.0",
      label: "a higher major alone is newer",
      newer: true,
    },
    {
      a: "1.0.0",
      b: "2.0.0",
      label: "a lower major alone is not newer",
      newer: false,
    },
    {
      a: "1.0.0",
      b: "1.0.1",
      label: "a lower patch alone is not newer",
      newer: false,
    },
    {
      a: "1.2.0",
      b: "1.1.9",
      label: "a minor bump outranks a lower patch",
      newer: true,
    },
    {
      a: "1.1.9",
      b: "1.2.0",
      label: "a lower minor loses despite a higher patch",
      newer: false,
    },
    {
      a: "1.9.9",
      b: "2.0.0",
      label: "a lower major loses despite higher minor and patch",
      newer: false,
    },
    {
      a: "0.0.10",
      b: "0.0.9",
      label: "a two-digit patch beats a one-digit one",
      newer: true,
    },
    {
      a: "10.0.0",
      b: "9.9.9",
      label: "a two-digit major beats a one-digit one",
      newer: true,
    },
    {
      a: "0.0.9",
      b: "0.0.10",
      label: "a one-digit patch does not beat a two-digit one",
      newer: false,
    },
    {
      a: "0.0.1",
      b: "0.0.0",
      label: "the first release after 0.0.0 is newer",
      newer: true,
    },
    {
      a: "999.999.999",
      b: "999.999.998",
      label: "three-digit components compare by value",
      newer: true,
    },
    {
      a: "9007199254740991.0.0",
      b: "9007199254740990.0.0",
      label: "the largest exact integer component still compares",
      newer: true,
    },
    // Ambiguous: semver forbids leading zeros, but the regex accepts them and compares by value.
    {
      a: "01.0.0",
      b: "1.0.0",
      label: "a leading zero compares by value (01 equals 1)",
      newer: false,
    },
    {
      a: "1.0.010",
      b: "1.0.9",
      label: "a leading-zero patch compares as a number, not as text",
      newer: true,
    },
  ])("$label", ({ a, b, newer }) => {
    expect(isNewer(a, b)).toBe(newer);
  });

  it.each([
    { a: "9.0.0-rc.1", label: "a prerelease, even with a higher core" },
    { a: "9.0.0+build.5", label: "build metadata" },
    { a: "9.0.0.0", label: "four components" },
    { a: " 9.0.0", label: "a leading space" },
    { a: "9..0", label: "an empty component" },
    { a: "9.-1.0", label: "a negative component" },
    { a: "1e1.0.0", label: "exponent notation" },
    { a: "0x9.0.0", label: "a hex component" },
    { a: "9.0.0.", label: "a trailing dot" },
    { a: "９.０.０", label: "fullwidth digits" },
    { a: "٩.٠.٠", label: "Arabic-Indic digits" },
    { a: "9.x.0", label: "an x wildcard" },
    // biome-ignore lint/style/useConsistentBuiltinInstantiation: this deliberately constructs a boxed string to test rejection
    { a: new String("9.0.0"), label: "a String object" },
    { a: ["9", "0", "0"], label: "an array of parts" },
    {
      a: { toString: () => "9.0.0" },
      label: "an object whose toString is a version",
    },
  ])("never treats $label as newer", ({ a }) => {
    expect(isNewer(a, "0.1.0")).toBe(false);
  });

  // Ambiguous: the doc only says what counts as newer; an unparseable current version
  // (a dev or prerelease build) is treated as "never update", which is the safe reading.
  it.each([
    { b: undefined, label: "missing" },
    { b: "0.1.0-beta", label: "a prerelease" },
    { b: "", label: "an empty string" },
  ])("offers no update when the current version is $label", ({ b }) => {
    expect(isNewer("9.0.0", b)).toBe(false);
  });

  it("is false when neither side parses", () => {
    expect(isNewer("latest", "dev")).toBe(false);
  });

  // Fixed bug: components above 2^53 lose precision in Number(): "9007199254740993.0.0" vs
  // "9007199254740992.0.0" → false (both become 9007199254740992) → expected true.
  // Theoretical for app versions, but the regex accepts any digit count.
  it("compares components beyond 2^53 exactly", () => {
    expect(isNewer("9007199254740993.0.0", "9007199254740992.0.0")).toBe(true);
  });
});

const partArb = fc.oneof(fc.nat(3), fc.nat(1000));
const versionArb = fc.tuple(partArb, partArb, partArb).map((p) => p.join("."));
const present = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Expected a present test value");
  }
  return value;
};
const partsOf = (v: string) => v.split(".").map(Number);
const compare = (a: string, b: string) => {
  const [x, y] = [partsOf(a), partsOf(b)];
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) {
      return present(x[i]) - present(y[i]);
    }
  }
  return 0;
};

describe("isNewer properties", () => {
  it("is irreflexive", () => {
    fc.assert(
      fc.property(versionArb, (v) => {
        expect(isNewer(v, v)).toBe(false);
      }),
      { numRuns: 300, seed: 1 }
    );
  });

  it("is asymmetric", () => {
    fc.assert(
      fc.property(versionArb, versionArb, (a, b) => {
        expect(isNewer(a, b) && isNewer(b, a)).toBe(false);
      }),
      { numRuns: 500, seed: 1 }
    );
  });

  it("is transitive", () => {
    let chains = 0;
    fc.assert(
      fc.property(versionArb, versionArb, versionArb, (a, b, c) => {
        if (!(isNewer(a, b) && isNewer(b, c))) {
          return;
        }
        chains += 1;
        expect(isNewer(a, c)).toBe(true);
      }),
      { numRuns: 1000, seed: 1 }
    );
    expect(chains).toBeGreaterThan(50);
  });

  it("orders any two different canonical versions one way or the other", () => {
    fc.assert(
      fc.property(versionArb, versionArb, (a, b) => {
        expect(
          Number(isNewer(a, b)) + Number(isNewer(b, a)) + Number(a === b)
        ).toBe(1);
      }),
      { numRuns: 500, seed: 1 }
    );
  });

  it("follows the numeric (major, minor, patch) order, not string order", () => {
    fc.assert(
      fc.property(versionArb, versionArb, (a, b) => {
        expect(isNewer(a, b)).toBe(compare(a, b) > 0);
      }),
      { numRuns: 500, seed: 1 }
    );
  });

  it("treats any major, minor or patch bump as newer", () => {
    fc.assert(
      fc.property(
        versionArb,
        fc.constantFrom(0, 1, 2),
        fc.integer({ max: 50, min: 1 }),
        (v, i, by) => {
          const parts = partsOf(v);
          const bumped = parts
            .map((p, j) => {
              if (j < i) {
                return p;
              }
              if (j === i) {
                return p + by;
              }
              return 0;
            })
            .join(".");
          expect(isNewer(bumped, v)).toBe(true);
          expect(isNewer(v, bumped)).toBe(false);
        }
      ),
      { numRuns: 300, seed: 1 }
    );
  });

  it("never lets an unparseable value win or lose against a real version", () => {
    const invalidArb = fc.oneof(
      fc.anything().filter((x) => typeof x !== "string"),
      // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
      fc.string().filter((s) => !/^\d+\.\d+\.\d+$/u.test(s)),
      versionArb.chain((v) =>
        fc.constantFrom(
          `v${v}`,
          `${v}-rc.1`,
          `${v}+b.1`,
          ` ${v}`,
          `${v}.0`,
          `${v}\n`
        )
      )
    );
    fc.assert(
      fc.property(invalidArb, versionArb, (bad, v) => {
        expect(isNewer(bad, v)).toBe(false);
        expect(isNewer(v, bad)).toBe(false);
      }),
      { numRuns: 500, seed: 1 }
    );
  });
});

const CASE_WORD_RE = /^(?<indent>\s*)case \$[A-Za-z_]+ in/u;
const MOVE_RE = /\bmv (?<args>[^\n|&;]+)/gu;
const FORCE_FLAG_RE = /^-f /u;

describe("UPDATER_SCRIPT static shape", () => {
  it("quotes every variable it expands, except as a case word (which sh never splits)", () => {
    const body = UPDATER_SCRIPT.split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .map((l) => l.replace(CASE_WORD_RE, "$1case x in"))
      .join("\n")
      .replace(/"[^"]*"/gu, '""')
      // The perl program's own $ARGV.
      .replace(/'[^']*'/gu, "''");
    // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
    expect(body).not.toMatch(/\$[A-Za-z_{]/u);
  });

  it("only ever deletes the temp dir, the .new/.old siblings and its own lock and journal", () => {
    const targets = [
      ...UPDATER_SCRIPT.matchAll(/rm -r?f (?<targets>[^\n]+)/gu),
    ].flatMap((m) => m.groups?.targets?.split(" "));
    expect(new Set(targets)).toEqual(
      new Set([
        '"$APP.new"',
        '"$APP.old"',
        '"$TMP"',
        '"$STATE/lock"',
        '"$STATE/journal"',
      ])
    );
  });

  it("only ever renames the bundle, its .new/.old siblings and the journal", () => {
    const moves = [...UPDATER_SCRIPT.matchAll(MOVE_RE)]
      .flatMap((m) => m.groups?.args?.replace(FORCE_FLAG_RE, "").split(" "))
      .filter(Boolean);
    expect(new Set(moves)).toEqual(
      new Set([
        '"$APP"',
        '"$APP.new"',
        '"$APP.old"',
        '"$STATE/journal.tmp"',
        '"$STATE/journal"',
        '"$STATE/journal.invalid"',
      ])
    );
  });
});

// Real runs are slow (each spawns several processes), so each scenario runs once and its
// tests assert different outcomes of that run.
const roots: string[] = [];
const pids: number[] = [];
afterAll(() => {
  for (const r of roots) {
    rmSync(r, { force: true, recursive: true });
  }
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {
      // The process may already have exited.
    }
  }
});

/** A throwaway installed bundle and downloaded update; `open` is stubbed so nothing launches. */
function setup(appPath = "Busy.app", tmpPath = "update") {
  const root = mkdtempSync(join(tmpdir(), "busy-swap-cases-"));
  roots.push(root);
  const app = join(root, appPath);
  const tmp = join(root, tmpPath);
  makeBundle(app, { build: "old", version: "0.2.0" });
  makeBundle(join(tmp, "new", "Busy.app"), { build: "new", version: "0.3.0" });
  const state = join(root, "state");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("open", `echo "$1" > "${root}/opened"`);
  // The real ditto, noting whether the old app was still alive when the copy began.
  stub(
    "ditto",
    `kill -0 "$BUSY_TEST_APP_PID" 2>/dev/null && : > "${root}/copied-while-running"\nexec /usr/bin/ditto "$@"`
  );
  // Only the wait loop sleeps: the old app quits once the script is waiting for it.
  stub(
    "sleep",
    `: > "${root}/waited"\nkill "$BUSY_TEST_APP_PID" 2>/dev/null\nexec /bin/sleep 0.05`
  );
  const read = (p: string) =>
    existsSync(p) ? readFileSync(p, "utf8").trim() : null;
  return {
    app,
    gonePid: String(spawnSync("true").pid),
    newApp: join(tmp, "new", "Busy.app"),
    opened: () => read(join(root, "opened")),
    root,
    run: (args: string[], env: Record<string, string> = {}) =>
      spawnSync("/bin/sh", ["-c", UPDATER_SCRIPT, "busy-update", ...args], {
        env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}` },
        stdio: "pipe",
        timeout: 5000,
      }),
    runAsync: (args: string[], env: Record<string, string> = {}) =>
      new Promise<{ signal: NodeJS.Signals | null; status: number | null }>(
        (resolve, reject) => {
          const child = spawn(
            "/bin/sh",
            ["-c", UPDATER_SCRIPT, "busy-update", ...args],
            {
              env: {
                ...process.env,
                ...env,
                PATH: `${bin}:${process.env.PATH}`,
              },
              stdio: "ignore",
            }
          );
          // Preserve the original failure bound while allowing Node to reap its child.
          const timeout = setTimeout(() => {
            child.kill("SIGKILL");
          }, 5000);
          child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          child.once("close", (status, signal) => {
            clearTimeout(timeout);
            resolve({ signal, status });
          });
        }
      ),
    state,
    tmp,
    version: () => read(join(app, "Contents", "MacOS", "Busy")),
  };
}

describe.runIf(process.platform === "darwin")(
  "UPDATER_SCRIPT after an interrupted run, on a path with spaces, while the app quits",
  () => {
    let s: ReturnType<typeof setup>;
    let status: number | null;
    beforeAll(async () => {
      s = setup("My Apps/Mati's Busy.app", "update dir/x y");
      mkdirSync(`${s.app}.new`);
      writeFileSync(join(`${s.app}.new`, "stale"), "x");
      mkdirSync(`${s.app}.old`);
      // Keep the running app as a direct Node child. The async shell run lets Node reap it
      // after the stubbed sleep sends SIGTERM; an orphaned shell child can remain a zombie
      // under load and make UPDATER_SCRIPT's kill -0 loop exceed its test timeout.
      const appProcess = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
      if (!appProcess.pid) {
        throw new Error("Expected a running app process");
      }
      const pid = String(appProcess.pid);
      pids.push(appProcess.pid);
      const result = await s.runAsync(
        ["swap", pid, s.newApp, s.app, s.tmp, "0.3.0", s.state],
        {
          BUSY_TEST_APP_PID: pid,
        }
      );
      ({ status } = result);
    });

    test("waits for the running app to exit before copying", () => {
      expect(status).toBe(0);
      expect(existsSync(join(s.root, "waited"))).toBe(true);
      expect(existsSync(join(s.root, "copied-while-running"))).toBe(false);
    });

    test("installs the new bundle at a path with spaces and an apostrophe, and relaunches it", () => {
      expect(s.version()).toBe("new");
      expect(s.opened()).toBe(s.app);
    });

    test("does not merge stale .new contents into the installed bundle", () => {
      expect(existsSync(join(s.app, "stale"))).toBe(false);
    });

    test("keeps only the backup until the new build confirms, then leaves no .new, .old or temp dir behind", () => {
      expect(existsSync(`${s.app}.new`) || existsSync(s.tmp)).toBe(false);
      expect(
        readFileSync(join(`${s.app}.old`, "Contents", "MacOS", "Busy"), "utf8")
      ).toBe("old");
      expect(
        s.run(["recover", s.state, s.app, "0.3.0"]).stdout.toString()
      ).toBe("installed\n");
      expect(existsSync(`${s.app}.new`) || existsSync(`${s.app}.old`)).toBe(
        false
      );
    });
  }
);

describe.runIf(process.platform === "darwin")(
  "UPDATER_SCRIPT when the copy fails",
  () => {
    let s: ReturnType<typeof setup>;
    beforeAll(() => {
      s = setup();
      s.run([
        "swap",
        s.gonePid,
        join(s.tmp, "missing", "Busy.app"),
        s.app,
        s.tmp,
        "0.3.0",
        s.state,
      ]);
    });

    test("still removes the temp dir", () => {
      expect(existsSync(s.tmp)).toBe(false);
    });

    test("never moves the installed bundle aside", () => {
      expect(s.version()).toBe("old");
      expect(existsSync(`${s.app}.old`)).toBe(false);
    });
  }
);

describe.runIf(process.platform === "darwin")(
  "UPDATER_SCRIPT with a missing argument",
  () => {
    test("exits before touching anything", () => {
      const s = setup();
      const r = s.run(["swap", s.gonePid, s.newApp, s.app, s.tmp, "0.3.0"]);
      expect(r.status).not.toBe(0);
      expect(s.version()).toBe("old");
      expect(existsSync(s.tmp)).toBe(true);
      expect(s.opened()).toBeNull();
    });
  }
);
