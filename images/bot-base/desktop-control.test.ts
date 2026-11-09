import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = new URL("./desktop-control.py", import.meta.url).pathname;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function box() {
  const root = mkdtempSync(join(tmpdir(), "desktop-control-"));
  roots.push(root);
  return root;
}

function run(runtime: string, ...args: string[]) {
  return spawnSync("python3", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, BUSY_DESKTOP_RUNTIME: runtime },
  });
}

describe("desktop-control", () => {
  it("returns the lease contract, rejects another viewer, and releases with expiresAt zero", () => {
    const runtime = box();
    const acquired = run(runtime, "acquire", "viewer-a");
    expect(acquired.status).toBe(0);
    expect(JSON.parse(acquired.stdout)).toMatchObject({
      expiresAt: expect.any(Number),
      ok: true,
    });

    const conflict = run(runtime, "acquire", "viewer-b");
    expect(conflict.status).toBe(1);
    expect(JSON.parse(conflict.stdout)).toMatchObject({
      code: "CONTROL_BUSY",
      error: expect.any(String),
      ok: false,
    });

    const released = run(runtime, "release", "viewer-a");
    expect(released.status).toBe(0);
    expect(JSON.parse(released.stdout)).toEqual({ expiresAt: 0, ok: true });
  });

  it("survives helper SIGKILL until the action exits without leaking the lock to its background daemon", async () => {
    const runtime = box();
    const pidFile = join(runtime, "background-pid");
    const releaseFile = join(runtime, "release");
    const child = spawn(
      "python3",
      [
        SCRIPT,
        "run",
        "--",
        "/bin/sh",
        "-c",
        'sleep 30 >/dev/null 2>&1 & echo $! > "$1"; while [ ! -e "$2" ]; do sleep 0.01; done',
        "test-action",
        pidFile,
        releaseFile,
      ],
      {
        env: { ...process.env, BUSY_DESKTOP_RUNTIME: runtime },
        stdio: "ignore",
      }
    );
    const readBackgroundPid = (): number | null => {
      if (!existsSync(pidFile)) {
        return null;
      }
      try {
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        return Number.isInteger(pid) && pid > 1 ? pid : null;
      } catch {
        return null;
      }
    };
    try {
      const deadline = Date.now() + 5000;
      const waitForPid = async (): Promise<number | null> => {
        const pid = readBackgroundPid();
        if (pid !== null || Date.now() >= deadline) {
          return pid;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
        return waitForPid();
      };
      const backgroundPid = await waitForPid();
      if (backgroundPid === null) {
        throw new Error("background pid was not written");
      }
      expect(run(runtime, "acquire", "viewer-a").status).toBe(1);
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      expect(run(runtime, "acquire", "viewer-a").status).toBe(1);
      writeFileSync(releaseFile, "release");
      const availableDeadline = Date.now() + 5000;
      const waitForAvailable = async (): Promise<number | null> => {
        const { status } = run(runtime, "acquire", "viewer-a");
        if (status === 0 || Date.now() >= availableDeadline) {
          return status;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
        return waitForAvailable();
      };
      expect(await waitForAvailable()).toBe(0);
      expect(() => process.kill(backgroundPid, 0)).not.toThrow();
    } finally {
      writeFileSync(releaseFile, "release");
      child.kill("SIGKILL");
      const backgroundPid = readBackgroundPid();
      if (backgroundPid !== null) {
        try {
          process.kill(backgroundPid, "SIGTERM");
        } catch {
          /* already exited */
        }
      }
    }
  });

  it("classifies observations as read-only without producing stdout", () => {
    const runtime = box();
    expect(run(runtime, "is-read-only", "snapshot", "--json").status).toBe(0);
    expect(run(runtime, "is-read-only", "click", "@e1").status).toBe(1);
    expect(run(runtime, "is-read-only", "snapshot", "--json").stdout).toBe("");
  });
});

describe("desktop-control lease proof (H-20)", { timeout: 30_000 }, () => {
  // Runs desktop-control verify-lease from a shell that may hold a forged descriptor on fd 7.
  const verify = (runtime: string, setup: string, extra = {}) =>
    spawnSync(
      "/bin/sh",
      ["-c", `${setup}\nexec python3 "$SCRIPT" verify-lease`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BUSY_DESKTOP_RUNTIME: runtime,
          SCRIPT,
          ...extra,
        },
      }
    );
  const lockFile = (runtime: string) => join(runtime, "agent-action.lock");

  it("proves the lease only to a command run with --pass-lease", () => {
    const runtime = box();
    const proved = run(
      runtime,
      "run",
      "--pass-lease",
      "--",
      "python3",
      SCRIPT,
      "verify-lease"
    );
    expect(proved.status).toBe(0);
    expect(proved.stdout).toBe("");
    expect(
      run(runtime, "run", "--", "python3", SCRIPT, "verify-lease").status
    ).toBe(1);
  });

  it("never passes the old marker through as if it were authorization", () => {
    const runtime = box();
    const shown = spawnSync(
      "python3",
      [
        SCRIPT,
        "run",
        "--",
        "/bin/sh",
        "-c",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: this fixture intentionally preserves shell parameter expansion literally
        'printf "%s" "${BUSY_DESKTOP_CONTROLLED:-unset}"',
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BUSY_DESKTOP_CONTROLLED: "1",
          BUSY_DESKTOP_RUNTIME: runtime,
        },
      }
    );
    expect(shown.stdout).toBe("unset");
  });

  it("rejects an environment variable without the locked descriptor", () => {
    const runtime = box();
    expect(
      verify(runtime, "", {
        BUSY_DESKTOP_CONTROLLED: "1",
        BUSY_DESKTOP_LEASE_FD: "7",
      }).status
    ).toBe(1);
  });

  it("rejects a descriptor of another file", () => {
    const runtime = box();
    writeFileSync(join(runtime, "other"), "");
    expect(
      verify(runtime, `exec 7<>"${join(runtime, "other")}"`, {
        BUSY_DESKTOP_LEASE_FD: "7",
      }).status
    ).toBe(1);
  });

  it("rejects the lock file opened by the caller itself, and leaves it unlocked", () => {
    const runtime = box();
    // Create the lock file the way the helper does.
    expect(run(runtime, "state").status).toBe(0);
    expect(
      verify(runtime, `exec 7<>"${lockFile(runtime)}"`, {
        BUSY_DESKTOP_LEASE_FD: "7",
      }).status
    ).toBe(1);
    expect(run(runtime, "acquire", "viewer-a").status).toBe(0);
  });

  it("rejects the lock file while somebody else's action holds it", async () => {
    const runtime = box();
    const started = join(runtime, "started");
    const release = join(runtime, "release");
    const holder = spawn(
      "python3",
      [
        SCRIPT,
        "run",
        "--",
        "/bin/sh",
        "-c",
        ': > "$1"; while [ ! -e "$2" ]; do sleep 0.01; done',
        "holder",
        started,
        release,
      ],
      {
        env: { ...process.env, BUSY_DESKTOP_RUNTIME: runtime },
        stdio: "ignore",
      }
    );
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(started) && Date.now() < deadline) {
        // biome-ignore lint/performance/noAwaitInLoops: polling a condition sequentially is the point
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(existsSync(started)).toBe(true);
      expect(
        verify(runtime, `exec 7<>"${lockFile(runtime)}"`, {
          BUSY_DESKTOP_LEASE_FD: "7",
        }).status
      ).toBe(1);
    } finally {
      writeFileSync(release, "");
      await new Promise<void>((resolve) =>
        holder.once("exit", () => resolve())
      );
    }
  });

  it("refuses the human launcher without an active manual owner", () => {
    const runtime = box();
    const result = run(runtime, "human-open", "https://example.com");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: "CONTROL_LOST" });
  });

  it("gives the human launcher the lease while its person holds manual control", () => {
    const runtime = box();
    const launcher = join(runtime, "launcher");
    const record = join(runtime, "launcher.out");
    writeFileSync(
      launcher,
      `#!/bin/sh\npython3 "${SCRIPT}" verify-lease; echo "$? $*" > "${record}"\n`,
      { mode: 0o755 }
    );
    expect(run(runtime, "acquire", "viewer-a").status).toBe(0);
    const result = spawnSync(
      "python3",
      [SCRIPT, "human-open", "https://example.com"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BUSY_DESKTOP_BROWSER_COMMAND: launcher,
          BUSY_DESKTOP_RUNTIME: runtime,
        },
      }
    );
    expect(result.status).toBe(0);
    expect(readFileSync(record, "utf8").trim()).toBe(
      "0 human-open https://example.com"
    );
    // The same descriptor does not authorize an agent command while the person is in control.
    expect(
      run(
        runtime,
        "run",
        "--pass-lease",
        "--",
        "python3",
        SCRIPT,
        "verify-lease"
      ).status
    ).toBe(1);
  });
});
