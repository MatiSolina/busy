import type { Billing } from "./models";
import template from "./template.generated.json" with { type: "json" };

export interface BotConfig {
  billing?: Billing;
  description: string;
  fast: boolean;
  instructions: string;
  lazyTools?: boolean | "core";
  model: string;
  name: string;
  slug: string;
}

// docs/lazy-tools.md: A/B rollout without a DB migration. Each env var is a comma-separated
// list of bot slugs, or `*`. Unlisted bots get no key, so their config.json is unchanged.
const listed = (list: string | undefined, slug: string) =>
  (list ?? "")
    .split(",")
    .map((s) => s.trim())
    .some((s) => s === "*" || s === slug);

export function rolloutFlags(
  slug: string,
  env: Record<string, string | undefined> = process.env
): Pick<BotConfig, "lazyTools"> {
  return {
    // LAZY_TOOLS_LEVEL: `on` (default) writes true; `core` also defers everyday tools.
    ...(listed(env.LAZY_TOOLS_BOTS, slug)
      ? { lazyTools: env.LAZY_TOOLS_LEVEL?.trim() === "core" ? "core" : true }
      : {}),
  };
}

export interface DeployFile {
  data: string;
  encoding: "utf-8";
  file: string;
}

// Config travels as JSON data, never interpolated into code.
export function buildBotFiles(cfg: BotConfig): DeployFile[] {
  const files: Record<string, string> = {
    ...template,
    "agent/config.json": `${JSON.stringify(cfg, null, 2)}\n`,
  };
  return Object.entries(files).map(([file, data]) => ({
    data,
    encoding: "utf-8",
    file,
  }));
}
