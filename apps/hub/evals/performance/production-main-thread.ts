import type { CDPSession, Page } from "@playwright/test";

export interface MainThreadController {
  baselineTaskDurationMs: number | null;
  session: CDPSession | null;
  supported: boolean;
}

export interface MainThreadSnapshot {
  supported: boolean;
  taskDurationDeltaMs: number | null;
}

const EMPTY_SNAPSHOT: MainThreadSnapshot = {
  supported: false,
  taskDurationDeltaMs: null,
};

async function taskDurationMs(
  session: CDPSession | null
): Promise<number | null> {
  if (!session) {
    return null;
  }
  try {
    const response = (await session.send("Performance.getMetrics")) as {
      metrics?: Array<{ name?: unknown; value?: unknown }>;
    };
    const metric = response.metrics?.find(
      (item) => item.name === "TaskDuration"
    );
    return typeof metric?.value === "number" && Number.isFinite(metric.value)
      ? metric.value * 1000
      : null;
  } catch {
    return null;
  }
}

/** Enables the Chromium Performance domain without retaining page content. */
export async function installMainThreadDiagnostics(
  page: Page
): Promise<MainThreadController> {
  try {
    const session = await page.context().newCDPSession(page);
    await session.send("Performance.enable");
    return { baselineTaskDurationMs: null, session, supported: true };
  } catch {
    return { baselineTaskDurationMs: null, session: null, supported: false };
  }
}

export async function beginMainThreadSample(
  controller: MainThreadController
): Promise<void> {
  controller.baselineTaskDurationMs = await taskDurationMs(controller.session);
}

export async function readMainThreadDiagnostics(
  controller: MainThreadController
): Promise<MainThreadSnapshot> {
  if (!controller.supported || controller.baselineTaskDurationMs === null) {
    return controller.supported
      ? { ...EMPTY_SNAPSHOT, supported: true }
      : EMPTY_SNAPSHOT;
  }
  const current = await taskDurationMs(controller.session);
  const delta =
    current === null || current < controller.baselineTaskDurationMs
      ? null
      : current - controller.baselineTaskDurationMs;
  return {
    supported: true,
    taskDurationDeltaMs: delta,
  };
}

export async function stopMainThreadSample(
  controller: MainThreadController
): Promise<MainThreadSnapshot> {
  const snapshot = await readMainThreadDiagnostics(controller);
  controller.baselineTaskDurationMs = null;
  return snapshot;
}
