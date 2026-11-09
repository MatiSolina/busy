import { describe, expect, it, vi } from "vitest";
import {
  chooseCreationModel,
  type DecisionRunner,
  InvalidBotTemplateError,
  resolveBotCreation,
} from "@/lib/bots/creation";
import { botTemplate } from "@/lib/bots/marketplace";

const input = {
  avatar: "violet",
  description: "Reviews contracts and flags material risks.",
  name: "Contract Desk",
};

function decision(choice: unknown): DecisionRunner {
  return vi.fn(async () => ({
    answers: { model: { choice } },
  })) as unknown as DecisionRunner;
}

describe("bot creation model resolution", () => {
  it("offers only Token Pass models to Decision API and accepts a valid choice", async () => {
    const decide = decision("zai/glm-5.3");
    const model = await chooseCreationModel(
      { ...input, instructions: "Use evidence." },
      decide
    );

    expect(model).toBe("zai/glm-5.3");
    const options = (decide as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      state: { availableModels: Array<{ id: string }> };
      questions: { model: { criteria: Record<string, string> } };
    };
    expect(options.state.availableModels.map(({ id }) => id)).toEqual([
      "moonshotai/kimi-k3",
      "zai/glm-5.3",
      "deepseek/deepseek-v4.1-flash",
    ]);
    expect(Object.keys(options.questions.model.criteria)).toEqual(
      options.state.availableModels.map(({ id }) => id)
    );
  });

  it("falls back to Kimi when the decision fails or returns a non-allowlisted model", async () => {
    await expect(
      chooseCreationModel(
        { ...input, instructions: "" },
        vi.fn(() => {
          throw new Error("synthetic gateway failure");
        }) as unknown as DecisionRunner
      )
    ).resolves.toBe("moonshotai/kimi-k3");

    await expect(
      chooseCreationModel(
        { ...input, instructions: "" },
        decision("openai/gpt-6.1-terra")
      )
    ).resolves.toBe("moonshotai/kimi-k3");
  });

  it("resolves a valid catalog template on the server", async () => {
    const template = botTemplate("release-captain");
    expect(template).toBeDefined();
    const resolved = await resolveBotCreation(
      { ...input, templateId: "release-captain" },
      decision("deepseek/deepseek-v4.1-flash")
    );

    expect(resolved).toMatchObject({
      avatar: "violet",
      billing: "token-pass",
      fast: false,
      instructions: template?.instructions,
      model: "deepseek/deepseek-v4.1-flash",
    });
  });

  it("uses an empty instruction set for scratch and rejects an unknown template", async () => {
    const scratch = await resolveBotCreation(
      input,
      decision("moonshotai/kimi-k3")
    );
    expect(scratch.instructions).toBe("");
    await expect(
      resolveBotCreation(
        { ...input, templateId: "not-a-template" },
        decision("moonshotai/kimi-k3")
      )
    ).rejects.toBeInstanceOf(InvalidBotTemplateError);
  });
});
