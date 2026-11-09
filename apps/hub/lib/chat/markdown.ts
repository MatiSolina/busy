// Shared by the server and the Markdown worker; never imported by the UI runtime.
import type { Root } from "hast";
import type { Root as MarkdownRoot } from "mdast";
import { harden } from "rehype-harden";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";

function codeMeta() {
  return (tree: MarkdownRoot) => {
    visit(tree, "code", (node) => {
      if (node.meta) {
        node.data ??= {};
        node.data.hProperties = {
          ...node.data.hProperties,
          metastring: node.meta,
        };
      }
    });
  };
}

// Match Streamdown 2.7.1's default static pipeline, including its URL hardening.
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(codeMeta)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, {
    ...defaultSchema,
    attributes: {
      ...defaultSchema.attributes,
      code: [...(defaultSchema.attributes?.code ?? []), "metastring"],
    },
    clobberPrefix: "",
    protocols: {
      ...defaultSchema.protocols,
      href: [...(defaultSchema.protocols?.href ?? []), "tel", "streamdown"],
      src: [...(defaultSchema.protocols?.src ?? []), "streamdown"],
    },
  })
  .use(harden, {
    allowDataImages: true,
    allowedImagePrefixes: ["*"],
    allowedLinkPrefixes: ["*"],
    allowedProtocols: ["*"],
  });

const cache = new Map<string, Root>();
let cachedCharacters = 0;
const MAX_CACHED_CHARACTERS = 1_000_000;
const MAX_CACHED_MESSAGES = 512;

export function parseMarkdown(text: string): Root {
  const hit = cache.get(text);
  if (hit) {
    cache.delete(text);
    cache.set(text, hit);
    return hit;
  }
  const parsed = processor.runSync(processor.parse(text)) as Root;
  // Source positions are useful during authoring, but unnecessarily enlarge
  // RSC payloads and worker messages. Keep the parsed document immutable.
  const tree = JSON.parse(
    JSON.stringify(parsed, (key, value) =>
      key === "position" ? undefined : value
    )
  ) as Root;
  if (text.length <= MAX_CACHED_CHARACTERS) {
    cache.set(text, tree);
    cachedCharacters += text.length;
    while (
      cache.size > MAX_CACHED_MESSAGES ||
      cachedCharacters > MAX_CACHED_CHARACTERS
    ) {
      const first = cache.keys().next().value;
      if (first === undefined) {
        break;
      }
      cachedCharacters -= first.length;
      cache.delete(first);
    }
  }
  return tree;
}
