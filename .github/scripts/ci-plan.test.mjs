import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkResults } from "./check-ci-results.mjs";
import { planChecks } from "./ci-plan.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MISSING_CI_MAPPING = /explicit CI mapping/u;
const repositories = [];
afterEach(() => {
  for (const cwd of repositories.splice(0)) {
    rmSync(cwd, { force: true, recursive: true });
  }
});

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), "busy-ci-graph-"));
  repositories.push(cwd);
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  const write = (path, content = "fixture") => {
    const file = join(cwd, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  // Exercise the actual pinned Turbo engine and the repository's real inputs.
  // No app dependencies or builds are needed to plan a task graph.
  for (const path of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "turbo.json",
    "vitest.config.ts",
    "biome.jsonc",
    ".gitignore",
    "apps/hub/package.json",
    "apps/hub/turbo.json",
    "apps/desktop/package.json",
    "apps/desktop/turbo.json",
    "templates/bot/package.json",
    "templates/bot/turbo.json",
    "images/bot-base/package.json",
    "images/bot-base/turbo.json",
  ]) {
    const destination = join(cwd, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(ROOT, path), destination);
  }
  write("apps/desktop/main.mjs");
  write("templates/bot/agent/sandbox.ts");
  const commit = () => {
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "CI test");
  git("config", "user.email", "ci@example.test");
  const baseSha = commit();
  return {
    baseSha,
    commit,
    cwd,
    git,
    plan: (base = baseSha) =>
      planChecks({ baseSha: base, cwd, eventName: "pull_request" }),
    write,
  };
}

test("hub UI selects the hub and avoids unrelated bot, image and macOS jobs", () => {
  const repo = repository();
  repo.write("apps/hub/components/chat-pane.tsx");
  repo.commit();
  const plan = repo.plan();
  assert.deepEqual(plan.build, ["hub"]);
  assert.deepEqual(plan.typecheck, ["hub"]);
  assert.deepEqual(plan.bot, []);
  assert.equal(plan.hub, true);
  assert.equal(plan.desktop, false);
});

test("bot source invalidates the hub's generated bundle and its consumers", () => {
  const repo = repository();
  repo.write("templates/bot/agent/instructions.ts");
  repo.commit();
  const plan = repo.plan();
  assert.deepEqual(plan.build, ["busy-bot", "hub"]);
  assert.deepEqual(plan.typecheck, ["busy-bot", "hub"]);
  assert.deepEqual(plan.bot, ["busy-bot"]);
  assert.equal(plan.hub, true);
  assert.equal(plan.desktop, false);
});

test("cross-package sandbox and deployment contracts select their tests", () => {
  for (const path of [
    "templates/bot/agent/sandbox.ts",
    "images/bot-base/push.sh",
    "apps/hub/lib/hub-token.ts",
    "apps/hub/lib/bots/deploy.ts",
    "docs/provenance/find-skills.json",
  ]) {
    const repo = repository();
    repo.write(path, "updated contract");
    repo.commit();
    assert.ok(repo.plan().bot.includes("busy-bot"), path);
  }
  const repo = repository();
  repo.write("templates/bot/agent/sandbox.ts", "updated sandbox");
  repo.commit();
  assert.ok(repo.plan().bot.includes("busy-bot-base-image"));
});

test("a bot test alone does not invalidate the generated runtime bundle", () => {
  const repo = repository();
  repo.write("templates/bot/agent/instructions.test.ts");
  repo.commit();
  const plan = repo.plan();
  assert.equal(plan.hub, false);
  assert.deepEqual(plan.build, ["busy-bot"]);
  assert.deepEqual(plan.bot, ["busy-bot"]);
});

test("desktop and its hub release contract keep native macOS coverage", () => {
  for (const path of [
    "apps/desktop/with space\nand newline.mjs",
    "apps/hub/lib/install.ts",
    "apps/hub/app/api/download/route.ts",
    "apps/hub/package.json",
  ]) {
    const repo = repository();
    const content = path.endsWith("package.json")
      ? JSON.stringify({
          ...JSON.parse(readFileSync(join(repo.cwd, path), "utf8")),
          description: "updated contract",
        })
      : "source";
    repo.write(path, content);
    repo.commit();
    assert.equal(repo.plan().desktop, true, path);
  }
});

test("moving a source out of its package still selects affected contracts", () => {
  const repo = repository();
  repo.write("docs/README.md");
  repo.git("mv", "templates/bot/agent/sandbox.ts", "docs/moved.ts");
  repo.commit();
  const plan = repo.plan();
  assert.ok(plan.bot.includes("busy-bot-base-image"));
  assert.equal(plan.hub, true);
});

test("shared configuration and unknown root tooling force full coverage", () => {
  for (const path of [
    ".github/actions/setup/action.yml",
    ".githooks/pre-push",
    ".nvmrc",
    "scripts/new-tool.mjs",
    "pnpm-workspace.yaml",
  ]) {
    const repo = repository();
    repo.write(
      path,
      path === "pnpm-workspace.yaml"
        ? `${readFileSync(join(repo.cwd, path), "utf8")}\n# updated tooling\n`
        : "fixture"
    );
    repo.commit();
    const plan = repo.plan();
    assert.equal(plan.hub, true, path);
    assert.equal(plan.desktop, true, path);
    assert.equal(plan.build.length, 2, path);
  }
});

test("ordinary documentation needs no builds or product suites", () => {
  const repo = repository();
  repo.write("docs/acceptance.md");
  repo.write("README.md");
  repo.commit();
  const plan = repo.plan();
  assert.deepEqual(plan.build, []);
  assert.deepEqual(plan.typecheck, []);
  assert.deepEqual(plan.bot, []);
  assert.equal(plan.hub, false);
  assert.equal(plan.desktop, false);
});

test("advancing main does not make unrelated upstream changes part of a PR", () => {
  const repo = repository();
  repo.git("checkout", "-qb", "feature");
  repo.write("templates/bot/agent/instructions.ts");
  repo.commit();
  repo.git("checkout", "-q", "main");
  repo.write("apps/hub/lib/hub-token.ts");
  const base = repo.commit();
  repo.git("checkout", "-q", "feature");
  assert.deepEqual(repo.plan(base).build, ["busy-bot", "hub"]);
});

test("invalid history and new unconfigured workspaces fail closed", () => {
  const repo = repository();
  assert.throws(() => planChecks({ cwd: repo.cwd, eventName: "pull_request" }));
  assert.throws(() => repo.plan("a".repeat(40)));
  repo.write(
    "pnpm-workspace.yaml",
    readFileSync(join(repo.cwd, "pnpm-workspace.yaml"), "utf8").replace(
      '  - "apps/desktop"',
      '  - "apps/desktop"\n  - "apps/unconfigured"'
    )
  );
  repo.write("apps/unconfigured/package.json", '{"name":"new-workspace"}');
  repo.commit();
  assert.throws(() => repo.plan(), MISSING_CI_MAPPING);
});

test("main and manual execution always select every existing suite", () => {
  for (const eventName of ["push", "workflow_dispatch"]) {
    const plan = planChecks({ eventName });
    assert.equal(plan.hub, true);
    assert.equal(plan.desktop, true);
    assert.equal(plan.bot.length, 2);
    assert.equal(plan.build.length, 2);
  }
});

test("new workspace roots also require an explicit CI mapping", () => {
  const repo = repository();
  repo.write(
    "pnpm-workspace.yaml",
    readFileSync(join(repo.cwd, "pnpm-workspace.yaml"), "utf8").replace(
      '  - "templates/*"',
      '  - "templates/*"\n  - "packages/*"'
    )
  );
  repo.write("packages/shared/package.json", '{"name":"new-shared"}');
  repo.commit();
  assert.throws(() => repo.plan(), MISSING_CI_MAPPING);
});

test("quality only accepts successful required checks and explicitly planned skips", () => {
  const plan = planChecks({ eventName: "push" });
  const results = Object.fromEntries(
    [
      "changes",
      "lint",
      "typecheck",
      "build",
      "test-hub",
      "test-bot",
      "desktop",
    ].map((name) => [name, { result: "success" }])
  );
  assert.doesNotThrow(() => checkResults(plan, results));
  for (const name of ["test-hub", "desktop"]) {
    for (const result of ["skipped", "failure", "cancelled"]) {
      assert.throws(() =>
        checkResults(plan, { ...results, [name]: { result } })
      );
    }
  }
  const docs = {
    ...plan,
    bot: [],
    build: [],
    desktop: false,
    hub: false,
    typecheck: [],
  };
  const skipped = {
    ...results,
    build: { result: "skipped" },
    desktop: { result: "skipped" },
    "test-bot": { result: "skipped" },
    "test-hub": { result: "skipped" },
    typecheck: { result: "skipped" },
  };
  assert.doesNotThrow(() => checkResults(docs, skipped));
  assert.throws(() => checkResults({}, skipped));
  assert.throws(() => checkResults(plan, {}));
});
