import { chromium } from "@playwright/test";
import { afterAll, describe, expect, it } from "vitest";
import {
  beginVisibilityObservation,
  finishVisibilityObservation,
  waitForVisibilityReadiness,
} from "./production-visibility";

const browserPromise = chromium.launch({ headless: true });

afterAll(async () => {
  (await browserPromise).close();
});

describe("production visibility measurement", () => {
  it("excludes the old 20-block window and rejects a foreign new reply", async () => {
    const browser = await browserPromise;
    const page = await browser.newPage();
    await page.setContent(
      `<main data-chat-scroll style="width:400px"><div class="prose-chat">OLD_MARKER</div>${Array.from(
        { length: 19 },
        (_, index) => `<div class="prose-chat">old-${index}</div>`
      ).join("")}</main>`
    );
    const marker = "BUSY_PROD_PERF_FIXTURE";
    await beginVisibilityObservation(page, marker);
    await page.evaluate(() => {
      const element = document.createElement("div");
      element.className = "prose-chat";
      element.textContent = "FOREIGN_REPLY";
      document.querySelector("[data-chat-scroll]")?.append(element);
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    await page.evaluate((value) => {
      const element = document.createElement("div");
      element.className = "prose-chat";
      element.textContent = value;
      document.querySelector("[data-chat-scroll]")?.append(element);
    }, marker);
    const result = await finishVisibilityObservation(page);
    expect(result.firstVisibleMs).not.toBeNull();
    expect(result.qualityPassed).toBe(false);
    await page.close();
  });

  it("retries visibility when an ancestor fades in without a text mutation", async () => {
    const browser = await browserPromise;
    const page = await browser.newPage();
    await page.setContent('<main data-chat-scroll style="width:400px"></main>');
    const marker = "BUSY_PROD_PERF_OPACITY";
    await beginVisibilityObservation(page, marker);
    await page.evaluate(() => {
      const wrapper = document.createElement("div");
      wrapper.style.opacity = "0";
      wrapper.innerHTML =
        '<div class="prose-chat">BUSY_PROD_PERF_OPACITY</div>';
      document.querySelector("[data-chat-scroll]")?.append(wrapper);
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    await page.evaluate(() => {
      const wrapper = document.querySelector("[data-chat-scroll]")
        ?.lastElementChild as HTMLElement | null;
      if (wrapper) {
        wrapper.style.opacity = "1";
      }
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    const result = await finishVisibilityObservation(page);
    expect(result.firstVisibleMs).not.toBeNull();
    expect(result.qualityPassed).toBe(true);
    await page.close();
  });

  it("waits for the public reply to finish its opacity reveal", async () => {
    const browser = await browserPromise;
    const page = await browser.newPage();
    await page.setContent('<main data-chat-scroll style="width:400px"></main>');
    const marker = "BUSY_PROD_PERF_FADE";
    await beginVisibilityObservation(page, marker);
    await page.evaluate((value) => {
      const wrapper = document.createElement("div");
      wrapper.style.opacity = "0";
      wrapper.style.transition = "opacity 120ms linear";
      wrapper.addEventListener("transitionend", () => {
        (
          window as unknown as { __busyFadeReadyAt?: number }
        ).__busyFadeReadyAt = performance.now();
      });
      const reply = document.createElement("div");
      reply.className = "prose-chat";
      reply.textContent = value;
      wrapper.append(reply);
      document.querySelector("[data-chat-scroll]")?.append(wrapper);
      requestAnimationFrame(() => {
        wrapper.style.opacity = "1";
      });
    }, marker);
    await waitForVisibilityReadiness(page, 1000);
    const result = await finishVisibilityObservation(page);
    const timing = await page.evaluate(() => ({
      fadeReadyAt: (window as unknown as { __busyFadeReadyAt?: number })
        .__busyFadeReadyAt,
      startedAt: (
        window as unknown as {
          __busyPerfVisibility?: { state?: { startedAt?: number } };
        }
      ).__busyPerfVisibility?.state?.startedAt,
    }));
    expect(result.firstVisibleMs).not.toBeNull();
    expect(timing.fadeReadyAt).not.toBeUndefined();
    expect(timing.startedAt).not.toBeUndefined();
    expect(result.firstVisibleMs ?? -1).toBeGreaterThanOrEqual(
      (timing.fadeReadyAt ?? 0) - (timing.startedAt ?? 0)
    );
    expect(result.qualityPassed).toBe(true);
    await page.close();
  });

  it("records the first streamed token before the full marker", async () => {
    const browser = await browserPromise;
    const page = await browser.newPage();
    await page.setContent('<main data-chat-scroll style="width:400px"></main>');
    const marker = "BUSY_PROD_PERF_STREAM";
    await beginVisibilityObservation(page, marker);
    await page.evaluate(() => {
      const reply = document.createElement("div");
      reply.className = "prose-chat";
      reply.textContent = "BUSY_";
      document.querySelector("[data-chat-scroll]")?.append(reply);
    });
    await page.waitForFunction(
      "window.__busyPerfVisibility?.state?.firstTokenVisibleMs !== null"
    );
    await page.waitForTimeout(50);
    await page.evaluate((value) => {
      const reply = document.querySelector(".prose-chat");
      if (reply) {
        reply.textContent = value;
      }
    }, marker);
    await waitForVisibilityReadiness(page, 1000);
    const result = await finishVisibilityObservation(page);
    expect(result.firstTokenVisibleMs).not.toBeNull();
    expect(result.firstVisibleMs).not.toBeNull();
    expect(result.firstTokenVisibleMs ?? Number.POSITIVE_INFINITY).toBeLessThan(
      result.firstVisibleMs ?? 0
    );
    expect(result.qualityPassed).toBe(true);
    await page.close();
  });
});
