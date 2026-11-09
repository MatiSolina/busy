"use client";

import type { Root } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, memo } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import type { StreamdownContextType } from "streamdown";
import {
  defaultComponents,
  IncompleteFenceContext,
  StreamdownContext,
} from "streamdown/ui";
import type { MarkdownBlock } from "@/lib/chat/markdown-protocol";
import { cn } from "@/lib/utils";

const baseContext: StreamdownContextType = {
  codeBlockMaxHeight: 400,
  controls: true,
  isAnimating: false,
  lineNumbers: true,
  linkSafety: { enabled: true },
  mode: "static",
  shikiTheme: ["github-light", "github-dark"],
  tableMaxHeight: 300,
};

const components = { ...defaultComponents };

export const PreparedMarkdown = memo(function PreparedMarkdownContent({
  tree,
  blocks,
  streaming = false,
  hideCaret = false,
}: {
  tree?: Root;
  blocks?: MarkdownBlock[];
  streaming?: boolean;
  hideCaret?: boolean;
}) {
  const render = (root: Root) =>
    toJsxRuntime(root, {
      components,
      Fragment,
      ignoreInvalidStyle: true,
      jsx,
      jsxs,
      passKeys: true,
      passNode: true,
    });
  return (
    <StreamdownContext
      value={
        streaming
          ? { ...baseContext, isAnimating: true, mode: "streaming" }
          : baseContext
      }
    >
      <div
        className={cn(
          "space-y-4 whitespace-normal [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          streaming &&
            !hideCaret &&
            "[&>*:last-child:not([data-sd-caret-hidden])]:after:inline [&>*:last-child:not([data-sd-caret-hidden])]:after:align-baseline [&>*:last-child:not([data-sd-caret-hidden])]:after:content-[var(--streamdown-caret)]"
        )}
        data-markdown-renderer="prepared"
        style={
          streaming
            ? ({ "--streamdown-caret": '" ▋"' } as React.CSSProperties)
            : undefined
        }
      >
        {streaming && blocks?.length === 0 ? <span /> : null}
        {tree
          ? render(tree)
          : blocks?.map((block) => (
              <IncompleteFenceContext
                key={block.offset}
                value={block.incomplete}
              >
                {render(block.tree)}
              </IncompleteFenceContext>
            ))}
      </div>
    </StreamdownContext>
  );
});
