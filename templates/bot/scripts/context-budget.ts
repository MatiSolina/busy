// Offline context-budget guard for the Busy bot template.
// It imports the authored tool modules only; it never calls a model, provider, or network.
// Run from the repository root with `pnpm check:context-budget`.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { instructionsContent } from "../agent/instructions";
import type { LazyLevel } from "../agent/lib/lazy-tools";
import { collectToolInventory, type ToolInventory } from "./tool-inventory";

export const CONTEXT_BUDGET_MODES = ["off", "on", "core"] as const;
export type ContextBudgetMode = (typeof CONTEXT_BUDGET_MODES)[number];

export const DEFAULT_PEER_COUNT = 8;
const BASELINE_PATH = fileURLToPath(
  new URL("./context-budget-baseline.json", import.meta.url)
);
const BROWSER_GUIDE_PATH = fileURLToPath(
  new URL(
    "../node_modules/@agent-browser/eve/dist/extension/instructions.md",
    import.meta.url
  )
);

const LEVELS: Record<ContextBudgetMode, LazyLevel> = {
  core: "core",
  off: false,
  on: "on",
};

/** Numeric values that are allowed to grow only through an explicit baseline update. */
export const CONTEXT_BUDGET_METRICS = [
  "toolCount",
  "promptToolCount",
  "deferredToolCount",
  "toolBytes",
  "promptToolBytes",
  "deferredToolBytes",
  "instructionsBytes",
  "guideBytes",
  "systemBytes",
  "promptBytes",
] as const;
export type ContextBudgetMetric = (typeof CONTEXT_BUDGET_METRICS)[number];

export interface ContextBudgetMeasurement {
  deferredToolBytes: number;
  deferredToolCount: number;
  guideBytes: number;
  instructionsBytes: number;
  mode: ContextBudgetMode;
  promptBytes: number;
  promptToolBytes: number;
  promptToolCount: number;
  systemBytes: number;
  toolBytes: number;
  toolCount: number;
  toolGroups: ToolInventory["groups"];
}

export type ContextBudgetCeiling = Pick<
  ContextBudgetMeasurement,
  ContextBudgetMetric
>;

export interface ContextBudgetBaseline {
  ceilings: Record<ContextBudgetMode, ContextBudgetCeiling>;
  peerCount: number;
  version: 1;
}

export interface ContextBudgetFailure {
  ceiling: number;
  current: number;
  metric: ContextBudgetMetric;
  mode: ContextBudgetMode;
}

export interface ContextBudgetCheck {
  failures: ContextBudgetFailure[];
  ok: boolean;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function promptToolCount(inventory: ToolInventory): number {
  return inventory.rows.filter((row) => !row.group.endsWith("(deferred)"))
    .length;
}

function guideBytes(): number {
  return bytes(readFileSync(BROWSER_GUIDE_PATH, "utf8"));
}

export async function measureContextBudget(
  mode: ContextBudgetMode,
  peerCount = DEFAULT_PEER_COUNT
): Promise<ContextBudgetMeasurement> {
  const inventory = await collectToolInventory(LEVELS[mode], { peerCount });
  const promptCount = promptToolCount(inventory);
  const deferredCount = inventory.rows.length - promptCount;
  const browserGuideBytes = guideBytes();
  const instructionsSize = bytes(instructionsContent(LEVELS[mode]));
  const systemSize = instructionsSize + browserGuideBytes;

  return {
    deferredToolBytes: inventory.total - inventory.promptBytes,
    deferredToolCount: deferredCount,
    guideBytes: browserGuideBytes,
    instructionsBytes: instructionsSize,
    mode,
    promptBytes: inventory.promptBytes + systemSize,
    promptToolBytes: inventory.promptBytes,
    promptToolCount: promptCount,
    systemBytes: systemSize,
    toolBytes: inventory.total,
    toolCount: inventory.rows.length,
    toolGroups: inventory.groups,
  };
}

export async function measureAllContextBudgets(
  peerCount = DEFAULT_PEER_COUNT
): Promise<Record<ContextBudgetMode, ContextBudgetMeasurement>> {
  const entries = await Promise.all(
    CONTEXT_BUDGET_MODES.map(
      async (mode) =>
        [mode, await measureContextBudget(mode, peerCount)] as const
    )
  );
  return Object.fromEntries(entries) as Record<
    ContextBudgetMode,
    ContextBudgetMeasurement
  >;
}

export function checkContextBudgets(
  measurements: Record<ContextBudgetMode, ContextBudgetMeasurement>,
  baseline: ContextBudgetBaseline
): ContextBudgetCheck {
  const failures: ContextBudgetFailure[] = [];
  for (const mode of CONTEXT_BUDGET_MODES) {
    const measurement = measurements[mode];
    const ceiling = baseline.ceilings[mode];
    if (!ceiling) {
      failures.push({
        ceiling: 0,
        current: Number.POSITIVE_INFINITY,
        metric: "promptBytes",
        mode,
      });
      continue;
    }
    for (const metric of CONTEXT_BUDGET_METRICS) {
      const current = measurement[metric];
      const allowed = ceiling[metric];
      if (
        !(Number.isFinite(current) && Number.isFinite(allowed)) ||
        current > allowed
      ) {
        failures.push({
          ceiling: allowed,
          current,
          metric,
          mode,
        });
      }
    }
  }
  return { failures, ok: failures.length === 0 };
}

export function baselineFromMeasurements(
  measurements: Record<ContextBudgetMode, ContextBudgetMeasurement>,
  peerCount = DEFAULT_PEER_COUNT
): ContextBudgetBaseline {
  const ceilings = Object.fromEntries(
    CONTEXT_BUDGET_MODES.map((mode) => {
      const measurement = measurements[mode];
      const values = Object.fromEntries(
        CONTEXT_BUDGET_METRICS.map((metric) => [metric, measurement[metric]])
      ) as ContextBudgetCeiling;
      return [mode, values];
    })
  ) as Record<ContextBudgetMode, ContextBudgetCeiling>;
  return { ceilings, peerCount, version: 1 };
}

export function readContextBudgetBaseline(
  path = BASELINE_PATH
): ContextBudgetBaseline {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Context budget baseline is not an object: ${path}`);
  }
  const value = parsed as Partial<ContextBudgetBaseline>;
  if (
    value.version !== 1 ||
    !value.ceilings ||
    !Number.isInteger(value.peerCount)
  ) {
    throw new Error(`Context budget baseline has an invalid shape: ${path}`);
  }
  return value as ContextBudgetBaseline;
}

function formatBytes(value: number): string {
  return `${value.toLocaleString("en-US")} B`;
}

function report(
  measurements: Record<ContextBudgetMode, ContextBudgetMeasurement>
): string {
  const lines = [
    "Context budget (tool schemas + system instructions + browser guide)",
    "",
    "| Mode | Prompt tools | Tool bytes | Instructions | Guide | Prompt total |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const mode of CONTEXT_BUDGET_MODES) {
    const m = measurements[mode];
    lines.push(
      `| ${mode} | ${m.promptToolCount}/${m.toolCount} | ${formatBytes(m.promptToolBytes)} | ${formatBytes(m.instructionsBytes)} | ${formatBytes(m.guideBytes)} | ${formatBytes(m.promptBytes)} |`
    );
  }
  return `${lines.join("\n")}\n`;
}

function failureReport(failures: ContextBudgetFailure[]): string {
  return failures
    .map(
      ({ ceiling, current, metric, mode }) =>
        `- ${mode}.${metric}: ${current} > ceiling ${ceiling}`
    )
    .join("\n");
}

async function main(args: string[]): Promise<number> {
  const update = args.includes("--update-baseline");
  const check = args.includes("--check") || !update;
  if (update && args.includes("--check")) {
    throw new Error("Choose either --check or --update-baseline, not both");
  }
  const unknown = args.filter(
    (arg) => !["--check", "--update-baseline", "--json"].includes(arg)
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown context-budget option: ${unknown.join(", ")}`);
  }

  const baseline = readContextBudgetBaseline();
  const measurements = await measureAllContextBudgets(baseline.peerCount);
  const json = args.includes("--json");
  if (json) {
    console.log(JSON.stringify({ baseline, measurements }, null, 2));
  } else {
    process.stdout.write(report(measurements));
  }

  if (update) {
    const next = baselineFromMeasurements(measurements, baseline.peerCount);
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    (json ? console.error : console.log)(`Updated ${BASELINE_PATH}`);
    return 0;
  }
  if (!check) {
    return 0;
  }
  const result = checkContextBudgets(measurements, baseline);
  if (!result.ok) {
    console.error(
      `Context budget exceeded. Review the change, then intentionally run \
pnpm update:context-budget to accept a new ceiling.\n${failureReport(result.failures)}`
    );
    return 1;
  }
  (json ? console.error : console.log)(
    "Context budget is within the checked-in ceilings."
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
