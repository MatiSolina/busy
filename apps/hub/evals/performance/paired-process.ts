import type { ChildProcess } from "node:child_process";

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function waitForProcessExit(
  child: ChildProcess,
  timeoutMs: number
): Promise<boolean> {
  if (exited(child)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(exited(child));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export async function stopProcessGroup(
  child: ChildProcess,
  graceMs = 2000
): Promise<boolean> {
  if (exited(child)) {
    return true;
  }
  signalGroup(child, "SIGTERM");
  if (await waitForProcessExit(child, graceMs)) {
    return true;
  }
  signalGroup(child, "SIGKILL");
  return waitForProcessExit(child, graceMs);
}
