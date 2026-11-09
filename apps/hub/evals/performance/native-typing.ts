import type { Page } from "@playwright/test";

export const TYPING_TEXTAREA_SELECTOR =
  'section[aria-label="Chat with Performance Bot 0"] textarea';
export const TYPING_PROBE_TIMEOUT_MS = 5000;

export interface NativeTypingMeasurement {
  firstInputAt: number;
  lastInputAt: number;
  paintAt: number;
}

export async function installNativeTypingProbe(
  page: Page,
  expected: string,
  selector = TYPING_TEXTAREA_SELECTOR
): Promise<void> {
  await page.evaluate(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLTextAreaElement)) {
      throw new Error("Native typing probe textarea was not found");
    }
    if (target.value !== "") {
      throw new Error("Native typing probe requires an empty textarea");
    }
    const value = ${JSON.stringify(expected)};
    let finish = null;
    const probe = {
      done: new Promise((resolve) => {
        finish = resolve;
      }),
      finish,
      firstInputAt: null,
      lastInputAt: null,
      listener: null,
      paintAt: null,
      paintScheduled: false,
    };
    function onInput() {
      const now = performance.now();
      probe.firstInputAt ??= now;
      probe.lastInputAt = now;
      if (target.value === value && !probe.paintScheduled) {
        probe.paintScheduled = true;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            probe.paintAt = performance.now();
            probe.finish?.();
          })
        );
      }
    }
    probe.listener = onInput;
    target.addEventListener("input", probe.listener);
    target.__perfTypingProbe = probe;
  })()`);
}

export function finishNativeTypingProbe(
  page: Page,
  selector = TYPING_TEXTAREA_SELECTOR,
  timeoutMs = TYPING_PROBE_TIMEOUT_MS
): Promise<NativeTypingMeasurement> {
  const timeout = Math.max(0, Math.floor(timeoutMs));
  return page.evaluate(`(async () => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLTextAreaElement)) {
      throw new Error("Native typing probe textarea was not found");
    }
    const probe = target.__perfTypingProbe;
    if (!probe) {
      throw new Error("Native typing probe was not installed");
    }
    let timer = null;
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native typing probe timed out")),
          ${timeout}
        );
        probe.done.then(resolve, reject);
      });
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
      target.removeEventListener("input", probe.listener);
      target.__perfTypingProbe = undefined;
    }
    if (
      probe.firstInputAt === null ||
      probe.lastInputAt === null ||
      probe.paintAt === null
    ) {
      throw new Error("Native typing probe did not capture input and paint");
    }
    return {
      firstInputAt: probe.firstInputAt,
      lastInputAt: probe.lastInputAt,
      paintAt: probe.paintAt,
    };
  })()`) as Promise<NativeTypingMeasurement>;
}
