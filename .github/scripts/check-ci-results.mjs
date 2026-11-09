import { pathToFileURL } from "node:url";

export function checkResults(plan, results) {
  if (
    !(
      Array.isArray(plan.build) &&
      Array.isArray(plan.typecheck) &&
      Array.isArray(plan.bot)
    ) ||
    typeof plan.hub !== "boolean" ||
    typeof plan.desktop !== "boolean"
  ) {
    throw new Error("Missing or invalid CI selection plan");
  }
  const required = {
    build: plan.build.length > 0,
    changes: true,
    desktop: plan.desktop,
    lint: true,
    "test-bot": plan.bot.length > 0,
    "test-hub": plan.hub,
    typecheck: plan.typecheck.length > 0,
  };
  for (const [name, enabled] of Object.entries(required)) {
    const expected = enabled ? "success" : "skipped";
    if (results[name]?.result !== expected) {
      throw new Error(
        `${name}: expected ${expected}, got ${results[name]?.result ?? "missing"}`
      );
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  checkResults(
    JSON.parse(process.env.CI_PLAN),
    JSON.parse(process.env.CI_RESULTS)
  );
  console.log("Every selected validation passed; only planned skips accepted.");
}
