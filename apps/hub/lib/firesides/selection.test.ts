import { describe, expect, it } from "vitest";
import type { AiSettingsSnapshot } from "../ai/types";
import { canonicalModel, chooseGuest } from "./selection";
import { bot } from "./test-helpers";

function settings(
  providers: AiSettingsSnapshot["providers"]
): AiSettingsSnapshot {
  return { onboardingCompleted: true, provider: "chatgpt", providers };
}
const provider = (id: "chatgpt" | "grok", model: string) => ({
  description: "",
  detail: null,
  id,
  label: id,
  learnMoreUrl: null,
  models: [{ id: model, label: model }],
  status: "available" as const,
});
describe("second opinion selection", () => {
  it("recognizes the same model across subscription and Gateway aliases", () => {
    expect(canonicalModel("grok/grok-4.7")).toBe(
      canonicalModel("spacexai/grok-4.7")
    );
    expect(canonicalModel("chatgpt/gpt-6")).toBe(
      canonicalModel("openai/gpt-6")
    );
  });
  it("prefers a ready bot with a genuinely different model", () => {
    const guest = bot("guest", "grok/grok-4.7", "grok");
    expect(
      chooseGuest(
        bot(),
        [bot(), guest],
        settings([
          provider("chatgpt", "chatgpt/gpt-6"),
          provider("grok", "grok/grok-4.7"),
        ])
      )?.bot?.id
    ).toBe(guest.id);
  });
  it("does not choose a disconnected subscription or silently enable Gateway spend", () => {
    const configured = settings([
      { ...provider("grok", "grok/grok-4.7"), status: "not-connected" },
      {
        description: "",
        detail: null,
        id: "gateway",
        label: "Gateway",
        learnMoreUrl: null,
        status: "available",
      },
    ]);
    expect(chooseGuest(bot(), [bot()], configured)).toBeNull();
  });
  it("can use two different models from the same subscription", () => {
    const p = provider("chatgpt", "chatgpt/gpt-6");
    p.models.push({ id: "chatgpt/gpt-6-mini", label: "Mini" });
    expect(chooseGuest(bot(), [bot()], settings([p]))).toMatchObject({
      billing: "chatgpt",
      model: "chatgpt/gpt-6-mini",
    });
  });
  it.each(["gateway", "token-pass"] as const)(
    "uses only a configured %s provider",
    (billing) => {
      const primary = bot("primary", "moonshotai/kimi-k3", billing);
      const configured = settings([
        {
          description: "",
          detail: null,
          id: billing,
          label: billing,
          learnMoreUrl: null,
          status: "available",
        },
      ]);
      const guest = chooseGuest(primary, [primary], configured);
      expect(guest?.billing).toBe(billing);
      expect(canonicalModel(guest?.model ?? "")).not.toBe(
        canonicalModel(primary.model)
      );
    }
  );
});
