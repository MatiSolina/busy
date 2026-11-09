// UPDATER_SCRIPT run for real with sh against throwaway bundles in a mkdtemp dir. `open` is a shell function and
// PATH only reaches symlinks to the real tools (update.fixture.ts), so nothing can launch. Stubs are functions,
// not new executables: macOS scans every new executable on its first run (~0.4 s each).
// update.cases.test.ts already covers: the wait for the running pid, an apostrophe+space path, stale .new
// contents, a missing NEW, and a missing argument. This file covers the rest of the swap's contract, the
// journal, SIGKILL at every step and the recovery that follows.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, it as test } from "vitest";
import {
  exchangeAvailable,
  infoPlist,
  makeBundle,
  toolsBin,
  withPerlHook,
} from "./update.fixture";
import { UPDATER_SCRIPT } from "./update.mjs";

const base = mkdtempSync(join(tmpdir(), "busy-swap-"));
afterAll(() => {
  // Undo the unreadable fixture so the cleanup can remove it.
  spawnSync("chmod", ["-R", "u+rwX", base]);
  rmSync(base, { force: true, recursive: true });
});

const bin = toolsBin(join(base, "bin"));
// renameatx_np(RENAME_SWAP) through the updater's perl, probed the way the updater runs it. Where it fails the
// updater falls back to two renames, so only the exchange-specific variants are skipped, never the renames ones.
const EXCHANGE = exchangeAvailable();
const SKIP_EXCHANGE =
  "unavailable here (renameatx_np RENAME_SWAP failed), so the exchange-only variants are skipped; the two-rename ones still run";
const OLD = "0.2.0";
const NEW = "0.3.0";

// open logs the path and the bundle it finds there at that moment; mv, ditto and the atomic exchange can be made
// to fail. With KILL_AFTER=n the script SIGKILLs itself right after its n-th successful rename or exchange (the
// journal's own rename included): a real kill of the separate sh process at that exact point.
const FAKES = `
open() { printf '%s\\0%s\\0' "$1" "$(cat "$1/Contents/MacOS/Busy" 2>/dev/null)" >> "$LOG_OPEN"; }
step() {
  [ -n "\${KILL_AFTER:-}" ] || return 0
  _n=$(cat "$STEPS" 2>/dev/null || echo 0)
  _n=$((_n + 1))
  echo "$_n" > "$STEPS"
  [ "$_n" -lt "$KILL_AFTER" ] || kill -KILL $$
}
mv() {
  printf '%s\\0' "$1" >> "$LOG_MV"
  case "|\${FAIL_MV:-}|" in *"|$1|"*) echo "mv: $1: Operation not permitted" >&2; return 1;; esac
  command mv "$@" || return 1
  step
}
perl() {
  printf 'exchange %s\\0' "$4" >> "$LOG_MV"
  [ -z "\${NO_EXCHANGE:-}" ] || return 1
  command perl "$@" || return 1
  step
}
ditto() {
  if [ -n "\${DITTO_PARTIAL:-}" ]; then mkdir -p "$2/Contents" && : > "$2/Contents/half-copied" && : > "$DITTO_PARTIAL"; return 1; fi
  command ditto "$@"
}
sleep() { : > "$SLEPT"; command sleep 0.01; }
`;

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);
const present = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Expected a present test value");
  }
  return value;
};
const pairs = (xs: string[]) =>
  xs.flatMap((x, i) => (i % 2 ? [] : [[x, present(xs[i + 1])]]));
const goneP = () => String(spawnSync("true").pid);

interface Setup {
  app?: string;
  arrange?: (p: Paths) => void;
  /** Run the new build's startup confirmation after the swap (default true). */
  confirm?: boolean;
  dir?: string;
  env?: (p: Paths) => Record<string, string>;
  tmpDir?: string;
}
interface Paths {
  app: string;
  newApp: string;
  root: string;
  state: string;
  tmp: string;
}

function runScript(
  root: string,
  args: string[],
  env: Record<string, string> = {}
) {
  return spawnSync(
    "/bin/sh",
    ["-c", FAKES + withPerlHook(UPDATER_SCRIPT), "busy-update", ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        HOME: root,
        LOG_MV: join(root, "mv.log"),
        LOG_OPEN: join(root, "open.log"),
        PATH: bin,
        SLEPT: join(root, "slept"),
        STEPS: join(root, "steps"),
        ...env,
      },
      timeout: 10_000,
    }
  );
}

/** What is installed at `path`: the build name its executable holds, or null for no complete bundle. */
const buildAt = (path: string) =>
  existsSync(join(path, "Contents", "Info.plist"))
    ? read(join(path, "Contents", "MacOS", "Busy"))
    : null;

/** Lays out an installed bundle (build "old") and an extracted update (build "new"), then runs the swap. */
function swap(name: string, setup: Setup = {}) {
  const root = mkdtempSync(join(base, "case-"));
  const app = join(root, setup.dir ?? "Applications", setup.app ?? "Busy.app");
  const tmp = join(root, setup.tmpDir ?? "busy-update-x1");
  const state = join(root, "state");
  const newApp = join(tmp, "new", "Busy.app");
  makeBundle(app, { build: "old", version: OLD });
  makeBundle(newApp, { build: "new", version: NEW });
  const paths = { app, newApp, root, state, tmp };
  setup.arrange?.(paths);
  const env = setup.env?.(paths) ?? {};
  const r = runScript(
    root,
    ["swap", goneP(), newApp, app, tmp, NEW, state],
    env
  );
  const siblingsAfterSwap = readdirSync(dirname(app)).sort();
  const journalAfterSwap = read(join(state, "journal"));
  const confirmed =
    setup.confirm === false
      ? null
      : runScript(root, [
          "recover",
          state,
          app,
          buildAt(app) === "new" ? NEW : OLD,
        ]).stdout;
  return {
    name,
    ...paths,
    build: () => buildAt(app),
    confirmed,
    has: (file: string) => existsSync(join(app, "Contents", file)),
    journalAfterSwap,
    moved: () =>
      (read(join(root, "mv.log")) ?? "")
        .split("\0")
        .slice(0, -1)
        .filter((m) => m !== "-f"),
    opens: () =>
      pairs((read(join(root, "open.log")) ?? "").split("\0").slice(0, -1)),
    siblings: () => readdirSync(dirname(app)).sort(),
    siblingsAfterSwap,
    signal: r.signal,
    slept: () => existsSync(join(root, "slept")),
    status: r.status,
    stderr: r.stderr,
  };
}

/** Every file under root, relative; for "nothing appeared anywhere" checks. */
function tree(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? [
          `${prefix}${e.name}/`,
          ...tree(join(dir, e.name), `${prefix}${e.name}/`),
        ]
      : [`${prefix}${e.name}`]
  );
}

const NAMES = [
  {
    app: "Busy.app",
    dir: "Applications",
    label: "a plain /Applications-style path",
  },
  {
    app: "Busy App.app",
    dir: "My Apps",
    label: "spaces in the folder and the app",
  },
  {
    app: "Busy (copy).app",
    dir: "Applications",
    label: "parentheses (a Finder copy)",
  },
  { app: 'Busy "beta".app', dir: 'say "hi"', label: "double quotes" },
  { app: "Busy.app", dir: "Mati's", label: "a single quote" },
  {
    app: "Búsy.app",
    dir: "Café Apps ñ 日本語 ✨",
    label: "accents, CJK and emoji",
  },
  { app: "Busy.app", dir: "tab\there", label: "a tab" },
  { app: "Busy.app", dir: "line one\nline two", label: "a newline" },
  { app: "-Busy.app", dir: "-rf", label: "a leading dash" },
  {
    app: "Busy.app",
    dir: "d".repeat(200),
    label: "a 200-character folder name",
  },
  { app: "Busy.app", dir: "`touch pwned`", inject: true, label: "backticks" },
  {
    app: "$(touch pwned).app",
    dir: "$(touch pwned)",
    inject: true,
    label: "command substitution",
  },
  {
    app: "Busy.app",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this fixture intentionally preserves shell placeholders literally
    dir: "$HOME ${PATH} $1",
    inject: true,
    label: "variable references",
  },
  {
    app: "Busy.app",
    dir: "a; touch pwned & b",
    inject: true,
    label: "a semicolon and an ampersand",
  },
  { app: "Busy.app", dir: "x > pwned", inject: true, label: "a redirection" },
];

describe.each(NAMES)(
  "with $label in both paths",
  ({ label, dir, app, inject }) => {
    let r: ReturnType<typeof swap>;
    beforeAll(() => {
      r = swap(label, { app, dir, tmpDir: `${dir} update` });
    });

    test("installs the new build", () => {
      expect(r.stderr).toBe("");
      expect(r.build()).toBe("new");
      expect(r.has("only-in-old")).toBe(false);
    });

    test("relaunches exactly that path once, after the swap", () => {
      expect(r.opens()).toEqual([[r.app, "new"]]);
    });

    test("keeps the previous build as .old until the new build confirms, then only the app is left", () => {
      expect(r.siblingsAfterSwap).toEqual([app, `${app}.old`]);
      expect(r.confirmed).toBe("installed\n");
      expect(r.siblings()).toEqual([app]);
      expect(existsSync(r.tmp)).toBe(false);
    });

    if (inject) {
      test("runs nothing embedded in the path", () => {
        expect(
          tree(r.root).filter((f) => f.split("/").pop() === "pwned")
        ).toEqual([]);
      });
    }
  }
);

describe("what it touches", () => {
  let r: ReturnType<typeof swap>;
  const SIBLINGS = [
    "Busy Beta.app",
    "Busy.app.backup",
    "Busy.apps",
    "Busy.app copy",
    "Other.app",
  ];
  beforeAll(() => {
    r = swap("siblings", {
      arrange: ({ root, app }) => {
        for (const s of SIBLINGS) {
          mkdirSync(join(dirname(app), s));
          writeFileSync(join(dirname(app), s, "keep"), s);
        }
        writeFileSync(join(root, "T", "other-download.zip"), "keep");
      },
      tmpDir: "T/busy-update-x1",
    });
  });

  it.each(SIBLINGS)("leaves %s next to the app alone", (s) => {
    expect(read(join(dirname(r.app), s, "keep"))).toBe(s);
  });

  it("removes only its own temp dir, not the folder that holds it", () => {
    expect(existsSync(r.tmp)).toBe(false);
    expect(read(join(r.root, "T", "other-download.zip"))).toBe("keep");
  });

  it("installs nothing outside the app's own path", () => {
    expect(r.siblings()).toEqual(["Busy.app", ...SIBLINGS].sort());
  });
});

describe("with glob characters in the path", () => {
  let r: ReturnType<typeof swap>;
  // If "$APP.old" were unquoted, x*/Busy.app.old would also match xyz/Busy.app.old.
  beforeAll(() => {
    r = swap("glob", {
      app: "Busy.app",
      arrange: ({ root }) => {
        for (const d of ["xyz/Busy.app.old", "xyz/Busy.app.new", "xa"]) {
          mkdirSync(join(root, d), { recursive: true });
          writeFileSync(join(root, d, "keep"), "x");
        }
      },
      dir: "x*",
      tmpDir: "x?",
    });
  });

  it("installs the new build", () => {
    expect(r.build()).toBe("new");
    expect(r.opens()).toEqual([[r.app, "new"]]);
  });

  it.each(["xyz/Busy.app.old", "xyz/Busy.app.new", "xa"])(
    "doesn't expand the pattern into %s",
    (d) => {
      expect(existsSync(join(r.root, d, "keep"))).toBe(true);
    }
  );
});

describe("when the installed app is a symlink to a bundle elsewhere", () => {
  let r: ReturnType<typeof swap>;
  let target: string;
  beforeAll(() => {
    r = swap("symlinked", {
      arrange: ({ root, app }) => {
        target = join(root, "elsewhere", "Busy.app");
        mkdirSync(join(root, "elsewhere"));
        execFileSync("/bin/mv", [app, target]);
        symlinkSync(target, app);
      },
    });
  });

  it("puts a real bundle with the new build where the link was", () => {
    expect(r.stderr).toBe("");
    expect(r.build()).toBe("new");
    expect(r.siblings()).toEqual(["Busy.app"]);
  });

  it("leaves the link's target untouched", () => {
    expect(read(join(target, "Contents", "MacOS", "Busy"))).toBe("old");
    expect(existsSync(join(target, "Contents", "only-in-old"))).toBe(true);
  });
});

describe("when the app has already quit", () => {
  it("swaps without waiting", () => {
    const r = swap("gone");
    expect(r.slept()).toBe(false);
    expect(r.build()).toBe("new");
  });
});

describe("when copying the new build fails partway", () => {
  let r: ReturnType<typeof swap>;
  beforeAll(() => {
    r = swap("partial copy", {
      env: ({ root }) => ({ DITTO_PARTIAL: join(root, "partial-made") }),
    });
  });

  it("keeps the installed build", () => {
    expect(r.build()).toBe("old");
    expect(r.has("only-in-old")).toBe(true);
  });

  it("never moves the installed app aside", () => {
    expect(r.moved()).toEqual([]);
  });

  it("throws away the half-copied bundle and the temp dir", () => {
    expect(existsSync(join(r.root, "partial-made"))).toBe(true); // the stub did leave a Busy.app.new behind
    expect(r.siblings()).toEqual(["Busy.app"]);
    expect(existsSync(r.tmp)).toBe(false);
  });

  it("relaunches the old build, and the next start reports the failure", () => {
    expect(r.opens()).toEqual([[r.app, "old"]]);
    expect(r.confirmed?.startsWith("failed\nCouldn't copy the update")).toBe(
      true
    );
  });
});

describe("when the new bundle has an unreadable file", () => {
  let r: ReturnType<typeof swap>;
  beforeAll(() => {
    r = swap("unreadable", {
      arrange: ({ newApp }) => {
        writeFileSync(join(newApp, "Contents", "locked"), "x");
        chmodSync(join(newApp, "Contents", "locked"), 0o000);
      },
    });
  });

  it("keeps the installed build", () => {
    expect(r.build()).toBe("old");
    expect(r.has("locked")).toBe(false);
  });

  it("leaves no partial copy next to the app", () => {
    expect(r.siblings()).toEqual(["Busy.app"]);
  });

  it("relaunches the old build", () => {
    expect(r.opens()).toEqual([[r.app, "old"]]);
  });
});

describe("when the new bundle is a dangling symlink", () => {
  let r: ReturnType<typeof swap>;
  beforeAll(() => {
    r = swap("dangling", {
      arrange: ({ newApp }) => {
        rmSync(newApp, { recursive: true });
        symlinkSync(join(dirname(newApp), "nowhere.app"), newApp);
      },
    });
  });

  it("keeps the installed build and relaunches it", () => {
    expect(r.build()).toBe("old");
    expect(r.opens()).toEqual([[r.app, "old"]]);
  });

  it("leaves nothing behind", () => {
    expect(r.siblings()).toEqual(["Busy.app"]);
    expect(existsSync(r.tmp)).toBe(false);
  });
});

// A zip that extracts to something that isn't a complete Busy.app of the published version is never promoted.
describe.each([
  {
    arrange: (p: Paths) => rmSync(join(p.newApp, "Contents", "Info.plist")),
    label: "no Info.plist",
  },
  {
    arrange: (p: Paths) => rmSync(join(p.newApp, "Contents", "MacOS", "Busy")),
    label: "no executable",
  },
  {
    arrange: (p: Paths) =>
      chmodSync(join(p.newApp, "Contents", "MacOS", "Busy"), 0o644),
    label: "an executable without the x bit",
  },
  {
    arrange: (p: Paths) =>
      writeFileSync(
        join(p.newApp, "Contents", "Info.plist"),
        infoPlist({ id: "com.example.other", version: NEW })
      ),
    label: "another app's identifier",
  },
  {
    arrange: (p: Paths) =>
      writeFileSync(
        join(p.newApp, "Contents", "Info.plist"),
        infoPlist({ version: "0.2.9" })
      ),
    label: "a different version than the one published",
  },
  {
    arrange: (p: Paths) =>
      writeFileSync(
        join(p.newApp, "Contents", "Info.plist"),
        infoPlist({ executable: "../../../bin/sh", version: NEW })
      ),
    label: "an executable name that escapes Contents/MacOS",
  },
  {
    arrange: (p: Paths) =>
      writeFileSync(join(p.newApp, "Contents", "Info.plist"), "garbage"),
    label: "an unreadable Info.plist",
  },
])("when the update has $label", ({ arrange }) => {
  let r: ReturnType<typeof swap>;
  beforeAll(() => {
    r = swap("incomplete", { arrange });
  });

  test("keeps the installed build, never moving it", () => {
    expect(r.build()).toBe("old");
    expect(r.moved()).toEqual([]);
  });

  test("leaves nothing next to the app, relaunches it and reports the failure", () => {
    expect(r.siblings()).toEqual(["Busy.app"]);
    expect(r.opens()).toEqual([[r.app, "old"]]);
    expect(
      r.confirmed?.startsWith("failed\nThe download doesn't contain")
    ).toBe(true);
  });
});

// Without the atomic exchange (another file system, no perl) the swap falls back to two renames.
describe.each([
  {
    fail: (p: Paths) => p.app,
    label: "the installed app can't be moved aside",
    moved: (p: Paths) => [`exchange ${p.app}.new`, p.app],
  },
  {
    fail: (p: Paths) => `${p.app}.new`,
    label: "the new build can't be moved into place",
    moved: (p: Paths) => [
      `exchange ${p.app}.new`,
      p.app,
      `${p.app}.new`,
      `${p.app}.old`,
    ],
  },
])("without the exchange, when $label", ({ fail, moved }) => {
  let r: ReturnType<typeof swap>;
  beforeAll(() => {
    r = swap("failing mv", {
      env: (p) => ({ FAIL_MV: fail(p), NO_EXCHANGE: "1" }),
    });
  });

  test("keeps the installed build", () => {
    expect(r.build()).toBe("old");
    expect(r.has("only-in-old")).toBe(true);
  });

  test("moves only what the rollback needs", () => {
    expect(r.moved()).toEqual(moved(r));
  });

  test("leaves no .new or .old and removes the temp dir", () => {
    expect(r.siblings()).toEqual(["Busy.app"]);
    expect(existsSync(r.tmp)).toBe(false);
  });

  test("relaunches the old build", () => {
    expect(r.opens()).toEqual([[r.app, "old"]]);
  });
});

describe("the exchange", () => {
  // Always runs, so the CI log says which variants this machine could check.
  it(`is probed with the updater's own perl and program: ${EXCHANGE ? "available here" : SKIP_EXCHANGE}`, () => {
    expect(typeof EXCHANGE).toBe("boolean");
  });

  it("swaps the bundles in one step when the file system supports it", ({
    skip,
  }) => {
    skip(!EXCHANGE, SKIP_EXCHANGE);
    const r = swap("exchange");
    expect(r.moved()).toEqual([`exchange ${r.app}.new`, `${r.app}.new`]);
    expect(r.build()).toBe("new");
  });

  it("uses the system perl even when PATH finds another one first", ({
    skip,
  }) => {
    skip(!EXCHANGE, SKIP_EXCHANGE);
    const root = mkdtempSync(join(base, "path-perl-"));
    const app = join(root, "Busy.app");
    const tmp = join(root, "tmp");
    makeBundle(app, { build: "old", version: OLD });
    makeBundle(join(tmp, "new", "Busy.app"), { build: "new", version: NEW });
    // A PATH whose `perl` can't do anything (as a perl without syscall() would): the swap must not use it.
    const pathBin = toolsBin(join(root, "bin"), [
      "cat",
      "ditto",
      "mkdir",
      "mv",
      "plutil",
      "rm",
      "sleep",
    ]);
    symlinkSync("/usr/bin/false", join(pathBin, "perl"));
    const r = spawnSync(
      "/bin/sh",
      [
        "-c",
        `open() { :; }\nmv() { printf '%s\\0' "$1" >> "$LOG_MV"; command mv "$@"; }\n${UPDATER_SCRIPT}`,
        "busy-update",
        "swap",
        goneP(),
        join(tmp, "new", "Busy.app"),
        app,
        tmp,
        NEW,
        join(root, "state"),
      ],
      {
        encoding: "utf8",
        env: { LOG_MV: join(root, "mv.log"), PATH: pathBin },
        timeout: 10_000,
      }
    );
    expect(r.status).toBe(0);
    expect(buildAt(app)).toBe("new");
    // Exchanged, then the previous build renamed to .old: the installed path was never moved away.
    const moved = (read(join(root, "mv.log")) ?? "").split("\0");
    expect(moved).not.toContain(app);
    expect(moved).toContain(`${app}.new`);
  });

  it("falls back to two renames when it isn't available", () => {
    const r = swap("no exchange", { env: () => ({ NO_EXCHANGE: "1" }) });
    expect(r.moved()).toEqual([`exchange ${r.app}.new`, r.app, `${r.app}.new`]);
    expect(r.build()).toBe("new");
    expect(r.confirmed).toBe("installed\n");
    expect(r.siblings()).toEqual(["Busy.app"]);
  });
});

describe("two updates in a row", () => {
  it("installs each in turn and leaves nothing behind for the next", () => {
    const first = swap("first");
    expect(first.build()).toBe("new");
    // A second update, extracted to a fresh temp dir, onto the bundle the first one installed.
    const tmp2 = join(first.root, "busy-update-x2");
    const newer = join(tmp2, "new", "Busy.app");
    makeBundle(newer, { build: "newer", version: "0.4.0" });
    const r = runScript(first.root, [
      "swap",
      goneP(),
      newer,
      first.app,
      tmp2,
      "0.4.0",
      first.state,
    ]);
    expect(r.stderr).toBe("");
    expect(first.build()).toBe("newer");
    expect(first.has("only-in-new")).toBe(false);
    expect(first.opens()).toEqual([
      [first.app, "new"],
      [first.app, "newer"],
    ]);
    expect(
      runScript(first.root, ["recover", first.state, first.app, "0.4.0"]).stdout
    ).toBe("installed\n");
    expect(first.siblings()).toEqual(["Busy.app"]);
    expect(existsSync(tmp2)).toBe(false);
  });
});

// Fifteen filesystem/subprocess update cycles can exceed the default 5s on shared macOS runners.
describe("with generated folder names", { timeout: 15_000 }, () => {
  const tricky = fc.constantFrom(..."aZ9 '\"$`\\*?[]{}()<>;&|!#~-=%^\t\né✨日");
  const nameArb = fc
    .string({ maxLength: 10, minLength: 1, unit: tricky })
    .filter((n) => n !== "." && n !== "..");

  it("installs, relaunches and cleans up whatever the folder is called", () => {
    fc.assert(
      fc.property(nameArb, (name) => {
        const r = swap(name, {
          app: `${name}.app`,
          dir: name,
          tmpDir: `${name}.tmp`,
        });
        expect(r.stderr).toBe("");
        expect(r.build()).toBe("new");
        expect(r.opens()).toEqual([[r.app, "new"]]);
        expect(r.confirmed).toBe("installed\n");
        expect(r.siblings()).toEqual([`${name}.app`]);
        expect(existsSync(r.tmp)).toBe(false);
        expect(
          tree(r.root).filter(
            (f) =>
              !(
                f.startsWith(`${name}/`) ||
                f.startsWith("state/") ||
                // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
                /^(?:open|mv)\.log$|^state\/$/u.test(f)
              )
          )
        ).toEqual([]);
      }),
      { numRuns: 15, seed: 5 }
    );
  });
});

// N-01: a separate sh process SIGKILLed right after each rename/exchange (the journal's included), then the
// standalone recovery, then the startup confirmation of whichever build ended up installed.
const killMatrix = (mode: "exchange" | "renames") => {
  const env = mode === "renames" ? { NO_EXCHANGE: "1" } : {};
  // A full run counts the steps there are to interrupt.
  const counted = swap("count", {
    confirm: false,
    env: () => ({ ...env, KILL_AFTER: "1000" }),
  });
  const steps = Number(read(join(counted.root, "steps")));
  return { env, steps };
};

describe.each(["exchange", "renames"] as const)(
  "SIGKILL at every step of a swap (%s)",
  (mode) => {
    // Without a working exchange the "exchange" run would just be the renames again: skip it, never the renames.
    const skip = mode === "exchange" && !EXCHANGE;
    const { env, steps } = skip ? { env: {}, steps: 1 } : killMatrix(mode);

    test("has steps between the first and the last rename to interrupt", ({
      skip: skipTest,
    }) => {
      skipTest(skip, SKIP_EXCHANGE);
      // staged, the bundle moves, new-installed, verified.
      expect(steps).toBeGreaterThanOrEqual(mode === "exchange" ? 5 : 6);
    });

    test.for(Array.from({ length: steps }, (_, i) => i + 1))(
      "after step %i the recovery leaves a complete app and keeps the backup until the new build runs",
      (n, ctx) => {
        ctx.skip(skip, SKIP_EXCHANGE);
        const r = swap(`kill ${n}`, {
          arrange: ({ root }) => {
            mkdirSync(join(root, "userData"));
            writeFileSync(join(root, "userData", "profile"), "keep");
          },
          confirm: false,
          env: () => ({ ...env, KILL_AFTER: String(n) }),
        });
        expect(r.signal).toBe("SIGKILL");
        // Nothing relaunched: the kill came first.
        expect(r.opens()).toEqual([]);
        // The exchange never leaves the installed path without a complete bundle.
        expect(mode === "renames" || r.build() !== null).toBe(true);

        // Standalone recovery, as from Terminal: no running app, so it never deletes a backup.
        const recovered = runScript(r.root, ["recover", r.state]);
        expect(recovered.status).toBe(0);
        const installed = r.build();
        expect(installed === "new" || installed === "old").toBe(true);
        // With the new build in place, the previous one is still there as the backup.
        expect(installed === "new" ? buildAt(`${r.app}.old`) : "old").toBe(
          "old"
        );
        expect(read(join(r.root, "userData", "profile"))).toBe("keep");

        // The next start of whichever build is installed settles the journal.
        const confirmed = runScript(r.root, [
          "recover",
          r.state,
          r.app,
          installed === "new" ? NEW : OLD,
        ]).stdout;
        expect(confirmed).toBe(
          installed === "new" ? "installed\n" : "failed\n\n"
        );
        expect(r.siblings()).toEqual(["Busy.app"]);
        expect(existsSync(join(r.state, "journal"))).toBe(false);
      }
    );
  }
);

describe("when the two renames are interrupted between them", () => {
  let r: ReturnType<typeof swap>;
  let recovered: string;
  beforeAll(() => {
    r = swap("between renames", {
      confirm: false,
      // exchange fails → staged (journal rename) → mv app .old → kill.
      env: () => ({ KILL_AFTER: "2", NO_EXCHANGE: "1" }),
    });
    recovered = runScript(r.root, ["recover", r.state]).stdout;
  });

  it("left the installed path empty at the kill (the window the journal exists for)", () => {
    expect(r.siblingsAfterSwap).toEqual(["Busy.app.new", "Busy.app.old"]);
  });

  it("completes the swap from the verified staged copy, keeping the old build as the backup", () => {
    expect(recovered).toBe("staged\n");
    expect(r.build()).toBe("new");
    expect(buildAt(`${r.app}.old`)).toBe("old");
  });
});

describe("a recovery run by hand after a finished swap", () => {
  it("reports the swap verified and keeps the backup for the new build to confirm", () => {
    const r = swap("unconfirmed", { confirm: false });
    expect(runScript(r.root, ["recover", r.state]).stdout).toBe("verified\n");
    expect(r.siblings()).toEqual(["Busy.app", "Busy.app.old"]);
    expect(buildAt(`${r.app}.old`)).toBe("old");
  });

  it("keeps the backup when the old build starts instead of the new one", () => {
    const r = swap("other start", { confirm: false });
    const out = runScript(r.root, ["recover", r.state, r.app, OLD]).stdout;
    expect(out).toBe("pending\n");
    expect(r.siblings()).toEqual(["Busy.app", "Busy.app.old"]);
  });

  it("ignores a journal for a bundle other than the running one", () => {
    const r = swap("elsewhere", { confirm: false });
    const out = runScript(r.root, [
      "recover",
      r.state,
      join(r.root, "Other", "Busy.app"),
      NEW,
    ]).stdout;
    expect(out).toBe("elsewhere\n");
    expect(r.siblings()).toEqual(["Busy.app", "Busy.app.old"]);
  });
});

describe("a corrupt or edited journal", () => {
  function journalCase(app: string, extra = "") {
    const root = mkdtempSync(join(base, "journal-"));
    const state = join(root, "state");
    mkdirSync(state);
    // A victim folder that is not a Busy.app, with siblings a naive recovery would delete or move.
    const victim = join(root, "Documents.app");
    for (const d of [victim, `${victim}.old`, `${victim}.new`]) {
      mkdirSync(d);
      writeFileSync(join(d, "keep"), d);
    }
    writeFileSync(
      join(state, "journal"),
      `1\nverified\n${NEW}\n${extra}\n${app.replace("$VICTIM", victim)}`
    );
    const out = runScript(root, [
      "recover",
      state,
      "/Applications/Busy.app",
      NEW,
    ]);
    return { out: out.stdout, root, state, victim };
  }

  it.each([
    ["a folder that is not a Busy.app", "$VICTIM"],
    ["a relative path", "Documents.app"],
    ["a path with ..", "/tmp/../$VICTIM"],
    ["a path that isn't an .app", "/Users"],
  ])("refuses %s and touches nothing", (_label, app) => {
    const c = journalCase(app);
    expect(c.out).toBe("invalid\n");
    for (const d of [c.victim, `${c.victim}.old`, `${c.victim}.new`]) {
      expect(read(join(d, "keep"))).toBe(d);
    }
    // Kept aside for diagnosis; it no longer blocks the next start.
    expect(existsSync(join(c.state, "journal"))).toBe(false);
    expect(existsSync(join(c.state, "journal.invalid"))).toBe(true);
  });

  it("refuses an unknown phase", () => {
    const root = mkdtempSync(join(base, "journal-"));
    const state = join(root, "state");
    const app = join(root, "Busy.app");
    makeBundle(app, { build: "old", version: OLD });
    mkdirSync(`${app}.old`);
    writeFileSync(join(`${app}.old`, "keep"), "x");
    mkdirSync(state);
    writeFileSync(join(state, "journal"), `1\nrm -rf /\n${NEW}\n\n${app}`);
    expect(runScript(root, ["recover", state]).stdout).toBe("invalid\n");
    expect(read(join(`${app}.old`, "keep"))).toBe("x");
  });
});

describe("another updater run holding the lock", () => {
  it("makes the recovery step aside instead of racing it", () => {
    const root = mkdtempSync(join(base, "locked-"));
    const state = join(root, "state");
    mkdirSync(join(state, "lock"), { recursive: true });
    // This test process is alive, so the lock is held.
    writeFileSync(join(state, "lock", "pid"), String(process.pid));
    writeFileSync(join(state, "journal"), "x");
    expect(runScript(root, ["recover", state]).stdout).toBe("busy\n");
    expect(read(join(state, "journal"))).toBe("x");
  });

  it("takes over a lock whose holder was killed", () => {
    const root = mkdtempSync(join(base, "stale-lock-"));
    const state = join(root, "state");
    mkdirSync(join(state, "lock"), { recursive: true });
    writeFileSync(join(state, "lock", "pid"), goneP());
    expect(runScript(root, ["recover", state]).stdout).toBe("none\n");
    expect(existsSync(join(state, "lock"))).toBe(false);
  });
});
