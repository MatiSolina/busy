import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The Dockerfile and the scripts it installs must agree: what `desktop` runs has to be in the image,
// and the files land where the bot's prepare check and every login shell look for them.
const here = (name: string) => new URL(`./${name}`, import.meta.url);
const DOCKERFILE = readFileSync(here("Dockerfile"), "utf8");
const DESKTOP = readFileSync(here("desktop.sh"), "utf8");
const SANDBOX = readFileSync(
  new URL("../../templates/bot/agent/sandbox.ts", import.meta.url),
  "utf8"
);
const MARKER_VERSION = /^[0-9]+$/u;
const present = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Expected a present test value");
  }
  return value;
};

/** Dockerfile instructions with their `\` continuations joined. */
const instructions = DOCKERFILE.replace(/\\\n/gu, " ")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

const copies = instructions
  .filter((l) => l.startsWith("COPY "))
  .map((l) => {
    // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
    const words = l.split(/\s+/u).slice(1);
    const mode = words
      .find((w) => w.startsWith("--chmod="))
      ?.slice("--chmod=".length);
    const [src, dest] = words.filter((w) => !w.startsWith("--"));
    return {
      dest: present(dest),
      mode: mode === undefined ? undefined : Number.parseInt(mode, 8),
      src: present(src),
    };
  });
const copyOf = (src: string) => copies.find((c) => c.src === src);

const aptPackages = instructions
  // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
  .filter((l) => /apt-get install/u.test(l))
  // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
  .flatMap((l) => l.split(/\s+/u))
  // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
  .filter((w) => /^[a-z0-9][a-z0-9.+-]+$/u.test(w));

/** Commands desktop.sh runs (first word of each simple command, past `exec`/`!`/`||`). */
const scriptCommands = new Set(
  DESKTOP.split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
    .flatMap((l) => l.split(/;|&&|\|\||\(|\bthen\b|\bdo\b|\bif\b|!/u))
    .map((part) =>
      part
        .trim()
        // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
        .split(/\s+/u)
        // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
        .filter((w) => !/^\w+=/u.test(w))
    )
    .map((words) => (words[0] === "exec" ? words[1] : words[0]))
    // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
    .filter((w): w is string => !!w && /^[A-Za-z][\w-]*$/u.test(w))
);

describe("the image installs desktop where the bot looks for it", () => {
  it("copies files that exist next to the Dockerfile", () => {
    expect(copies.length).toBeGreaterThan(0);
    for (const c of copies) {
      expect(existsSync(here(c.src)), c.src).toBe(true);
    }
  });

  it("installs desktop.sh as the executable the bot's prepare checks for", () => {
    const desktop = present(copyOf("desktop.sh"));
    const checked =
      // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
      /test -x (?<path>\/usr\/local\/bin\/desktop)(?:["`\s]|$)/u.exec(SANDBOX)
        ?.groups?.path;
    expect(checked).toBeDefined();
    expect(desktop.dest).toBe(checked);
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX executable checks require masking mode bits
    expect(present(desktop.mode) & 0o111).toBe(0o111);
  });

  it("installs the desktop command on the default PATH as `desktop`", () => {
    const { dest } = present(copyOf("desktop.sh"));
    expect(["/usr/local/bin", "/usr/bin", "/bin"]).toContain(
      dest.slice(0, dest.lastIndexOf("/"))
    );
    expect(dest.split("/").pop()).toBe("desktop");
  });

  it("puts the profile where /etc/profile sources it: /etc/profile.d/*.sh, readable by everyone", () => {
    const profile = present(copyOf("desktop-profile.sh"));
    // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
    expect(profile.dest).toMatch(/^\/etc\/profile\.d\/[\w.-]+\.sh$/u);
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX readability checks require masking mode bits
    expect(present(profile.mode) & 0o444).toBe(0o444);
  });

  it("switches back to eve's sandbox user after installing as root", () => {
    const users = instructions
      .filter((l) => l.startsWith("USER "))
      // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
      .map((l) => l.split(/\s+/u)[1]);
    expect(users[0]).toBe("root");
    expect(users.at(-1)).toBe("vercel-sandbox");
  });
});

describe("the image ABI marker (H-19)", () => {
  const VERSION = readFileSync(here("image-version"), "utf8").trim();
  const COMPUTER_IMAGE = readFileSync(
    new URL("../../templates/bot/agent/lib/computer-image.ts", import.meta.url),
    "utf8"
  );

  it("installs a fixed marker, readable by everyone, where the bot reads it", () => {
    expect(VERSION).toMatch(MARKER_VERSION);
    expect(copyOf("image-version")).toEqual({
      dest: "/etc/busy-image-version",
      mode: 0o644,
      src: "image-version",
    });
    expect(COMPUTER_IMAGE).toContain(
      'IMAGE_MARKER_PATH = "/etc/busy-image-version"'
    );
  });

  it("is the version this bot's code expects", () => {
    expect(COMPUTER_IMAGE).toContain(`BOT_BASE_IMAGE_VERSION = "${VERSION}"`);
  });

  it("is checked by prepare whenever an image carries it", () => {
    expect(SANDBOX).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the source's template placeholders are matched literally
      "test ! -e ${IMAGE_MARKER_PATH} || grep -qxF '${BOT_BASE_IMAGE_VERSION}' ${IMAGE_MARKER_PATH}"
    );
  });
});

describe("publishing", () => {
  const PUSH = readFileSync(here("push.sh"), "utf8");

  it("publishes only the tag that names the marker it installs", () => {
    expect(PUSH).toContain('[ "$1" = "v$version" ]');
    expect(PUSH).toContain("version=$(cat image-version)");
  });

  // Vercel Sandbox runs amd64; an image built for the Mac it was pushed from wouldn't start.
  it("builds for linux/amd64 whatever machine pushes it", () => {
    // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
    expect(PUSH).toMatch(/docker buildx build[^\n]*--platform linux\/amd64/u);
  });
});

describe("every program desktop runs is in the image", () => {
  // A missing xdpyinfo would make every call think the screen is down: it would restart Xvfb and
  // wipe Chrome's profile locks under a running Chrome.
  it.each([
    ["Xvfb", ["xvfb"]],
    ["xdpyinfo", ["x11-utils"]],
    ["openbox", ["openbox"]],
    ["dbus-daemon", ["dbus", "dbus-daemon", "dbus-x11"]],
  ])("%s comes from an installed package", (command, packages) => {
    expect(scriptCommands).toContain(command);
    expect(aptPackages.filter((p) => packages.includes(p))).not.toEqual([]);
  });

  it("installs agent-desktop from npm, pinned to a version", () => {
    expect(scriptCommands).toContain("agent-desktop");
    expect(instructions.join("\n")).toMatch(
      // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
      /npm install -g[^\n]* agent-desktop@\d+\.\d+\.\d+(?:\s|$)/u
    );
  });

  it("installs the pinned stock agent-browser binary outside the bot runtime", () => {
    expect(instructions.join("\n")).toMatch(
      // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
      /npm install --prefix \/opt\/busy-tools[^\n]* agent-browser@0\.41\.1(?:\s|$)/u
    );
    expect(DOCKERFILE).toContain(
      "/opt/busy-tools/node_modules/agent-browser/bin/agent-browser-linux-x64 --version"
    );
    expect(readFileSync(here("browser-wrapper.py"), "utf8")).toContain(
      "agent-browser/bin/agent-browser-linux-x64"
    );
    expect(copyOf("browser-wrapper.py")).toEqual({
      dest: "/usr/local/bin/agent-browser",
      mode: 0o755,
      src: "browser-wrapper.py",
    });
    expect(DOCKERFILE).toContain(
      "ln -s /usr/local/bin/agent-browser /usr/local/bin/browser"
    );
  });

  it("installs Google Chrome and the AT-SPI bus it reports to", () => {
    expect(instructions.join("\n")).toMatch(
      // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
      /google-chrome-stable_current_amd64\.deb/u
    );
    expect(aptPackages).toEqual(
      expect.arrayContaining([
        "at-spi2-core",
        "libatk-bridge2.0-0",
        "xdg-utils",
      ])
    );
  });

  it("only calls programs it installs or that every Debian base has", () => {
    const base = [
      "export",
      "mkdir",
      "chmod",
      "exec",
      "flock",
      "rm",
      "sleep",
      "pgrep",
      "pkill",
      "kill",
      "cat",
      "for",
      "break",
      "fi",
      "else",
      "done",
      "case",
      "esac",
      "set",
      "test",
      "true",
      "command",
      "dbus-send",
      "bus_responds",
      "stop_a11y",
      "a11y_running",
      "screen_failed",
      "unset",
      "return",
      "exit",
      "echo",
      "printf",
    ];
    const installed = [
      "Xvfb",
      "xdpyinfo",
      "openbox",
      "dbus-daemon",
      "agent-desktop",
      "desktop-session",
      "desktop-a11y",
      "desktop-control",
    ];
    expect(
      [...scriptCommands].filter(
        (c) => !(base.includes(c) || installed.includes(c))
      )
    ).toEqual([]);
  });
});

describe("Chrome survives the bot's key presses", () => {
  it("installs desktop-a11y where desktop calls it, runnable, with the D-Bus bindings it imports", () => {
    expect(scriptCommands).toContain("desktop-a11y");
    expect(copyOf("desktop-a11y.py")).toEqual({
      dest: "/usr/local/bin/desktop-a11y",
      mode: 0o755,
      src: "desktop-a11y.py",
    });
    expect(readFileSync(here("desktop-a11y.py"), "utf8")).toMatch(
      // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
      /^#!\/usr\/bin\/python3\n[\s\S]*^import dbus$/mu
    );
    expect(aptPackages).toContain("python3-dbus");
  });
});

describe("managed browser and manual-control helpers", () => {
  it.each([
    ["desktop-control.py", "/usr/local/bin/desktop-control"],
    ["desktop-browser.py", "/usr/local/bin/desktop-browser"],
    ["browser-wrapper.py", "/usr/local/bin/agent-browser"],
  ])("installs %s as %s", (source, destination) => {
    expect(copyOf(source)).toEqual({
      dest: destination,
      mode: 0o755,
      src: source,
    });
    expect(readFileSync(here(source), "utf8")).toContain(
      "BUSY_DESKTOP_RUNTIME"
    );
  });

  it("keeps the managed Chrome profile private and outside /data", () => {
    const browser = readFileSync(here("desktop-browser.py"), "utf8");
    expect(browser).toMatch(
      // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
      /Path\.home\(\) \/ "\.config" \/ "busy-chrome-profile"/u
    );
    expect(browser).toContain('"/data" not in profile.parts');
  });

  it("routes human taskbar/XDG launches through the separate human handoff", () => {
    expect(
      readFileSync(
        new URL("./desktop/applications/busy-chrome.desktop", import.meta.url),
        "utf8"
      )
    ).toContain("Exec=desktop-browser human-open %U");
  });

  it("has a loopback endpoint fast path before the expensive desktop inventory", () => {
    const browser = readFileSync(here("desktop-browser.py"), "utf8");
    expect(browser).toContain("/json/version");
    expect(browser).toContain("timeout: float = 0.35");
    expect(browser).toContain("def fast_state()");
  });

  it("ignores dead AT-SPI rows when deciding whether Chrome is unmanaged", () => {
    const browser = readFileSync(here("desktop-browser.py"), "utf8");
    expect(browser).toContain(
      'process_alive(app.get("pid")) and is_chrome_app(app)'
    );
  });
});

describe("the desktop people see in the live screen", () => {
  it("installs desktop-session where desktop calls it, runnable", () => {
    expect(scriptCommands).toContain("desktop-session");
    expect(copyOf("desktop-session.sh")).toEqual({
      dest: "/usr/local/bin/desktop-session",
      mode: 0o755,
      src: "desktop-session.sh",
    });
  });

  it("ships its settings where desktop-session reads them", () => {
    expect(copyOf("desktop")?.dest).toBe("/usr/local/share/busy-desktop");
    expect(readFileSync(here("desktop-session.sh"), "utf8")).toContain(
      "share=/usr/local/share/busy-desktop"
    );
  });

  it.each([
    ["tint2", "the taskbar"],
    ["pcmanfm", "the file manager and the desktop icons"],
    ["lxterminal", "the terminal"],
  ])("installs %s (%s)", (pkg) => {
    expect(aptPackages).toContain(pkg);
  });

  it("makes bwrap setuid in the same step, or GTK apps abort on their first SVG icon", () => {
    expect(
      // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
      instructions.find((l) => /apt-get install[^\n]* pcmanfm/u.test(l))
      // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
    ).toMatch(/chmod u\+s \/usr\/bin\/bwrap/u);
  });
});
