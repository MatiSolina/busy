import { chromium } from "@playwright/test";
import { afterEach, describe, expect, it } from "vitest";
import {
  finishNativeTypingProbe,
  installNativeTypingProbe,
} from "./native-typing";

const browsers: Awaited<ReturnType<typeof chromium.launch>>[] = [];

afterEach(async () => {
  await Promise.all(browsers.map((browser) => browser.close()));
  browsers.length = 0;
});

describe("native typing probe", () => {
  it("uses the browser clock, waits for final paint, and cleans up", async () => {
    const browser = await chromium.launch();
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent('<textarea aria-label="draft"></textarea>');

    await installNativeTypingProbe(
      page,
      "draft",
      'textarea[aria-label="draft"]'
    );
    await page.locator('textarea[aria-label="draft"]').pressSequentially("dr");
    await page.waitForTimeout(25);
    expect(
      await page.evaluate(
        () =>
          (
            document.querySelector("textarea") as HTMLTextAreaElement & {
              __perfTypingProbe?: { paintAt: number | null };
            }
          ).__perfTypingProbe?.paintAt
      )
    ).toBeNull();
    await page.locator('textarea[aria-label="draft"]').pressSequentially("aft");
    const measurement = await finishNativeTypingProbe(
      page,
      'textarea[aria-label="draft"]'
    );
    expect(measurement.firstInputAt).toBeLessThanOrEqual(
      measurement.lastInputAt
    );
    expect(measurement.lastInputAt).toBeLessThanOrEqual(measurement.paintAt);
    expect(
      await page.evaluate(
        () =>
          (
            document.querySelector("textarea") as HTMLTextAreaElement & {
              __perfTypingProbe?: unknown;
            }
          ).__perfTypingProbe
      )
    ).toBeUndefined();
  });

  it("cleans up a timed-out probe and refuses preexisting text", async () => {
    const browser = await chromium.launch();
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setContent('<textarea aria-label="draft"></textarea>');
    await installNativeTypingProbe(
      page,
      "never",
      'textarea[aria-label="draft"]'
    );
    await expect(
      finishNativeTypingProbe(page, 'textarea[aria-label="draft"]', 25)
    ).rejects.toThrow("timed out");
    expect(
      await page.evaluate(
        () =>
          (
            document.querySelector("textarea") as HTMLTextAreaElement & {
              __perfTypingProbe?: unknown;
            }
          ).__perfTypingProbe
      )
    ).toBeUndefined();
    await page.locator('textarea[aria-label="draft"]').fill("existing");
    await expect(
      installNativeTypingProbe(page, "existing", 'textarea[aria-label="draft"]')
    ).rejects.toThrow("empty textarea");
  });
});
