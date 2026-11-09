import type { Page } from "@playwright/test";

export interface VisibilityResult {
  firstTokenVisibleAtMs: number | null;
  firstTokenVisibleMs: number | null;
  firstVisibleAtMs: number | null;
  firstVisibleMs: number | null;
  qualityPassed: boolean;
}

// Two milestones share one clock (`startedAt`, armed just before the POST):
// - firstToken*: any new, non-empty assistant reply block (`.prose-chat`) is
//   visible — the first streamed text the user can read.
// - firstVisible*: the new reply block's text equals the full marker.
// Both require the same visibility check confirmed across two frames.
export async function beginVisibilityObservation(
  page: Page,
  marker: string
): Promise<void> {
  await page.evaluate(`(() => {
    const value = ${JSON.stringify(marker)};
    const root = document.querySelector("[data-chat-scroll]") || document.body;
    for (const element of root.querySelectorAll(".prose-chat")) {
      element.setAttribute("data-busy-perf-existing", "");
    }
    const state = { active: true, firstTokenVisibleAtMs: null, firstTokenVisibleMs: null, firstVisibleAtMs: null, firstVisibleMs: null, marker: value, rafId: null, startedAt: performance.now() };
    const pending = { firstTokenVisible: new WeakSet(), firstVisible: new WeakSet() };
    const visible = (element) => {
      const html = element;
      const rect = html.getBoundingClientRect();
      const checkVisibility = html.checkVisibility;
      if (document.visibilityState !== "visible" || rect.width <= 0 || rect.height <= 0) return false;
      if (checkVisibility && !checkVisibility.call(html, { checkOpacity: true, checkVisibilityCSS: true })) return false;
      let ancestor = html;
      while (ancestor instanceof HTMLElement) {
        const style = getComputedStyle(ancestor);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.99) return false;
        ancestor = ancestor.parentElement;
      }
      return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
    };
    const text = (element) => element.textContent?.trim() || "";
    const qualifies = (key, element) => key === "firstTokenVisible" ? text(element).length > 0 : text(element) === state.marker;
    const record = (key) => {
      state[key + "AtMs"] = performance.now();
      state[key + "Ms"] = Math.max(0, state[key + "AtMs"] - state.startedAt);
    };
    const scan = () => {
      for (const element of root.querySelectorAll(".prose-chat:not([data-busy-perf-existing])")) {
        for (const key of ["firstTokenVisible", "firstVisible"]) {
          if (state[key + "Ms"] !== null || pending[key].has(element)) continue;
          if (!(qualifies(key, element) && visible(element))) continue;
          pending[key].add(element);
          requestAnimationFrame(() => requestAnimationFrame(() => {
            pending[key].delete(element);
            if (state[key + "Ms"] === null && qualifies(key, element) && visible(element)) record(key);
          }));
        }
      }
    };
    // Synchronous fallback used once observation stops (no frame confirmation).
    const settle = () => {
      for (const element of root.querySelectorAll(".prose-chat:not([data-busy-perf-existing])")) {
        for (const key of ["firstTokenVisible", "firstVisible"]) {
          if (state[key + "Ms"] === null && qualifies(key, element) && visible(element)) record(key);
        }
      }
    };
    const observer = new MutationObserver(scan);
    observer.observe(root, { characterData: true, childList: true, subtree: true });
    const tick = () => { scan(); if (state.active && (state.firstTokenVisibleMs === null || state.firstVisibleMs === null)) state.rafId = requestAnimationFrame(tick); };
    window.__busyPerfVisibility = { observer, root, scan, settle, state };
    tick();
  })()`);
}

export async function waitForVisibilityReadiness(
  page: Page,
  timeoutMs: number
): Promise<void> {
  await page.waitForFunction(
    () => {
      const holder = (
        window as unknown as {
          __busyPerfVisibility?: {
            root?: Element;
            state?: {
              firstVisibleAtMs: number | null;
              firstVisibleMs: number | null;
              marker: string;
              startedAt: number;
            };
          };
        }
      ).__busyPerfVisibility;
      const state = holder?.state;
      const root = holder?.root || document.body;
      if (!state) {
        return false;
      }
      if (state.firstVisibleAtMs === null) {
        return false;
      }
      const { marker } = state;
      const candidate = [
        ...root.querySelectorAll(".prose-chat:not([data-busy-perf-existing])"),
      ].find((element) => element.textContent?.trim() === marker);
      if (!candidate) {
        return false;
      }
      const rect = candidate.getBoundingClientRect();
      const visible =
        document.visibilityState === "visible" &&
        rect.width > 0 &&
        rect.height > 0 &&
        (!candidate.checkVisibility ||
          candidate.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          }));
      if (!visible) {
        return false;
      }
      const ready =
        rect.bottom > 0 &&
        rect.top < window.innerHeight &&
        rect.right > 0 &&
        rect.left < window.innerWidth;
      if (!ready) {
        return false;
      }
      return true;
    },
    undefined,
    { polling: "raf", timeout: timeoutMs }
  );
}

export async function finishVisibilityObservation(
  page: Page
): Promise<VisibilityResult> {
  return await page.evaluate(`(async () => {
    const holder = window.__busyPerfVisibility;
    if (holder?.state) holder.state.active = false;
    if (holder?.state?.rafId !== null && holder?.state?.rafId !== undefined) cancelAnimationFrame(holder.state.rafId);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    holder?.scan?.();
    holder?.observer?.disconnect();
    holder?.settle?.();
    const state = holder?.state;
    const root = holder?.root || document.body;
    const newReplies = [...root.querySelectorAll(".prose-chat:not([data-busy-perf-existing])")]
      .map((element) => element.textContent?.trim() || "")
      .filter((text) => text.length > 0);
    return {
      firstTokenVisibleAtMs: state?.firstTokenVisibleAtMs ?? null,
      firstTokenVisibleMs: state?.firstTokenVisibleMs ?? null,
      firstVisibleAtMs: state?.firstVisibleAtMs ?? null,
      firstVisibleMs: state?.firstVisibleMs ?? null,
      qualityPassed: newReplies.length === 1 && newReplies[0] === state?.marker,
    };
  })()`);
}
