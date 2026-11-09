import type { Root } from "hast";
import { expect, it as test } from "vitest";
import { parseMarkdown } from "./markdown";
import { decodeMarkdown, encodeMarkdown } from "./markdown-transport";

test("reduces real parser output while preserving its root metadata", () => {
  const tree = parseMarkdown("# Title\n\nHello **world**\n\n- one\n- two");
  const encoded = encodeMarkdown(tree);
  expect(encoded.length).toBeLessThan(JSON.stringify(tree).length * 0.6);
  expect(decodeMarkdown(encoded)).toEqual(tree);
});

test("preserves uncommon nodes, plugin data and legacy trees", () => {
  const tree: Root = {
    children: [
      { type: "comment", value: "note" },
      { data: { meaning: "greeting" }, type: "text", value: "hello" },
      {
        children: [],
        data: {},
        properties: { className: ["first", "second"] },
        tagName: "p",
        type: "element",
      },
    ],
    data: { quirksMode: false },
    type: "root",
  };
  expect(decodeMarkdown(encodeMarkdown(tree))).toEqual(tree);
  expect(decodeMarkdown(JSON.stringify(tree))).toEqual(tree);
});

test("sends verbatim text as source offsets and restores the exact tree", () => {
  const text = [
    "## Paso 1: revisar la configuración",
    "",
    'It\'s the "snapshot" route — revisá `cacheTag("bot:slug")` y [docs](https://nextjs.org/docs?a=1&b=2).',
    "",
    "- primero, con **negrita** y _énfasis_",
    "- después &amp; entidades <b>raw</b>",
    "",
    "```ts",
    'const greeting = "hola";',
    "```",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
  ].join("\n");
  const tree = parseMarkdown(text);
  const encoded = encodeMarkdown(tree, text);
  expect(decodeMarkdown(encoded, text)).toEqual(tree);
  expect(encoded).not.toContain("revisar la configuración");
  expect(encoded.length).toBeLessThan(encodeMarkdown(tree).length * 0.9);
});

test("refuses a source other than the one the tree was encoded against", () => {
  const text = "A paragraph long enough to travel as offsets.";
  const encoded = encodeMarkdown(parseMarkdown(text), text);
  expect(decodeMarkdown(encoded, `${text}!`)).toBeUndefined();
});
