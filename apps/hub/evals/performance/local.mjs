import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const hub = resolve(root, "apps/hub");
const output = resolve(root, ".performance");
const source = resolve(process.env.PERF_APP_DIR ?? root);
const recordBaseline = process.env.PERF_RECORD_BASELINE === "1";
const baseline = resolve(
  process.env.PERF_BASELINE ?? resolve(output, "baseline.json")
);
const temporary = await mkdtemp(resolve(tmpdir(), "busy-performance-"));
const databaseDirectory = resolve(temporary, "data");
const passwordFile = resolve(temporary, "password");
const databasePassword = randomUUID();
await mkdir(output, { recursive: true });

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No available loopback port");
  }
  const { port } = address;
  await new Promise((done, reject) =>
    server.close((error) => (error ? reject(error) : done()))
  );
  return port;
}

const databasePort = await freePort();
const appPort = await freePort();
const baseURL = `http://127.0.0.1:${appPort}`;
const env = {
  ...process.env,
  DATABASE_URL: `postgresql://busy_eval:${databasePassword}@127.0.0.1:${databasePort}/busy_eval`,
  DATABASE_URL_UNPOOLED: `postgresql://busy_eval:${databasePassword}@127.0.0.1:${databasePort}/busy_eval`,
  HUB_URL: baseURL,
  PGPASSWORD: databasePassword,
  SESSION_SECRET: randomUUID(),
};

async function command(name, args, cwd = hub) {
  const result = await exec(name, args, {
    cwd,
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

async function waitForApp() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Poll the one server sequentially until it is reachable.
      if ((await fetch(`${baseURL}/login`)).ok) {
        return;
      }
    } catch {
      /* The server is still starting. */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("The local production server did not become ready");
}

async function verifyDatabaseAuthentication() {
  const unauthorized = postgres({
    connect_timeout: 3,
    database: "busy_eval",
    host: "127.0.0.1",
    max: 1,
    password: `${databasePassword}-incorrect`,
    port: databasePort,
    username: "busy_eval",
  });
  let rejected = false;
  try {
    await unauthorized`SELECT 1`;
  } catch (error) {
    if (error.code !== "28P01") {
      throw error;
    }
    rejected = true;
  } finally {
    await unauthorized.end({ timeout: 1 });
  }
  if (!rejected) {
    throw new Error("The fixture database must reject incorrect passwords");
  }
}

let databaseStarted = false;
let server;
try {
  console.log(
    "Creating an isolated Postgres fixture (requires initdb, pg_ctl and createdb on PATH)…"
  );
  await writeFile(passwordFile, databasePassword, { mode: 0o600 });
  await command("initdb", [
    "-D",
    databaseDirectory,
    "--auth=scram-sha-256",
    `--pwfile=${passwordFile}`,
    "--username=busy_eval",
  ]);
  await rm(passwordFile);
  await command("pg_ctl", [
    "-D",
    databaseDirectory,
    "-l",
    resolve(temporary, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${databasePort}`,
    "start",
  ]);
  databaseStarted = true;
  await command("createdb", [
    "-h",
    "127.0.0.1",
    "-p",
    String(databasePort),
    "-U",
    "busy_eval",
    "busy_eval",
  ]);
  await verifyDatabaseAuthentication();
  await command("pnpm", ["exec", "drizzle-kit", "push", "--force"]);
  await command("pnpm", ["exec", "tsx", "evals/performance/seed.ts"]);
  console.log("Building the production app…");
  await writeFile(
    resolve(output, "build.log"),
    await command("pnpm", ["build"], resolve(source, "apps/hub"))
  );
  server = spawn(
    "pnpm",
    [
      "exec",
      "next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(appPort),
    ],
    { cwd: resolve(source, "apps/hub"), detached: true, env, stdio: "ignore" }
  );
  await waitForApp();
  const reportPath = recordBaseline ? baseline : resolve(output, "latest.json");
  const evalEnv = {
    ...env,
    PERF_BASELINE: recordBaseline ? "" : baseline,
    PERF_OUTPUT: reportPath,
    PERF_SOURCE_DIR: source,
    PERF_URL: baseURL,
  };
  await new Promise((done, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", "evals/performance/run.ts"], {
      cwd: hub,
      env: evalEnv,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? done()
        : reject(new Error(`Performance evaluation failed (exit ${code})`))
    );
  });
  console.log(`Report: ${reportPath}`);
} finally {
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      /* Already exited. */
    }
  }
  if (databaseStarted) {
    await command("pg_ctl", ["-D", databaseDirectory, "-m", "fast", "stop"]);
  }
  await rm(temporary, { force: true, recursive: true });
}
