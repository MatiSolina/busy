import { describe, expect, it } from "vitest";
import { buildBotFiles, rolloutFlags } from "./files";

const config = (files: ReturnType<typeof buildBotFiles>) =>
  JSON.parse(files.find((f) => f.file === "agent/config.json")?.data ?? "{}");

const base = {
  description: "Contracts.",
  fast: false,
  instructions: "",
  model: "moonshotai/kimi-k3",
  name: "Lawyer",
  slug: "lawyer",
};

describe("per-bot rollout flags", () => {
  it("adds nothing for unlisted bots, so config.json is unchanged", () => {
    expect(rolloutFlags("lawyer", {})).toEqual({});
    expect(
      rolloutFlags("lawyer", {
        LAZY_TOOLS_BOTS: "qa-1,qa-2",
      })
    ).toEqual({});
    expect(
      config(buildBotFiles({ ...base, ...rolloutFlags("lawyer", {}) }))
    ).toEqual(base);
  });

  it("enables lazy tools for listed slugs or *", () => {
    expect(rolloutFlags("qa-2", { LAZY_TOOLS_BOTS: "qa-1, qa-2" })).toEqual({
      lazyTools: true,
    });
    expect(rolloutFlags("any", { LAZY_TOOLS_BOTS: "*" })).toEqual({
      lazyTools: true,
    });
    expect(rolloutFlags("qa", { LAZY_TOOLS_BOTS: "qa-1" })).toEqual({});
  });

  it("writes the LAZY_TOOLS_LEVEL level, on by default", () => {
    const env = (level?: string) => ({
      LAZY_TOOLS_BOTS: "qa-1",
      LAZY_TOOLS_LEVEL: level,
    });
    expect(rolloutFlags("qa-1", env("core"))).toEqual({ lazyTools: "core" });
    expect(rolloutFlags("qa-1", env("on"))).toEqual({ lazyTools: true });
    expect(rolloutFlags("qa-1", env("bogus"))).toEqual({ lazyTools: true });
    expect(rolloutFlags("qa-2", env("core"))).toEqual({});
    expect(
      config(buildBotFiles({ ...base, ...rolloutFlags("qa-1", env("core")) }))
    ).toEqual({ ...base, lazyTools: "core" });
  });
});
