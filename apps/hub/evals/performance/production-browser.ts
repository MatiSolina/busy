import type { Page } from "@playwright/test";

export async function installStreamReadiness(
  page: Page,
  slug: string
): Promise<void> {
  await page.addInitScript({
    content: `(() => {
      const targetSlug = ${JSON.stringify(slug)};
      const NativeEventSource = window.EventSource;
      const state = {
        opened: false,
        path: "/api/bots/" + targetSlug + "/events",
        sessionReceived: false,
      };
      class ObservedEventSource extends NativeEventSource {
        constructor(url, eventSourceInitDict) {
          super(url, eventSourceInitDict);
          const path = new URL(url, window.location.href).pathname;
          if (path !== state.path) return;
          this.addEventListener("open", () => { state.opened = true; });
          this.addEventListener("session", () => { state.sessionReceived = true; });
        }
      }
      Object.defineProperties(ObservedEventSource, {
        CLOSED: { value: NativeEventSource.CLOSED },
        CONNECTING: { value: NativeEventSource.CONNECTING },
        OPEN: { value: NativeEventSource.OPEN },
      });
      Object.defineProperty(window, "EventSource", {
        configurable: true,
        value: ObservedEventSource,
      });
      window.__busyPerfStream = state;
    })();`,
  });
}

export async function waitForStreamReadiness(
  page: Page,
  slug: string,
  timeoutMs: number
): Promise<void> {
  await page.waitForFunction(
    (targetSlug) => {
      const state = (
        window as unknown as {
          __busyPerfStream?: {
            opened: boolean;
            path: string;
            sessionReceived: boolean;
          };
        }
      ).__busyPerfStream;
      return (
        state?.path === `/api/bots/${targetSlug}/events` &&
        state.opened &&
        state.sessionReceived
      );
    },
    slug,
    { polling: "raf", timeout: timeoutMs }
  );
}
