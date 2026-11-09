import type { Root } from "hast";

export interface MarkdownBlock {
  incomplete: boolean;
  offset: number;
  tree: Root;
}
export interface MarkdownResult {
  blocks: MarkdownBlock[];
  hideCaret: boolean;
}
export interface MarkdownRequest {
  id: number;
  streaming: boolean;
  text: string;
}
export type MarkdownResponse =
  | { id: number; result: MarkdownResult }
  | { error: string; id: number };
