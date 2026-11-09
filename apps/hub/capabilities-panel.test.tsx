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
import type { Capability } from "@/lib/capabilities/types";

const capability = (over: Partial<Capability> = {}): Capability => ({
  description: "Review contracts.",
  enabled: true,
  id: "cap_1",
  kind: "skill",
  name: "review-contract",
  skills: [
    {
      content: "Read the text.",
      description: "When reviewing",
      files: { "references/checklist.md": "Check parties." },
      name: "review",
    },
  ],
  version: null,
  ...over,
});

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
  request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      return new Response(JSON.stringify({ capabilities: [capability()] }), {
        status: 200,
      });
    }
    if (method === "POST") {
      return new Response(
        JSON.stringify({
          capability: capability({ id: "cap_2", name: "new-skill" }),
        }),
        { status: 201 }
      );
    }
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as { enabled?: boolean };
      return new Response(
        JSON.stringify({
          capability: capability({ enabled: body.enabled ?? true }),
        }),
        { status: 200 }
      );
    }
    if (method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", request);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("capabilities panel", () => {
  it("loads, searches and preserves imported supporting-file metadata while editing", async () => {
    render(<CapabilitiesPanel kind="skill" />);
    await flush();
    expect(screen.getByText("review-contract")).toBeTruthy();
    expect(screen.getByText("1 skill")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Search skills"), {
      target: { value: "missing" },
    });
    // biome-ignore lint/performance/useTopLevelRegex: test fixture regex is scoped to this mock request shape.
    expect(screen.getByText(/No skills match/u)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Search skills"), {
      target: { value: "review" },
    });
    const row = screen.getByText("review-contract").closest("li");
    assert(row);
    // biome-ignore lint/performance/useTopLevelRegex: test fixture regex is scoped to this mock request shape.
    fireEvent.click(within(row).getByRole("button", { name: /Edit/u }));
    expect(
      screen.getByText("1 supporting files preserved from the import.")
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "Updated instructions." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await flush();
    expect(request).toHaveBeenCalledWith(
      "/api/capabilities/cap_1",
      expect.objectContaining({ method: "PATCH" })
    );
  });

  it("creates manually, toggles only after the server responds, and requires two clicks to remove", async () => {
    render(<CapabilitiesPanel kind="skill" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Create skill" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "new-skill" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Do the new thing." },
    });
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "Follow these steps." },
    });
    const addButton = screen
      .getAllByRole("button", { name: "Add skill" })
      .at(-1);
    assert(addButton);
    fireEvent.click(addButton);
    await flush();
    expect(request).toHaveBeenCalledWith(
      "/api/capabilities",
      expect.objectContaining({ method: "POST" })
    );
    const post = request.mock.calls.find(
      (call: unknown[]) =>
        ((call[1] as RequestInit | undefined)?.method ?? "GET") === "POST"
    );
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      name: "new-skill",
      skills: [
        {
          content: "Follow these steps.",
          description: "Do the new thing.",
          name: "new-skill",
        },
      ],
    });

    const toggle = screen.getByRole("switch", {
      // biome-ignore lint/performance/useTopLevelRegex: test fixture regex is scoped to this mock request shape.
      name: /Disable review-contract/u,
    });
    fireEvent.click(toggle);
    await flush();
    expect(request).toHaveBeenCalledWith(
      "/api/capabilities/cap_1",
      expect.objectContaining({ method: "PATCH" })
    );

    const row = screen.getByText("review-contract").closest("li");
    assert(row);
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    expect(
      within(row).getByRole("button", { name: "Remove for good?" })
    ).toBeTruthy();
    expect(screen.getByText("review-contract")).toBeTruthy();
    fireEvent.click(
      within(row).getByRole("button", { name: "Remove for good?" })
    );
    await flush();
    expect(request).toHaveBeenCalledWith("/api/capabilities/cap_1", {
      method: "DELETE",
    });
  });

  it("reports a load failure with a retry action", async () => {
    request.mockImplementation(
      async () => new Response("offline", { status: 503 })
    );
    render(<CapabilitiesPanel kind="plugin" />);
    await flush();
    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn't load capabilities"
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("keeps discovery and imports inside a single add menu", async () => {
    render(<CapabilitiesPanel kind="skill" />);
    await flush();
    expect(screen.queryByRole("button", { name: "Installed" })).toBeNull();
    expect(screen.queryByText("Import SKILL.md")).toBeNull();
    expect(screen.queryByText("Browse skills.sh")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
    expect(
      screen.getByRole("menuitem", { name: "Browse skills.sh" })
    ).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Create skill" })).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Import SKILL.md" })
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Import folder" })
    ).toBeTruthy();
  });

  it("offers one plugin import action and preserves review before saving", async () => {
    request.mockResolvedValueOnce(Response.json({ capabilities: [] }));
    render(<CapabilitiesPanel kind="plugin" />);
    await flush();
    expect(screen.getAllByRole("button", { name: "Add plugin" })).toHaveLength(
      1
    );
    expect(screen.queryByText("Import folder")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add plugin" }));
    expect(screen.queryByRole("menu")).toBeNull();
    const manifest = new File(
      [
        JSON.stringify({
          description: "Contract skills",
          name: "contract-tools",
        }),
      ],
      "plugin.json",
      { type: "application/json" }
    );
    const skill = new File(
      [
        "---\nname: review\ndescription: Review contracts\n---\nRead the contract.",
      ],
      "SKILL.md",
      { type: "text/markdown" }
    );
    Object.defineProperty(manifest, "webkitRelativePath", {
      value: "contract-tools/.claude-plugin/plugin.json",
    });
    Object.defineProperty(skill, "webkitRelativePath", {
      value: "contract-tools/skills/review/SKILL.md",
    });
    fireEvent.change(screen.getByLabelText("Import plugin folder"), {
      target: { files: [manifest, skill] },
    });
    await flush();
    expect(screen.getByRole("region", { name: "Import preview" })).toBeTruthy();
    expect(request.mock.calls.some((call) => call[1]?.method === "POST")).toBe(
      false
    );
    fireEvent.click(screen.getByRole("button", { name: "Add plugin" }));
    await flush();
    expect(request).toHaveBeenCalledWith(
      "/api/capabilities",
      expect.objectContaining({ method: "POST" })
    );
  });
});
