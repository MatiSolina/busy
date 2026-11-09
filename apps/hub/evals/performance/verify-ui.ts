// biome-ignore-all lint/performance/noAwaitInLoops: These interactions intentionally exercise one browser sequentially.

import { resolve } from "node:path";
import {
  type CDPSession,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  fixtureTaskId,
  fixtureTaskTitle,
  getWorkload,
  newestArchivedReplyMarker,
  replyMarker,
} from "./workload";

const workload = getWorkload(process.env.PERF_WORKLOAD);
const firstLiveLine = workload.turnsPerSession * workload.factsPerTurn;
const expectedArchiveSessions = Number(
  process.env.PERF_HISTORY_EXPECT_ARCHIVE_SESSIONS ??
    workload.sessionsPerBot - 1
);

/**
 * The archive endpoint returns read-only session rows; loading it does not
 * switch the visible pane away from the active session. Validate the newest
 * returned archived session from the response itself and separately reveal
 * its marker in the selected bot's DOM.
 */
export function archiveContainsMarker(
  past: unknown[],
  marker: string
): boolean {
  const newest = past.at(-1);
  if (!newest || typeof newest !== "object" || Array.isArray(newest)) {
    return false;
  }
  const { rows } = newest as { rows?: unknown[] };
  if (!Array.isArray(rows)) {
    return false;
  }
  return rows.some((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return false;
    }
    const entry = row as {
      data?: { data?: { value?: unknown } };
      markdown?: unknown;
    };
    return (
      (typeof entry.markdown === "string" && entry.markdown.includes(marker)) ||
      (typeof entry.data?.data?.value === "string" &&
        entry.data.data.value.includes(marker))
    );
  });
}

const MAX_ARCHIVE_REVEAL_PAGES = 15;
const ARCHIVE_NETWORK_TIMEOUT_MS = 30_000;
// How long one scroll to the top gets to load an active-session page before scrolling again.
const ARCHIVE_PAGE_SETTLE_MS = 2000;

function waitForNetworkPhase<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Archive ${label} timed out`)),
      timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
    }
  });
}

async function closeArchiveCapture(cdp: CDPSession): Promise<void> {
  await cdp.send("Network.disable").catch(() => undefined);
  await cdp.detach().catch(() => undefined);
}

/** Scrolls the chat to its top, which loads the earlier page (the list has no button for it). */
async function revealEarlier(pane: Locator): Promise<void> {
  await pane.locator("[data-chat-scroll]").evaluate((scroller) => {
    // At 0 an overflowing chat counts as still opening, not as a reader at the top.
    scroller.scrollTop = 1;
  });
}

async function waitForViewportIntersection(target: Locator): Promise<void> {
  await target.evaluate((element) =>
    element.scrollIntoView({ block: "center", inline: "nearest" })
  );
  await expect
    .poll(() =>
      target.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.height > 0 &&
          box.width > 0 &&
          box.bottom > 0 &&
          box.top < innerHeight
        );
      })
    )
    .toBe(true);
}

export async function revealNewestArchivedReply(
  page: Page,
  pane: Locator,
  marker: string
): Promise<number> {
  const blocks = pane.locator("[data-chat-block]").filter({ hasText: marker });
  const replyText = pane.getByText(marker, { exact: false });
  for (
    let pageCount = 0;
    pageCount <= MAX_ARCHIVE_REVEAL_PAGES;
    pageCount += 1
  ) {
    const target =
      (await blocks.count()) > 0 ? blocks.first() : replyText.first();
    if ((await target.count()) > 0 && (await target.isVisible())) {
      await target.scrollIntoViewIfNeeded();
      await waitForViewportIntersection(target);
      await target.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done()))
        );
      });
      await waitForViewportIntersection(target);
      return pageCount;
    }
    if (pageCount === MAX_ARCHIVE_REVEAL_PAGES) {
      break;
    }
    await revealEarlier(pane);
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done()))
        )
    );
  }
  throw new Error(`Newest archived reply was not revealed: ${marker}`);
}

export async function clickAndProbeArchive(
  page: Page,
  pane: Locator,
  started = performance.now(),
  timeoutMs = ARCHIVE_NETWORK_TIMEOUT_MS
): Promise<{
  cdp: CDPSession;
  requestId: string;
  requestCount: number;
  responseReadyMs: number;
  responseStatus: number;
}> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable", {
    maxResourceBufferSize: 64 * 1024 * 1024,
    maxTotalBufferSize: 128 * 1024 * 1024,
  });
  let requestCount = 0;
  let requestId: string | undefined;
  let responseStatus: number | undefined;
  let resolveResponse: () => void = () => undefined;
  let rejectResponse: (error: unknown) => void = () => undefined;
  let resolveLoadingFinished: () => void = () => undefined;
  const responseReady = new Promise<void>((resolveDone, rejectDone) => {
    resolveResponse = resolveDone;
    rejectResponse = rejectDone;
  });
  const loadingFinished = new Promise<void>((resolveDone) => {
    resolveLoadingFinished = resolveDone;
  });
  const onRequest = (event: {
    requestId: string;
    request: { url: string };
  }) => {
    if (!event.request.url.endsWith("/past-sessions")) {
      return;
    }
    requestCount += 1;
    requestId ??= event.requestId;
  };
  const onResponse = (event: {
    requestId: string;
    response: { status: number; url: string };
  }) => {
    if (!event.response.url.endsWith("/past-sessions")) {
      return;
    }
    responseStatus = event.response.status;
    requestId ??= event.requestId;
    resolveResponse();
  };
  const onLoadingFinished = (event: { requestId: string }) => {
    if (event.requestId === requestId) {
      resolveLoadingFinished();
    }
  };
  const onLoadingFailed = (event: { errorText: string; requestId: string }) => {
    if (event.requestId === requestId) {
      rejectResponse(new Error(`Archive network failed: ${event.errorText}`));
    }
  };
  cdp.on("Network.requestWillBeSent", onRequest);
  cdp.on("Network.responseReceived", onResponse);
  cdp.on("Network.loadingFinished", onLoadingFinished);
  cdp.on("Network.loadingFailed", onLoadingFailed);
  const archiveRequested = () => requestId !== undefined;
  let revealedAt = started;
  try {
    // Earlier pages drain the active session before they reach the archive,
    // so keep scrolling to the top until the chat asks for past sessions.
    for (let reveal = 0; !archiveRequested(); reveal += 1) {
      if (reveal > MAX_ARCHIVE_REVEAL_PAGES) {
        throw new Error("Archive request was never sent");
      }
      if (reveal > 0) {
        revealedAt = performance.now();
      }
      await revealEarlier(pane);
      await expect
        .poll(archiveRequested, { timeout: ARCHIVE_PAGE_SETTLE_MS })
        .toBe(true)
        .catch(() => undefined);
    }
    await waitForNetworkPhase(responseReady, timeoutMs, "response");
    await waitForNetworkPhase(loadingFinished, timeoutMs, "body");
  } catch (error) {
    await closeArchiveCapture(cdp);
    throw error;
  } finally {
    cdp.off("Network.requestWillBeSent", onRequest);
    cdp.off("Network.responseReceived", onResponse);
    cdp.off("Network.loadingFinished", onLoadingFinished);
    cdp.off("Network.loadingFailed", onLoadingFailed);
  }
  if (!(requestId && responseStatus !== undefined)) {
    await closeArchiveCapture(cdp);
    throw new Error("Archive response identity was not captured");
  }
  if (responseStatus !== 200) {
    await closeArchiveCapture(cdp);
    throw new Error(`Archived fixture probe failed: ${responseStatus}`);
  }
  return {
    cdp,
    requestCount,
    requestId,
    responseReadyMs: performance.now() - revealedAt,
    responseStatus,
  };
}

export async function readArchiveResponseBody(capture: {
  cdp: CDPSession;
  requestId: string;
}): Promise<Buffer> {
  try {
    const body = (await capture.cdp.send("Network.getResponseBody", {
      requestId: capture.requestId,
    })) as { base64Encoded: boolean; body: string };
    return body.base64Encoded
      ? Buffer.from(body.body, "base64")
      : Buffer.from(body.body);
  } finally {
    await closeArchiveCapture(capture.cdp);
  }
}

async function openSettings(page: Page) {
  await page
    .getByRole("button", { exact: true, name: "Account menu: Performance" })
    .click();
  await page.getByRole("menuitem", { exact: true, name: "Settings" }).click();
  const tabs = page.getByRole("tablist", { name: "Settings sections" });
  await expect(tabs).toBeVisible();
  return tabs;
}

export async function streamReply(page: Page, phase: "cold" | "warm" = "warm") {
  await page.evaluate(
    async ({ stage, line }) => {
      const source = (
        window as unknown as { __perfStreams: Map<string, EventTarget> }
      ).__perfStreams.get("perf-bot-0");
      if (!source) {
        throw new Error("Selected conversation has no event stream");
      }
      source.dispatchEvent(
        new MessageEvent("fact", {
          data: JSON.stringify({
            data: {
              data: { turnId: `perf-live-turn-${stage}` },
              type: "turn.started",
            },
            index: 0,
            line: line + (stage === "cold" ? 0 : 3),
            type: "turn.started",
          }),
        })
      );
      for (const delta of [
        "Performance ",
        "streaming ",
        `response (${stage})`,
      ]) {
        source.dispatchEvent(
          new MessageEvent("progress", {
            data: JSON.stringify({
              data: { delta, kind: "text", partId: `perf-live-part-${stage}` },
              type: "content.delta",
            }),
          })
        );
        await new Promise<void>((done) => requestAnimationFrame(() => done()));
      }
    },
    { line: firstLiveLine, stage: phase }
  );
  await page.waitForFunction(
    (stage) =>
      document
        .querySelector('section[aria-label="Chat with Performance Bot 0"]')
        ?.textContent?.includes(`Performance streaming response (${stage})`) &&
      !document.querySelector(
        'section[aria-label="Chat with Performance Bot 0"] [data-markdown-loading]'
      ),
    phase,
    { polling: "raf" }
  );
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done()))
      )
  );
}

export async function finishColdReply(page: Page) {
  await page.evaluate((line) => {
    const source = (
      window as unknown as { __perfStreams: Map<string, EventTarget> }
    ).__perfStreams.get("perf-bot-0");
    if (!source) {
      throw new Error("Selected conversation has no event stream");
    }
    const facts = [
      {
        data: {
          kind: "text",
          partId: "perf-live-part-cold",
          phase: "reply",
          value: "Performance streaming response (cold)",
        },
        type: "content.completed",
      },
      {
        data: { outcome: "completed", turnId: "perf-live-turn-cold" },
        type: "turn.settled",
      },
    ];
    for (const [offset, fact] of facts.entries()) {
      source.dispatchEvent(
        new MessageEvent("fact", {
          data: JSON.stringify({
            data: fact,
            index: 0,
            line: line + 1 + offset,
            type: fact.type,
          }),
        })
      );
    }
  }, firstLiveLine);
  await page.waitForFunction(
    () =>
      !document.querySelector(
        'section[aria-label="Chat with Performance Bot 0"] [data-markdown-loading]'
      ),
    undefined,
    { polling: "raf" }
  );
}

async function verifyRichMarkdown(
  page: Page,
  pane: ReturnType<Page["getByRole"]>
) {
  await expect(pane.locator("table").last()).toBeAttached();
  await expect(pane.locator("pre").last()).toContainText(
    "export async function review"
  );
  await pane.getByRole("button", { name: "the project notes" }).last().click();
  await expect(
    page.getByText("Open external link?", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("https://example.com/project", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { exact: true, name: "Open link" })
  ).toBeVisible();
  await page.getByRole("button", { exact: true, name: "Close" }).click();
  await expect(
    page.getByText("Open external link?", { exact: true })
  ).toBeHidden();
  await expect(pane.getByRole("checkbox").last()).toBeDisabled();
  await pane
    .getByRole("button", { exact: true, name: "1 step on its computer" })
    .last()
    .click();
  await expect(
    pane.getByText("inspect_project", { exact: true }).last()
  ).toBeVisible();
}

export async function verifyUi(
  page: Page,
  outputDirectory: string
): Promise<{
  archivePayloadReadyMs: number;
  archiveFirstPageReadyMs: number;
  archiveLoadMs: number;
  archiveResponseBytes: number;
  archiveResponseReadyMs: number;
  archiveRequestCount: number;
  archiveSessionCount: number;
  historyAnchorStable: number;
  archiveRevealPages: number;
}> {
  const pane = page.getByRole("region", {
    exact: true,
    name: "Chat with Performance Bot 0",
  });
  if (workload.name === "mixed") {
    await verifyRichMarkdown(page, pane);
  }
  // Earlier steps can scroll near the top and start a page; let it land first.
  await expect(pane.getByLabel("Loading earlier messages")).toHaveCount(0);
  await expect
    .poll(() =>
      pane.locator("[data-chat-scroll]").evaluate(async (scroller) => {
        const height = scroller.scrollHeight;
        await new Promise((done) => setTimeout(done, 250));
        return scroller.scrollHeight === height;
      })
    )
    .toBe(true);
  // A reader's wheel releases the anchor the last page holds through resizes;
  // a programmatic scroll alone would be pulled back by it.
  await pane.locator("[data-chat-scroll]").hover();
  await page.mouse.wheel(0, -1);
  const original = await pane
    .locator("[data-chat-block]")
    .first()
    .elementHandle();
  // Reaching the top loads the earlier page on its own. The chat records its
  // anchor when its sentinel enters view, so read the first block in that same
  // intersection dispatch, after the browser has settled the visible blocks.
  const beforeY = await pane.locator("[data-chat-scroll]").evaluate(
    (scroller, block) =>
      new Promise<number | null>((done) => {
        const sentinel = scroller.querySelector("[data-chat-earlier]");
        if (!(block && sentinel)) {
          done(null);
          return;
        }
        const timer = setTimeout(() => done(null), 15_000);
        const observer = new IntersectionObserver(
          (entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
              observer.disconnect();
              clearTimeout(timer);
              done(block.getBoundingClientRect().y);
            }
          },
          { root: scroller, rootMargin: "600px 0px 0px 0px" }
        );
        observer.observe(sentinel);
        requestAnimationFrame(() => {
          scroller.scrollTop = 1;
        });
      }),
    original
  );
  await page.waitForFunction(
    (block) =>
      document.querySelector(
        'section[aria-label="Chat with Performance Bot 0"] [data-chat-block]'
      ) !== block,
    original,
    { polling: "raf" }
  );
  await page.waitForFunction(
    () =>
      !document.querySelector(
        'section[aria-label="Chat with Performance Bot 0"] [data-markdown-loading]'
      ),
    undefined,
    { polling: "raf" }
  );
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done()))
    );
  });
  const before = beforeY === null ? null : { y: beforeY };
  const after = await original?.boundingBox();
  if (!(before && after) || Math.abs(before.y - after.y) > 4) {
    await page.screenshot({
      path: resolve(outputDirectory, "scroll-failure.png"),
    });
    throw new Error(
      `Expanding messages moved the scroll anchor: ${JSON.stringify({ after, before })}`
    );
  }
  await expect(
    pane.getByText(replyMarker(workload, 0), { exact: false })
  ).toBeAttached();
  const archiveStarted = performance.now();
  const capture = await clickAndProbeArchive(page, pane, archiveStarted);
  try {
    const {
      cdp,
      requestId,
      requestCount: archiveRequestCount,
      responseReadyMs: archiveResponseReadyMs,
    } = capture;
    if (archiveRequestCount !== 1) {
      throw new Error(
        `Expected one archive request, got ${archiveRequestCount}`
      );
    }
    const archiveMarker = newestArchivedReplyMarker(workload);
    const archiveRevealPages = await revealNewestArchivedReply(
      page,
      pane,
      archiveMarker
    );
    const archiveFirstPageReadyMs = performance.now() - archiveStarted;
    await expect(
      pane.getByRole("button", {
        exact: true,
        name: "Load earlier conversations",
      })
    ).toHaveCount(0);
    await expect(pane.locator("[data-chat-earlier]")).toBeAttached();

    const archiveLoadMs = performance.now() - archiveStarted;
    const payloadStarted = performance.now();
    const historyBytes = await readArchiveResponseBody({ cdp, requestId });
    const history = JSON.parse(historyBytes.toString("utf8")) as {
      past: unknown[];
    };
    const archivePayloadReadyMs = performance.now() - payloadStarted;
    if (history.past.length !== expectedArchiveSessions) {
      throw new Error("Archived fixture sessions were lost");
    }
    if (!archiveContainsMarker(history.past, archiveMarker)) {
      throw new Error("Archived fixture rows were not returned");
    }

    await page.setViewportSize({ height: 844, width: 390 });
    await pane.getByRole("button", { exact: true, name: "Bots" }).click();
    await page
      .getByRole("dialog")
      .locator(`[data-bot-slug="perf-bot-${workload.bots > 1 ? 1 : 0}"]`)
      .click();
    await expect(
      page.getByRole("region", {
        exact: true,
        name: `Chat with Performance Bot ${workload.bots > 1 ? 1 : 0}`,
      })
    ).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth
    );
    if (overflow) {
      throw new Error("Mobile layout overflows horizontally");
    }
    await page.screenshot({ path: resolve(outputDirectory, "mobile.png") });

    await page.setViewportSize({ height: 900, width: 1440 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator('aside [data-bot-slug="perf-bot-0"]').click();
    await expect(pane.locator("textarea")).toHaveValue(
      "Preserve this evaluation draft"
    );
    const animations = await pane.evaluate(
      (element) => element.parentElement?.getAnimations().length ?? 0
    );
    if (animations !== 0) {
      throw new Error("Reduced motion still animates the chat pane");
    }
    const tabs = await openSettings(page);
    await tabs.getByRole("tab", { exact: true, name: "Usage" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { exact: true, name: "Close" })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    const reopenedTabs = await openSettings(page);
    await expect(
      reopenedTabs.getByRole("tab", { exact: true, name: "Usage" })
    ).toHaveAttribute("aria-selected", "true");
    await page
      .getByRole("dialog")
      .getByRole("button", { exact: true, name: "Close" })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.screenshot({ path: resolve(outputDirectory, "desktop.png") });
    return {
      archiveFirstPageReadyMs,
      archiveLoadMs,
      archivePayloadReadyMs,
      archiveRequestCount,
      archiveResponseBytes: historyBytes.byteLength,
      archiveResponseReadyMs,
      archiveRevealPages,
      archiveSessionCount: history.past.length,
      historyAnchorStable: 1,
    };
  } finally {
    await closeArchiveCapture(capture.cdp);
  }
}

export async function measureArchiveFirstPage(page: Page) {
  const pane = page.getByRole("region", {
    exact: true,
    name: "Chat with Performance Bot 0",
  });
  const started = performance.now();
  const capture = await clickAndProbeArchive(page, pane, started);
  try {
    const {
      cdp,
      requestId,
      requestCount: archiveRequestCount,
      responseReadyMs: archiveResponseReadyMs,
    } = capture;
    if (archiveRequestCount !== 1) {
      throw new Error(
        `Expected one archive request, got ${archiveRequestCount}`
      );
    }
    const archiveMarker = newestArchivedReplyMarker(workload);
    const archiveRevealPages = await revealNewestArchivedReply(
      page,
      pane,
      archiveMarker
    );
    const archiveFirstPageReadyMs = performance.now() - started;
    const payloadStarted = performance.now();
    const body = await readArchiveResponseBody({ cdp, requestId });
    const parsed = JSON.parse(body.toString("utf8")) as { past?: unknown[] };
    const archivePayloadReadyMs = performance.now() - payloadStarted;
    if ((parsed.past?.length ?? 0) !== expectedArchiveSessions) {
      throw new Error("Archived fixture sessions were lost");
    }
    if (!archiveContainsMarker(parsed.past ?? [], archiveMarker)) {
      throw new Error("Archived fixture rows were not returned");
    }
    return {
      archiveFirstPageReadyMs,
      archivePayloadReadyMs,
      archiveRequestCount,
      archiveResponseBytes: body.byteLength,
      archiveResponseReadyMs,
      archiveRevealPages,
      archiveSessionCount: parsed.past?.length ?? 0,
    };
  } finally {
    await closeArchiveCapture(capture.cdp);
  }
}

/** Exercise Next's real router and the chat root's hide/resume lifecycle. */
export async function verifyRouteNavigation(
  page: Page,
  chatReady: () => Promise<unknown>
) {
  await page.goto(new URL(`/code-tasks/${fixtureTaskId}`, page.url()).href);
  const task = page.getByRole("dialog");
  const title = task.getByRole("heading", {
    exact: true,
    name: fixtureTaskTitle,
  });
  const taskReady = async () => {
    await expect(title).toBeVisible();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('[role="dialog"]')).some(
        (element) =>
          element.checkVisibility() &&
          Number(getComputedStyle(element).opacity) >= 0.99
      )
    );
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done()))
        )
    );
  };
  await taskReady();
  const enterStarted = performance.now();
  await task.getByRole("button", { exact: true, name: "Close" }).click();
  await chatReady();
  const enterMs = performance.now() - enterStarted;
  const pane = page.getByRole("region", {
    exact: true,
    name: "Chat with Performance Bot 0",
  });
  const draft = "Retain the draft across route navigation";
  await pane.locator("textarea").fill(draft);
  const leaveStarted = performance.now();
  await page.goBack();
  await taskReady();
  const leaveMs = performance.now() - leaveStarted;
  if (process.env.PERF_EXPECT_STREAM_CLEANUP === "1") {
    await verifyLiveBotSources(page, 0);
  }
  const returnStarted = performance.now();
  await page.goForward();
  await chatReady();
  await expect(pane.locator("textarea")).toHaveValue(draft);
  // Keep the lifecycle assertion outside both timing distributions: only the
  // candidate supports it, and polling the browser is evaluator overhead.
  const returnMs = performance.now() - returnStarted;
  if (process.env.PERF_EXPECT_STREAM_CLEANUP === "1") {
    await verifyLiveBotSources(page, 1);
  }
  return { enterMs, leaveMs, returnMs };
}

async function verifyLiveBotSources(page: Page, count: number) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __perfSources: EventSource[] }
          ).__perfSources.filter(
            (source) =>
              source.url.includes("/api/bots/") && source.readyState !== 2
          ).length
      )
    )
    .toBe(count);
}
