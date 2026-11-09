import { z } from "zod";

/** Keep the model's declarative browser sequences deliberately short. */
export const BROWSER_BATCH_MAX_STEPS = 12;
export const BROWSER_BATCH_DEFAULT_TIME_MS = 30_000;
export const BROWSER_BATCH_MAX_TIME_MS = 120_000;
export const BROWSER_BATCH_DEFAULT_OUTPUT_CHARS = 16_384;
export const BROWSER_BATCH_MAX_OUTPUT_CHARS = 24_000;
export const BROWSER_BATCH_MODEL_OUTPUT_CHARS = 12_000;
export const BROWSER_BATCH_MAX_TEXT_CHARS = 20_000;
export const BROWSER_BATCH_MAX_SELECTOR_CHARS = 512;

const selector = z.string().trim().min(1).max(BROWSER_BATCH_MAX_SELECTOR_CHARS);
const text = z.string().min(1).max(BROWSER_BATCH_MAX_TEXT_CHARS);
const httpUrl = z
  .string()
  .url()
  .max(2048)
  .refine(
    (value) => value.startsWith("http://") || value.startsWith("https://"),
    "only http(s) URLs are allowed"
  );
const timeout = z
  .number()
  .int()
  .min(1)
  .max(BROWSER_BATCH_MAX_TIME_MS)
  .optional();
const withTimeout = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ ...shape, timeoutMs: timeout }).strict();

const browserActions = [
  withTimeout({ action: z.literal("open"), url: httpUrl }),
  withTimeout({ action: z.literal("back") }),
  withTimeout({ action: z.literal("forward") }),
  withTimeout({ action: z.literal("reload") }),
  withTimeout({
    action: z.literal("click"),
    newTab: z.boolean().optional(),
    selector,
  }),
  withTimeout({ action: z.literal("dblclick"), selector }),
  withTimeout({ action: z.literal("fill"), selector, text }),
  withTimeout({
    action: z.literal("type"),
    clear: z.boolean().optional(),
    delayMs: z.number().int().min(0).max(5000).optional(),
    selector,
    text,
  }),
  withTimeout({ action: z.literal("press"), key: z.string().min(1).max(128) }),
  withTimeout({
    action: z.literal("select"),
    selector,
    values: z.array(z.string().min(1).max(1024)).min(1).max(32),
  }),
  withTimeout({ action: z.literal("check"), selector }),
  withTimeout({ action: z.literal("uncheck"), selector }),
  withTimeout({
    action: z.literal("scroll"),
    amount: z.number().int().min(1).max(20_000).optional(),
    direction: z.enum(["up", "down", "left", "right"]).optional(),
    selector: selector.optional(),
  }).refine(
    (value) => value.direction !== undefined || value.amount !== undefined,
    "scroll requires direction or amount"
  ),
  withTimeout({
    action: z.literal("wait_ms"),
    ms: z.number().int().min(0).max(30_000),
  }),
  withTimeout({
    action: z.literal("wait_for_selector"),
    selector,
    waitTimeoutMs: timeout,
  }),
  withTimeout({
    action: z.literal("wait_for_text"),
    text,
    waitTimeoutMs: timeout,
  }),
  withTimeout({
    action: z.literal("wait_for_load"),
    state: z.enum(["load", "domcontentloaded", "networkidle"]),
    waitTimeoutMs: timeout,
  }),
  withTimeout({
    action: z.literal("snapshot"),
    compact: z.boolean().optional(),
    delta: z.boolean().optional(),
    depth: z.number().int().min(1).max(100).optional(),
    full: z.boolean().optional(),
    includeUrls: z.boolean().optional(),
    interactive: z.boolean().optional(),
    selector: selector.optional(),
  }),
  withTimeout({
    action: z.literal("screenshot"),
    annotate: z.boolean().optional(),
    format: z.enum(["png", "jpeg"]).optional(),
    fullPage: z.boolean().optional(),
    ifChanged: z.boolean().optional(),
    path: z
      .string()
      .min(1)
      .max(512)
      .regex(/^\/(?:data|workspace)\//u)
      .refine(
        (value) => !value.split("/").includes(".."),
        "path traversal is not allowed"
      )
      .optional(),
    quality: z.number().int().min(0).max(100).optional(),
    selector: selector.optional(),
    threshold: z.number().min(0).max(1).optional(),
  }),
  withTimeout({ action: z.literal("get_text"), selector }),
  withTimeout({ action: z.literal("get_url") }),
  withTimeout({ action: z.literal("get_title") }),
  withTimeout({
    action: z.literal("tab_new"),
    label: z.string().min(1).max(256).optional(),
    url: httpUrl.optional(),
  }),
  withTimeout({
    action: z.literal("tab_switch"),
    tab: selector,
  }),
  withTimeout({
    action: z.literal("tab_close"),
    tab: selector,
  }),
] as const;

// A union keeps the literal action types while allowing the scroll refinement
// above (which is not a plain discriminated object after `.refine()`). Every
// member is strict, so unknown fields are still rejected before execution.
export const browserBatchActionSchema = z.union(browserActions);

export const browserBatchInputSchema = z
  .object({
    actions: z
      .array(browserBatchActionSchema)
      .min(1)
      .max(BROWSER_BATCH_MAX_STEPS),
    maxOutputChars: z
      .number()
      .int()
      .min(1024)
      .max(BROWSER_BATCH_MAX_OUTPUT_CHARS)
      .default(BROWSER_BATCH_DEFAULT_OUTPUT_CHARS),
    maxSteps: z
      .number()
      .int()
      .min(1)
      .max(BROWSER_BATCH_MAX_STEPS)
      .default(BROWSER_BATCH_MAX_STEPS),
    maxTimeMs: z
      .number()
      .int()
      .min(1)
      .max(BROWSER_BATCH_MAX_TIME_MS)
      .default(BROWSER_BATCH_DEFAULT_TIME_MS),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.actions.length > input.maxSteps) {
      ctx.addIssue({
        code: "custom",
        message: "The full batch exceeds maxSteps; no action will start.",
        path: ["actions"],
      });
    }
  });

export type BrowserBatchInput = z.infer<typeof browserBatchInputSchema>;
export type BrowserBatchAction = BrowserBatchInput["actions"][number];

export interface BrowserBatchStepResult {
  readonly action: string;
  readonly attempted?: boolean;
  readonly data?: unknown;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly [key: string]: unknown;
  };
  readonly executed?: boolean;
  readonly index: number;
  readonly success: boolean;
  readonly truncated?: boolean;
}

export interface BrowserBatchResult {
  readonly attemptedCount?: number;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly [key: string]: unknown;
  };
  readonly executedCount: number;
  readonly finalSnapshot?: unknown;
  readonly finalSnapshotError?: unknown;
  readonly finalSnapshotOk?: boolean;
  readonly limits?: Record<string, unknown>;
  readonly outputLimit?: number;
  readonly partialSideEffects: boolean;
  readonly recovery?: string;
  readonly requestedCount: number;
  readonly results: readonly BrowserBatchStepResult[];
  readonly sideEffectsPossible?: boolean;
  readonly stoppedReason?: string | null;
  readonly success: boolean;
  readonly truncated?: boolean;
  readonly [key: string]: unknown;
}

const MEDIA_KEYS = new Set([
  "imageDataUrl",
  "screenshotBase64",
  "fileData",
  "fileUrl",
]);
const DATA_URL_RE =
  /^data:(?<mediaType>image\/(?:png|jpeg|jpg|webp));base64,(?<data>[A-Za-z0-9+/=]+)$/u;

function clip(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 28))}… [truncated ${value.length - max + 28} chars]`;
}

function safeValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return clip(value, 2000);
  }
  if (depth > 4 || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 64).map((entry) => safeValue(entry, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (MEDIA_KEYS.has(key)) {
      continue;
    }
    output[key] = safeValue(entry, depth + 1);
  }
  return output;
}

function recoveryFor(result: BrowserBatchResult): string {
  if (result.finalSnapshotOk === false) {
    return "The final snapshot failed. Successful or attempted actions may already have taken effect; take a fresh browser__snapshot and do not repeat executed actions.";
  }
  if (result.partialSideEffects || result.success === false) {
    return "The batch stopped after a partial sequence. Review executed action statuses, take a fresh browser__snapshot, and do not repeat successful actions.";
  }
  return "Use the final snapshot as the current page state.";
}

function compactError(value: unknown): BrowserBatchStepResult["error"] {
  if (!value || typeof value !== "object") {
    return value === undefined
      ? undefined
      : { message: clip(String(value), 512) };
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      [
        "code",
        "message",
        "index",
        "action",
        "expectedGeneration",
        "actualGeneration",
      ].includes(key)
    ) {
      output[key] = typeof entry === "string" ? clip(entry, 512) : entry;
    }
  }
  return output;
}

function hasOversizedString(value: unknown): boolean {
  if (typeof value === "string") {
    return value.length > 2000;
  }
  if (Array.isArray(value)) {
    return value.some(hasOversizedString);
  }
  if (value && typeof value === "object") {
    return Object.values(value).some(hasOversizedString);
  }
  return false;
}

/**
 * Projection sent to the model. Channel/hooks still receive the full result,
 * including screenshot paths and inline image data, while this view is bounded.
 */
export function boundBrowserBatchForModel(
  input: BrowserBatchResult,
  limit = BROWSER_BATCH_MODEL_OUTPUT_CHARS
): BrowserBatchResult {
  const sourceTruncated =
    hasOversizedString(input) || JSON.stringify(input).length > limit;
  const base: BrowserBatchResult = {
    attemptedCount: input.attemptedCount,
    error: compactError(input.error),
    executedCount: input.executedCount,
    finalSnapshot: safeValue(input.finalSnapshot),
    finalSnapshotError: compactError(input.finalSnapshotError),
    finalSnapshotOk: input.finalSnapshotOk,
    limits: input.limits,
    partialSideEffects: input.partialSideEffects,
    recovery: recoveryFor(input),
    requestedCount: input.requestedCount,
    results: input.results.map((step) => ({
      action: step.action,
      attempted: step.attempted,
      data: safeValue(step.data),
      error: step.error ? compactError(step.error) : undefined,
      executed: step.executed,
      index: step.index,
      success: step.success,
      truncated: step.truncated,
    })),
    sideEffectsPossible: input.sideEffectsPossible,
    stoppedReason: input.stoppedReason,
    success: input.success,
    truncated: sourceTruncated,
  };
  const fits = (value: BrowserBatchResult) =>
    JSON.stringify(value).length <= limit;
  if (fits(base)) {
    return base;
  }

  const compact: BrowserBatchResult = {
    ...base,
    finalSnapshot: safeValue(input.finalSnapshot, 5),
    outputLimit: limit,
    recovery: `${recoveryFor(input)} Output was truncated; use the statuses and fresh snapshot to recover.`,
    results: base.results.map((step) => ({
      action: step.action,
      attempted: step.attempted,
      error: compactError(step.error),
      executed: step.executed,
      index: step.index,
      success: step.success,
    })),
    truncated: true,
  };
  if (fits(compact)) {
    return compact;
  }

  const fallback: BrowserBatchResult = {
    attemptedCount: input.attemptedCount,
    executedCount: input.executedCount,
    finalSnapshotOk: input.finalSnapshotOk,
    outputLimit: limit,
    partialSideEffects: input.partialSideEffects,
    recovery: `${recoveryFor(input)} Output was truncated; use the statuses and fresh snapshot to recover.`,
    requestedCount: input.requestedCount,
    results: input.results.map(
      ({ index, action, success, executed, attempted, error }) => ({
        action,
        attempted,
        error: compactError(error),
        executed,
        index,
        success,
      })
    ),
    stoppedReason: input.stoppedReason,
    success: input.success,
    truncated: true,
  };
  while (
    JSON.stringify(fallback).length > limit &&
    fallback.results.length > 1
  ) {
    (fallback.results as BrowserBatchStepResult[]).pop();
  }
  if (JSON.stringify(fallback).length > limit) {
    return {
      executedCount: input.executedCount,
      finalSnapshotOk: input.finalSnapshotOk,
      outputLimit: limit,
      partialSideEffects: input.partialSideEffects,
      recovery: "Output truncated; take a fresh snapshot before recovery.",
      requestedCount: input.requestedCount,
      results: [],
      success: input.success,
      truncated: true,
    };
  }
  return fallback;
}

export function imageDataUrls(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string" && value.startsWith("data:image/")) {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      imageDataUrls(item, output);
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      imageDataUrls(item, output);
    }
  }
  return output.slice(0, 3);
}

export function dataUrlParts(
  dataUrl: string
): { readonly base64: string; readonly mediaType: string } | null {
  const match = DATA_URL_RE.exec(dataUrl);
  if (!(match?.groups?.data && match.groups.mediaType)) {
    return null;
  }
  return {
    base64: match.groups.data,
    mediaType:
      match.groups.mediaType === "image/jpg"
        ? "image/jpeg"
        : match.groups.mediaType,
  };
}
