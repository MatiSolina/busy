import { spawn } from "node:child_process";
import { afterEach, expect, it as test } from "vitest";
import { stopProcessGroup } from "./paired-process";

const children: ReturnType<typeof spawn>[] = [];

afterEach(async () => {
  await Promise.all(children.map((child) => stopProcessGroup(child, 100)));
  children.length = 0;
});

test("kills a detached child that ignores SIGTERM and waits for exit", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { detached: true, stdio: "ignore" }
  );
  children.push(child);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await stopProcessGroup(child, 50)).toBe(true);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});
