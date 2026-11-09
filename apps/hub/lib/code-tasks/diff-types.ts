export interface CodeTaskDiffFile {
  additions: number;
  deletions: number;
  patch: string | null;
  path: string;
  previousPath?: string;
  status: string;
}

export interface CodeTaskDiff {
  files: CodeTaskDiffFile[];
  source: "workspace" | "github";
  truncated: boolean;
}
