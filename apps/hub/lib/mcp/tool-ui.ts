export interface McpToolUi {
  resourceUri?: string;
  visibility?: ("model" | "app")[];
}

export const MCP_APP_RESULT_KEY = "_busyMcpApp";
const SNAPSHOT_ID =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A marker can nominate a card; the hub still checks the stored provenance. */
export function mcpAppSnapshotId(value: unknown): string | undefined {
  // Eve preserves multimodal MCP results as content blocks, so the proxy adds
  // a separate small text marker instead of dropping the images/resources.
  if (Array.isArray(value)) {
    for (const item of value) {
      const block = record(item);
      if (
        block?.type !== "text" ||
        typeof block.text !== "string" ||
        block.text.length > 256
      ) {
        continue;
      }
      try {
        const id = mcpAppSnapshotId(JSON.parse(block.text));
        if (id) {
          return id;
        }
      } catch {
        // Normal MCP result text is not an app marker.
      }
    }
    return undefined;
  }
  const marker = record(record(value)?.[MCP_APP_RESULT_KEY]);
  return typeof marker?.snapshotId === "string" &&
    SNAPSHOT_ID.test(marker.snapshotId)
    ? marker.snapshotId
    : undefined;
}

/** Persist only the protocol fields needed to render and authorize an app. */
export function toolUiMetadata(meta: unknown): McpToolUi | undefined {
  const metadata = record(meta);
  const ui = record(metadata?.ui);
  const uri = ui?.resourceUri ?? metadata?.["ui/resourceUri"];
  const resourceUri =
    typeof uri === "string" && uri.startsWith("ui://") && uri.length <= 2048
      ? uri
      : undefined;
  const visibility = Array.isArray(ui?.visibility)
    ? ui.visibility.filter(
        (value): value is "model" | "app" =>
          value === "model" || value === "app"
      )
    : undefined;
  if (!(resourceUri || visibility)) {
    return undefined;
  }
  return {
    ...(resourceUri ? { resourceUri } : {}),
    ...(visibility ? { visibility: [...new Set(visibility)] } : {}),
  };
}

export function isModelVisible(ui?: McpToolUi): boolean {
  return ui?.visibility === undefined || ui.visibility.includes("model");
}

export function isAppVisible(ui?: McpToolUi): boolean {
  return ui?.visibility === undefined || ui.visibility.includes("app");
}
