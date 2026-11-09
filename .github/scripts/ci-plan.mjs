import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const PINNED_VERSION = /^\d+\.\d+\.\d+$/u;
const LOCAL_TURBO = fileURLToPath(
  new URL("../../node_modules/.bin/turbo", import.meta.url)
);
const PACKAGES = new Set([
  "//",
  "busy-bot",
  "busy-bot-base-image",
  "busy-desktop",
  "hub",
]);

function fullPlan(reason) {
  return {
    bot: ["busy-bot", "busy-bot-base-image"],
    build: ["busy-bot", "hub"],
    desktop: true,
    hub: true,
    reason,
    typecheck: ["busy-bot", "hub"],
  };
}

function sharedConfiguration(path) {
  if (!path.includes("/")) {
    return !path.endsWith(".md");
  }
  return (
    path.startsWith(".github/") ||
    path.startsWith(".githooks/") ||
    path.endsWith("/turbo.json") ||
    !["apps/", "templates/", "images/", "docs/"].some((prefix) =>
      path.startsWith(prefix)
    )
  );
}

export function planChecks({
  eventName,
  baseSha,
  cwd = process.cwd(),
  turboBin = LOCAL_TURBO,
}) {
  let fullReason;
  if (eventName === "pull_request") {
    if (!COMMIT_SHA.test(baseSha ?? "")) {
      throw new Error("A pull request needs a valid base commit SHA");
    }
    const paths = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", `${baseSha}...HEAD`, "--"],
      { cwd, encoding: "utf8", stdio: "pipe" }
    )
      .split("\0")
      .filter(Boolean);
    if (paths.some(sharedConfiguration)) {
      fullReason = "Shared configuration changed";
    }
  } else {
    fullReason = "Full validation on main or manual execution";
  }

  const version = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"))
    .devDependencies.turbo;
  if (!PINNED_VERSION.test(version)) {
    throw new Error("CI selection requires an exactly pinned Turbo version");
  }
  const args = [
    "run",
    "build",
    "test",
    "typecheck",
    ...(fullReason ? [] : ["--affected"]),
    "--dry=json",
  ];
  // Planning needs only the pinned Turbo binary, not the app's dependencies.
  const command = existsSync(turboBin) ? turboBin : "npm";
  const commandArgs =
    command === "npm"
      ? ["exec", "--yes", `--package=turbo@${version}`, "--", "turbo", ...args]
      : args;
  const graph = JSON.parse(
    execFileSync(command, commandArgs, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        TURBO_SCM_BASE: baseSha,
        TURBO_SCM_HEAD: "HEAD",
        TURBO_TELEMETRY_DISABLED: "1",
      },
      maxBuffer: 8 * 1024 * 1024,
      stdio: "pipe",
    })
  );
  if (
    !(Array.isArray(graph.packages) && Array.isArray(graph.tasks)) ||
    graph.tasks.some(
      (task) =>
        typeof task.taskId !== "string" || typeof task.command !== "string"
    )
  ) {
    throw new Error("Unknown CI package or invalid Turbo graph");
  }
  if (graph.packages.some((name) => !PACKAGES.has(name))) {
    throw new Error("New workspace needs an explicit CI mapping");
  }
  if (fullReason) {
    return fullPlan(fullReason);
  }
  const tasks = new Set(
    graph.tasks
      .filter((task) => task.command !== "<NONEXISTENT>")
      .map((task) => task.taskId)
  );
  return {
    bot: ["busy-bot", "busy-bot-base-image"].filter((name) =>
      tasks.has(`${name}#test`)
    ),
    build: ["busy-bot", "hub"].filter((name) => tasks.has(`${name}#build`)),
    desktop: tasks.has("busy-desktop#test"),
    hub: tasks.has("hub#test"),
    reason: "Turbo task inputs and dependencies affected by the PR",
    typecheck: ["busy-bot", "hub"].filter((name) =>
      tasks.has(`${name}#typecheck`)
    ),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const plan = planChecks({
    baseSha: process.env.CI_BASE_SHA,
    eventName: process.env.GITHUB_EVENT_NAME,
  });
  appendFileSync(process.env.GITHUB_OUTPUT, `plan=${JSON.stringify(plan)}\n`);
  console.log(JSON.stringify(plan, null, 2));
}
