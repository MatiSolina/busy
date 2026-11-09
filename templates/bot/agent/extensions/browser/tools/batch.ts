import { buildAgentBrowserCommand } from "@agent-browser/eve/sandbox";
import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import {
  BROWSER_BATCH_DEFAULT_OUTPUT_CHARS,
  BROWSER_BATCH_MODEL_OUTPUT_CHARS,
  type BrowserBatchInput,
  type BrowserBatchResult,
  boundBrowserBatchForModel,
  browserBatchInputSchema,
  dataUrlParts,
  imageDataUrls,
} from "../../../lib/browser-batch";

const MAX_INLINE_SCREENSHOT_BYTES = 4 * 1024 * 1024;

function lastJson(stdout: string): unknown {
  const line = stdout.trim().split("\n").at(-1);
  if (!line) {
    return;
  }
  try {
    return JSON.parse(line);
  } catch {
    // The wrapper writes one JSON object per invocation; malformed output is handled by the caller.
  }
}

interface BatchError {
  readonly code: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function errorCode(candidate: Record<string, unknown>): string | undefined {
  const { code, error } = candidate;
  if (typeof code === "string" && code.length > 0) {
    return code;
  }
  const nested = record(error)?.code;
  return typeof nested === "string" && nested.length > 0 ? nested : undefined;
}

function errorMessage(candidate: Record<string, unknown>): string {
  const { error } = candidate;
  if (typeof error === "string") {
    return error;
  }
  const nested = record(error)?.message;
  return typeof nested === "string"
    ? nested
    : "The browser batch wrapper rejected the request.";
}

function structuredError(value: unknown): BatchError | null {
  const root = record(value);
  if (!root) {
    return null;
  }
  const structured = record(root.structuredContent);
  const candidates = [root, record(structured?.response)].filter(
    (candidate): candidate is Record<string, unknown> => candidate !== null
  );
  for (const candidate of candidates) {
    const code = errorCode(candidate);
    if (code) {
      return { code, message: errorMessage(candidate).slice(0, 512) };
    }
  }
  return null;
}

function asBatchResult(
  value: unknown,
  input: BrowserBatchInput,
  stderr: string
): BrowserBatchResult {
  if (
    value &&
    typeof value === "object" &&
    "success" in value &&
    Array.isArray((value as { results?: unknown }).results)
  ) {
    return value as BrowserBatchResult;
  }
  const wrapperError = structuredError(value);
  if (wrapperError) {
    return {
      attemptedCount: 0,
      error: wrapperError,
      executedCount: 0,
      finalSnapshotOk: false,
      partialSideEffects: false,
      recovery:
        "The wrapper rejected the batch; do not replay actions. Fix the browser state or base image first.",
      requestedCount: input.actions.length,
      results: [],
      stoppedReason: "wrapper_error",
      success: false,
    };
  }
  return {
    attemptedCount: 0,
    error: {
      code: "BROWSER_BATCH_UNSUPPORTED",
      message:
        "The bot base image does not expose the declarative browser batch wrapper; do not replay actions. " +
        (stderr.trim().slice(0, 512) ||
          "Publish the updated bot-base image before enabling browser__batch."),
    },
    executedCount: 0,
    finalSnapshotOk: false,
    partialSideEffects: false,
    recovery:
      "Take a fresh browser__snapshot before retrying; no action status was returned.",
    requestedCount: input.actions.length,
    results: [],
    stoppedReason: "invalid_response",
    success: false,
  };
}

interface BinarySandbox {
  readBinaryFile?: (options: { path: string }) => Promise<Uint8Array | null>;
}

async function attachScreenshotData(
  result: BrowserBatchResult,
  sandbox: unknown
): Promise<BrowserBatchResult> {
  const readBinaryFile = (sandbox as BinarySandbox | null)?.readBinaryFile;
  if (!readBinaryFile) {
    return result;
  }
  const steps = result.results.map((step) => ({ ...step }));
  const candidates = steps.flatMap((step, index) => {
    if (
      step.action !== "screenshot" ||
      !step.data ||
      typeof step.data !== "object"
    ) {
      return [];
    }
    const { path } = step.data as { path?: unknown };
    if (
      typeof path !== "string" ||
      !(path.startsWith("/data/") || path.startsWith("/workspace/")) ||
      path.split("/").includes("..")
    ) {
      return [];
    }
    return [{ index, path }];
  });
  const files = await Promise.all(
    candidates.map(async ({ index, path }) => {
      try {
        const bytes = await readBinaryFile({ path });
        if (
          !bytes ||
          bytes.length === 0 ||
          bytes.length > MAX_INLINE_SCREENSHOT_BYTES
        ) {
          return null;
        }
        const mediaType =
          path.toLowerCase().endsWith(".jpg") ||
          path.toLowerCase().endsWith(".jpeg")
            ? "image/jpeg"
            : "image/png";
        const data = Buffer.from(bytes).toString("base64");
        return { imageDataUrl: `data:${mediaType};base64,${data}`, index };
      } catch {
        // The path remains in the full result and is enough for the user to retrieve it.
        return null;
      }
    })
  );
  for (const file of files) {
    if (!file) {
      continue;
    }
    const step = steps[file.index];
    steps[file.index] = {
      ...step,
      data: {
        ...(step.data as Record<string, unknown>),
        imageDataUrl: file.imageDataUrl,
      },
    };
  }
  return { ...result, results: steps };
}

function cancelledResult(input: BrowserBatchInput): BrowserBatchResult {
  return {
    attemptedCount: 0,
    error: {
      code: "BATCH_CANCELLED",
      message:
        "The browser batch was cancelled; an in-flight action may have taken effect.",
    },
    executedCount: 0,
    finalSnapshotOk: false,
    partialSideEffects: true,
    recovery:
      "Take a fresh browser__snapshot and do not repeat an action whose status is unknown.",
    requestedCount: input.actions.length,
    results: [],
    sideEffectsPossible: true,
    stoppedReason: "cancelled",
    success: false,
  };
}

export default defineTool({
  deferred: true,
  description:
    "Run a short, already-known sequence of safe visible-browser actions in one guarded call. This deferred tool is named `browser__batch`; discover it with `eve__search`, then call it with `eve__tool`. Use only declarative actions such as open, snapshot, click, fill, waits, and navigation; never use this for JavaScript, direct URL reads, arbitrary commands, or uncertain side effects. The full sequence is validated before the first action, stops on the first error, and returns each action status plus a fresh final snapshot.",
  async execute(input, ctx) {
    const sandbox = await ctx.getSandbox();
    if (!sandbox) {
      throw new Error("The browser batch requires an Eve sandbox.");
    }
    const command = buildAgentBrowserCommand(["batch", JSON.stringify(input)], {
      binary: "browser",
      env: {
        AGENT_BROWSER_MAX_OUTPUT: String(
          input.maxOutputChars ?? BROWSER_BATCH_DEFAULT_OUTPUT_CHARS
        ),
      },
      session: "busy-live",
    });
    try {
      const raw = await sandbox.run({ command, signal: ctx.abortSignal });
      return await attachScreenshotData(
        asBatchResult(lastJson(raw.stdout ?? ""), input, raw.stderr ?? ""),
        sandbox
      );
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        return cancelledResult(input);
      }
      throw error;
    }
  },
  inputSchema: browserBatchInputSchema,
  label: {
    start: ({ actions }) => `Run browser batch (${actions.length} actions)`,
  },
  toModelOutput(result) {
    const requested =
      typeof result.limits?.maxOutputChars === "number"
        ? result.limits.maxOutputChars
        : BROWSER_BATCH_MODEL_OUTPUT_CHARS;
    const bounded = boundBrowserBatchForModel(
      result,
      Math.min(BROWSER_BATCH_MODEL_OUTPUT_CHARS, requested)
    );
    const parts = [toolOutputPart.text(JSON.stringify(bounded))];
    for (const dataUrl of imageDataUrls(result)) {
      const file = dataUrlParts(dataUrl);
      if (file) {
        parts.push(
          toolOutputPart.file(file.base64, { mediaType: file.mediaType })
        );
      }
    }
    return parts.length === 1
      ? toolOutput.json(bounded)
      : toolOutput.content(parts);
  },
});
