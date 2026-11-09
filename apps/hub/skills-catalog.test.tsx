// @vitest-environment happy-dom
import assert from "node:assert/strict";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilitiesPanel } from "@/components/capabilities-panel";
import {
  type SkillCatalogEntry,
  SkillsCatalog,
} from "@/components/skills-catalog";
import type { Capability, CapabilityInput } from "@/lib/capabilities/types";

const entry: SkillCatalogEntry = {
  description: "Find skills for an agent.",
  id: "vercel-labs/skills/find-skills",
  installs: 24_531,
  name: "find-skills",
  slug: "find-skills",
  source: "vercel-labs/skills",
};
const capabilityInput: CapabilityInput = {
  description: "Find skills for an agent.",
  kind: "skill",
  name: "find-skills",
  skills: [
    {
      content: "Search the catalog before recommending a skill.",
      description: "Find skills.",
      files: { "references/checklist.md": "Check source and scope." },
      name: "find-skills",
    },
  ],
};
const installed: Capability = {
  ...capabilityInput,
  enabled: true,
  id: "cap_1",
  version: null,
};

const flush = async () => {
  await act(async () => {
    // biome-ignore lint/style/noIncrementDecrement: fixture counter is intentionally local to the test scenario.
    for (let index = 0; index < 8; index++) {
      // biome-ignore lint/performance/noAwaitInLoops: fixture operations are intentionally sequential to preserve deterministic ordering.
      await Promise.resolve();
    }
  });
};

let request: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // biome-ignore lint/suspicious/useAwait: test double intentionally preserves the Promise-returning API contract.
  request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    // biome-ignore lint/performance/useTopLevelRegex: test fixture regex is scoped to this mock request shape.
    const path = String(input).replace(/^https?:\/\/[^/]+/u, "");
    const method = (init?.method ?? "GET").toUpperCase();
    if (path.startsWith("/api/skills/search")) {
      return new Response(JSON.stringify({ skills: [entry] }), { status: 200 });
    }
    if (path.startsWith("/api/skills/preview")) {
      return new Response(
        JSON.stringify({
          capability: capabilityInput,
          hash: "hash-1",
          skill: entry,
        }),
        { status: 200 }
      );
    }
    if (path === "/api/skills" && method === "POST") {
      return new Response(JSON.stringify({ capability: installed }), {
        status: 201,
      });
    }
    if (path === "/api/capabilities" && method === "GET") {
      return new Response(JSON.stringify({ capabilities: [] }), {
        status: 200,
      });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", request);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("skills catalog", () => {
  it("retries a failed preview without replacing it with another search", async () => {
    const success = request.getMockImplementation();
    assert(success);
    let previewCalls = 0;
    request.mockImplementation(
      // biome-ignore lint/suspicious/useAwait: test double intentionally preserves the Promise-returning API contract.
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (
          String(input).startsWith("/api/skills/preview") &&
          // biome-ignore lint/style/noIncrementDecrement: fixture counter is intentionally local to the test scenario.
          ++previewCalls === 1
        ) {
          return Response.json(
            { error: "Preview unavailable." },
            { status: 503 }
          );
        }
        return success(input, init);
      }
    );
    render(<SkillsCatalog onInstalled={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Search skills.sh"), {
      target: { value: "find" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Review skill" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(screen.getByRole("button", { name: "Install skill" })).toBeTruthy();
    expect(
      request.mock.calls.filter((call) =>
        String(call[0]).startsWith("/api/skills/search")
      )
    ).toHaveLength(1);
    expect(previewCalls).toBe(2);
  });
  it("searches, previews instructions and files, then installs only id and hash", async () => {
    const onInstalled = vi.fn();
    render(<SkillsCatalog onInstalled={onInstalled} />);
    fireEvent.change(screen.getByPlaceholderText("Search skills.sh"), {
      target: { value: "find" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await flush();
    expect(screen.getByText("find-skills")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Open find-skills on skills.sh" })
        .getAttribute("href")
    ).toBe("https://skills.sh/vercel-labs/skills/find-skills");
    fireEvent.click(screen.getByRole("button", { name: "Review skill" }));
    await flush();
    expect(
      screen.getByText("Search the catalog before recommending a skill.")
    ).toBeTruthy();
    expect(screen.getByText("references/checklist.md")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install skill" }));
    await flush();
    expect(request).toHaveBeenCalledWith(
      "/api/skills",
      expect.objectContaining({
        body: JSON.stringify({ hash: "hash-1", id: entry.id }),
        method: "POST",
      })
    );
    const installCall = request.mock.calls.find(
      (call: unknown[]) => String(call[0]) === "/api/skills"
    );
    expect(
      String((installCall?.[1] as RequestInit | undefined)?.body)
    ).not.toContain("Search the catalog");
    expect(onInstalled).toHaveBeenCalledWith(installed, undefined);
  });

  it("shows a stale-preview error on hash conflict without retrying silently", async () => {
    request.mockImplementation(
      // biome-ignore lint/suspicious/useAwait: test double intentionally preserves the Promise-returning API contract.
      async (input: RequestInfo | URL, init?: RequestInit) => {
        // biome-ignore lint/performance/useTopLevelRegex: test fixture regex is scoped to this mock request shape.
        const path = String(input).replace(/^https?:\/\/[^/]+/u, "");
        const method = (init?.method ?? "GET").toUpperCase();
        if (path.startsWith("/api/skills/search")) {
          return new Response(JSON.stringify({ skills: [entry] }), {
            status: 200,
          });
        }
        if (path.startsWith("/api/skills/preview")) {
          return new Response(
            JSON.stringify({
              capability: capabilityInput,
              hash: "old",
              skill: entry,
            }),
            { status: 200 }
          );
        }
        if (method === "POST") {
          return new Response(JSON.stringify({ error: "hash mismatch" }), {
            status: 409,
          });
        }
        return new Response("not found", { status: 404 });
      }
    );
    render(<SkillsCatalog onInstalled={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Search skills.sh"), {
      target: { value: "find" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Review skill" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Install skill" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain(
      "changed since you reviewed it"
    );
  });

  it("preserves a local-edit conflict instead of relabeling it as a stale preview", async () => {
    request.mockImplementation(
      // biome-ignore lint/suspicious/useAwait: test double intentionally preserves the Promise-returning API contract.
      async (input: RequestInfo | URL, init?: RequestInit) => {
        // biome-ignore lint/performance/useTopLevelRegex: test fixture regex is scoped to this mock request shape.
        const path = String(input).replace(/^https?:\/\/[^/]+/u, "");
        const method = (init?.method ?? "GET").toUpperCase();
        if (path.startsWith("/api/skills/search")) {
          return new Response(JSON.stringify({ skills: [entry] }), {
            status: 200,
          });
        }
        if (path.startsWith("/api/skills/preview")) {
          return new Response(
            JSON.stringify({
              capability: capabilityInput,
              hash: "old",
              skill: entry,
            }),
            { status: 200 }
          );
        }
        if (method === "POST") {
          return new Response(
            JSON.stringify({
              error:
                "This skill has local edits; review them before reinstalling.",
            }),
            { status: 409 }
          );
        }
        return new Response("not found", { status: 404 });
      }
    );
    render(<SkillsCatalog onInstalled={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Search skills.sh"), {
      target: { value: "find" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Review skill" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Install skill" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("local edits");
    expect(screen.getByRole("alert").textContent).not.toContain(
      "changed since you reviewed it"
    );
  });

  it("keeps find-skills visible as an included builtin when there are no custom skills", async () => {
    render(<CapabilitiesPanel kind="skill" />);
    await flush();
    const builtin = screen.getByText("find-skills").closest("li");
    assert(builtin);
    expect(within(builtin).getByText("Included")).toBeTruthy();
    expect(within(builtin).queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Browse skills.sh" }));
    expect(screen.getByPlaceholderText("Search skills.sh")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Your skills" }));
    expect(screen.getByText("find-skills")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add skill" })).toBeTruthy();
  });
});
