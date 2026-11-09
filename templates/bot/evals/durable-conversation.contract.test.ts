import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import agent from "../agent/agent";
import { defined } from "../agent/test-utils";
import requestLogin from "../agent/tools/request_login";
import sendFile from "../agent/tools/send_file";
import cancellation from "./cancellation.eval";
import durableConversation from "./durable-conversation.eval";
import config from "./evals.config";
import hitl from "./human-in-the-loop.eval";

const root = fileURLToPath(new URL("..", import.meta.url));
const instructions = readFileSync(
  join(root, "agent", "instructions.ts"),
  "utf8"
);

describe("durable conversation eval contract", () => {
  it("keeps eval defaults explicit and serialized through eve", () => {
    expect(config).toMatchObject({
      judge: { model: "typesafe-ai/jev" },
      maxConcurrency: 1,
      timeoutMs: 120_000,
    });
    expect(durableConversation).toMatchObject({
      description: expect.stringContaining("delegates"),
      tags: expect.arrayContaining(["real-model", "durability"]),
      test: expect.any(Function),
    });
    expect(hitl).toMatchObject({
      description: expect.stringContaining("native interaction"),
      tags: expect.arrayContaining(["human-in-the-loop"]),
      test: expect.any(Function),
    });
    expect(cancellation).toMatchObject({
      description: expect.stringContaining("cancels"),
      tags: expect.arrayContaining(["cancellation"]),
      test: expect.any(Function),
    });
  });

  it("retains eve's durable session and run retention contract", () => {
    const value = agent as {
      limits?: { sessionTimeoutMs?: number };
      experimental?: unknown;
    };
    expect(value.limits?.sessionTimeoutMs).toBeGreaterThanOrEqual(
      365 * 24 * 60 * 60 * 1000
    );
    expect(value.experimental).toEqual({ workflow: { retention: "default" } });
  });

  it("validates the authored agent, file handoff boundary, and HITL schema", async () => {
    const eveCore = new URL(
      "../node_modules/eve/dist/src/internal/authored-definition/core.js",
      import.meta.url
    );
    const { normalizeAgentDefinition } = (await import(eveCore.href)) as {
      normalizeAgentDefinition: (value: unknown, label: string) => unknown;
    };
    expect(() => normalizeAgentDefinition(agent, "agent.ts")).not.toThrow();

    const resolver = (value: unknown) => {
      const symbols = Object.getOwnPropertySymbols(value as object);
      const key = symbols.find(
        (symbol) =>
          typeof (value as unknown as Record<symbol, unknown>)[symbol] ===
          "function"
      );
      return key === undefined
        ? value
        : defined(
            (value as unknown as Record<symbol, (ctx: unknown) => unknown>)[
              defined(key)
            ]
          )({
            session: {
              auth: {
                current: { principalId: "hub", principalType: "app" },
                initiator: null,
              },
              id: "eval-session",
              parent: undefined,
            },
          });
    };
    expect(resolver(sendFile)).toMatchObject({ execute: expect.any(Function) });
    expect(resolver(sendFile)).toBeDefined();
    const childKey = Object.getOwnPropertySymbols(sendFile as object).find(
      (symbol) =>
        typeof (sendFile as unknown as Record<symbol, unknown>)[symbol] ===
        "function"
    );
    const child = (
      sendFile as unknown as Record<symbol, (ctx: unknown) => unknown>
    )[defined(childKey)]({
      session: {
        auth: {
          current: { principalId: "hub", principalType: "app" },
          initiator: null,
        },
        id: "child-session",
        parent: { callId: "call-1" },
      },
    });
    expect(child).toBeNull();

    const login = requestLogin as unknown as {
      inputSchema: {
        "~standard": {
          validate: (
            input: unknown
          ) => Promise<{ issues?: readonly unknown[] }>;
        };
      };
    };
    const valid = await login.inputSchema["~standard"].validate({
      site: "the portal",
      task: "download the report",
    });
    const invalid = await login.inputSchema["~standard"].validate({
      site: "the portal",
      task: "",
    });
    expect(valid.issues).toBeUndefined();
    expect(invalid.issues?.length).toBeGreaterThan(0);
    expect(instructions).toContain("request_login");
  });

  it("keeps the semantic judge separate from deterministic gates", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./durable-conversation.eval.ts", import.meta.url)),
      "utf8"
    );
    expect(source).toContain("expectOk()");
    expect(source).toContain("eventsSatisfy");
    expect(source).toContain("calledAgent");
    expect(source).toContain(".soft()");
    expect(source).toContain("t.judge(");
  });
});
