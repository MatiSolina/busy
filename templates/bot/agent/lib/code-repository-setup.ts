import { z } from "zod";

export const codeRepositorySetupInput = z.strictObject({
  repositoryId: z.uuid().optional(),
  title: z.string().trim().min(1).max(200).optional(),
});

export const codeRepositoryStatus = z
  .strictObject({
    ready: z.boolean(),
    reason: z
      .enum(["connect_github", "select_repository", "reconnect_github"])
      .optional(),
    repository: z
      .strictObject({
        fullName: z.string().min(1),
        id: z.uuid(),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.ready && !value.repository) {
      context.addIssue({
        code: "custom",
        message: "A ready repository status must include a repository.",
        path: ["repository"],
      });
    }
    if (!(value.ready || value.reason)) {
      context.addIssue({
        code: "custom",
        message: "A blocked repository status must include a reason.",
        path: ["reason"],
      });
    }
  });

export type CodeRepositoryStatus = z.infer<typeof codeRepositoryStatus>;

export type CodeRepositoryStatusResult =
  | CodeRepositoryStatus
  | { error: string };

export function isCodeRepositoryStatusError(
  value: CodeRepositoryStatusResult
): value is { error: string } {
  return "error" in value;
}
