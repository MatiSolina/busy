// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMarkdown } from "@/lib/chat/markdown";
import { renderMarkdown } from "@/lib/chat/markdown-stream";
import { decodeMarkdown, encodeMarkdown } from "@/lib/chat/markdown-transport";
import { MessageMarkdown } from "./message-markdown";
import { PreparedMarkdown } from "./prepared-markdown";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const fixtures = [
  "",
  "Hello **world**, *emphasis* and ~~removed~~.",
  "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six",
  "- one\n  - nested\n- two\n\n3. three\n4. four",
  "> A quotation\n>\n> another paragraph\n\n---\n\nline  \nbreak",
  "- [x] done\n- [ ] pending",
  "| Left | Right |\n| :--- | ---: |\n| one | **two** |",
  "Inline `const a = 1` and a fence:\n\n```ts title=demo.ts\nconst answer = 42;\n```",
  "```mermaid\ngraph TD; A-->B;\n```",
  "[Site](https://example.org) and <https://example.org> and hello@example.org",
  "![Description](https://example.org/image.png)",
  "<details><summary>Details</summary><strong>Contents</strong></details>",
  "<sup>up</sup> <sub>down</sub> <br> next",
  "Footnote[^one].\n\n[^one]: The note.",
  "**Unfinished and [link](https://example.org",
  "مرحبا **عالم**\n\nUnicode 🙂 café",
  '<script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">bad</a>',
];

function canonical(markup: string) {
  const container = document.createElement("div");
  container.innerHTML = markup;
  const normalize = (node: Node): unknown => {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }
    if (!(node instanceof Element)) {
      return null;
    }
    return {
      attributes: Object.fromEntries(
        Array.from(node.attributes)
          .filter((attribute) => attribute.name !== "data-markdown-renderer")
          .map((attribute) => [
            attribute.name,
            attribute.value.replaceAll(/_R_[\w]+_/gu, "_REACT_ID_"),
          ])
          .sort(([left], [right]) => left.localeCompare(right))
      ),
      children: Array.from(node.childNodes)
        .map(normalize)
        .filter((child) => child !== null),
      tag: node.tagName,
    };
  };
  return Array.from(container.childNodes)
    .map(normalize)
    .filter((child) => child !== null);
}

describe("prepared Markdown parity", () => {
  it("renders the serialized server tree without waiting for the worker", () => {
    const text = "**Ready** before live parsing starts.";
    render(
      <MessageMarkdown
        prepared={encodeMarkdown(parseMarkdown(text), text)}
        streaming={false}
        text={text}
      />
    );
    expect(screen.getByText("Ready")).toBeDefined();
    expect(document.querySelector("[data-markdown-loading]")).toBeNull();
  });
  it("copies code through the original interactive control", async () => {
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(
      <PreparedMarkdown
        tree={parseMarkdown("```ts\nconst answer = 42;\n```")}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy Code" }));
    await waitFor(() =>
      expect(copy).toHaveBeenCalledWith("const answer = 42;\n")
    );
  });

  it("keeps the code copy control disabled during streaming", () => {
    const result = renderMarkdown("```ts\nconst answer =", true);
    render(
      <PreparedMarkdown
        blocks={result.blocks}
        hideCaret={result.hideCaret}
        streaming
      />
    );
    expect(
      screen.getByRole("button", { name: "Copy Code" }).hasAttribute("disabled")
    ).toBe(true);
  });

  it("opens the external-link confirmation before navigation", async () => {
    render(
      <PreparedMarkdown tree={parseMarkdown("[Site](https://example.org)")} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Site" }));
    await screen.findByText("Open external link?");
    expect(screen.getByText("https://example.org/")).toBeDefined();
    expect(screen.getByRole("button", { name: "Open link" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByText("Open external link?")).toBeNull()
    );
  });

  it.each([
    "",
    "**Hel",
    "[Link](https://example.or",
    "![Image](",
    "```ts\nconst a =",
    "| A | B |\n| --- | --- |\n| hello |",
    "Text\n\n- first\n- second",
    "<details><summary>Open</summary>Content",
  ])("matches streaming markup for %s", (text) => {
    const result = renderMarkdown(text, true);
    const expected = renderToStaticMarkup(
      <Streamdown
        caret="block"
        isAnimating
        mode="streaming"
        parseIncompleteMarkdown
      >
        {text}
      </Streamdown>
    );
    const actual = renderToStaticMarkup(
      <PreparedMarkdown
        blocks={result.blocks}
        hideCaret={result.hideCaret}
        streaming
      />
    );
    expect(canonical(actual)).toEqual(canonical(expected));
  });
  it.each(fixtures)("matches the existing rich renderer for %s", (text) => {
    const expected = renderToStaticMarkup(
      <Streamdown mode="static" parseIncompleteMarkdown={false}>
        {text}
      </Streamdown>
    );
    const actual = renderToStaticMarkup(
      <PreparedMarkdown
        tree={decodeMarkdown(encodeMarkdown(parseMarkdown(text), text), text)}
      />
    );
    expect(canonical(actual)).toEqual(canonical(expected));
  });

  it("keeps scripts, event handlers and javascript URLs out of prepared output", () => {
    const text =
      '<script>bad()</script><img src="x" onerror="bad()"><a href="javascript:bad()">bad</a>';
    const output = renderToStaticMarkup(
      <PreparedMarkdown tree={parseMarkdown(text)} />
    );
    expect(output).not.toContain("<script");
    expect(output).not.toContain("onerror=");
    expect(output).not.toContain('href="javascript:');
  });
});
