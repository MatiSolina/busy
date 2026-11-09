// biome-ignore-all lint/performance/noAwaitInLoops: Navigation samples must run serially to avoid competing for the same CPU and browser state.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  _electron,
  chromium,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { createSession } from "../../lib/auth/session";
import {
  hashEvaluatorFiles,
  hashFixtureFiles,
  REPORT_SCHEMA_VERSION,
} from "./evaluator-identity";
import {
  finishNativeTypingProbe,
  installNativeTypingProbe,
} from "./native-typing";
import {
  finishColdReply,
  measureArchiveFirstPage,
  streamReply,
  verifyRouteNavigation,
  verifyUi,
} from "./verify-ui";
import { getWorkload, replyMarker } from "./workload";

const workload = getWorkload(process.env.PERF_WORKLOAD);

const baseURL = process.env.PERF_URL ?? "http://127.0.0.1:3147";
const parsedBaseURL = URL.parse(baseURL);
assert(
  parsedBaseURL && ["127.0.0.1", "localhost"].includes(parsedBaseURL.hostname),
  "Run against the isolated local fixture"
);
const secret = process.env.SESSION_SECRET;
assert(secret, "Use the same SESSION_SECRET as the local production server");
const samples = Number(process.env.PERF_SAMPLES ?? 7);
assert(
  Number.isInteger(samples) && samples >= 6,
  "At least six samples are required, three per initial interaction"
);
const output = resolve(
  process.env.PERF_OUTPUT ?? "../../.performance/latest.json"
);
const productSourceDirectory =
  process.env.PERF_SOURCE_DIR ?? resolve(process.cwd(), "../..");
const desktop = process.env.PERF_RUNTIME === "electron";
const browser = desktop ? null : await chromium.launch();
const electronPath = desktop
  ? (createRequire(new URL("../../../desktop/package.json", import.meta.url))(
      "electron"
    ) as string)
  : null;
let browserVersion = browser?.version() ?? "";
let activeDesktop: Awaited<ReturnType<typeof _electron.launch>> | null = null;
let activeUserData: string | null = null;
const measurements: Record<string, number[]> = {};
const diagnostics: Record<string, number[]> = {};
const record = (name: string, value: number) => {
  measurements[name] ??= [];
  measurements[name].push(value);
};
const diagnosticRecord = (name: string, value: number) => {
  if (Number.isFinite(value) && value >= 0) {
    diagnostics[name] ??= [];
    diagnostics[name].push(value);
  }
};
const historyDiagnostics =
  workload.name === "history-long" &&
  process.env.PERF_HISTORY_DIAGNOSTICS === "1";
const historyExperiment = process.env.PERF_HISTORY_EXPERIMENT ?? "unassigned";
const historyPrimary =
  workload.name === "history-long" && process.env.PERF_HISTORY_PRIMARY !== "0";
let expectedSnapshotRows: number | null = null;
if (workload.name === "history-long") {
  expectedSnapshotRows =
    historyExperiment === "paged-manual" ||
    historyExperiment === "paged-scroller"
      ? 120
      : 400;
}
assert(
  ["bulk-manual", "paged-manual", "paged-scroller", "unassigned"].includes(
    historyExperiment
  ),
  "PERF_HISTORY_EXPERIMENT must be bulk-manual, paged-manual, paged-scroller or unassigned"
);

interface CdpSessionLike {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}

function measureHistoryEndpoint(page: Page, path: string) {
  return page.evaluate(async (endpoint) => {
    const started = performance.now();
    const response = await fetch(endpoint, { cache: "no-store" });
    const body = await response.text();
    let rows = 0;
    let sessions = 0;
    try {
      const parsed = JSON.parse(body) as {
        past?: unknown[];
        rows?: unknown[];
      };
      rows = parsed.rows?.length ?? 0;
      sessions = parsed.past?.length ?? 0;
    } catch {
      // Keep response content out of the report while retaining size/status.
    }
    return {
      bytes: new TextEncoder().encode(body).byteLength,
      durationMs: performance.now() - started,
      rows,
      sessions,
      status: response.status,
    };
  }, path);
}

async function recordRendererHeap(cdp: CdpSessionLike, prefix: string) {
  try {
    await cdp.send("HeapProfiler.collectGarbage");
    const usage = (await cdp.send("Runtime.getHeapUsage")) as {
      totalSize: number;
      usedSize: number;
    };
    diagnosticRecord(`${prefix}UsedBytes`, usage.usedSize);
    diagnosticRecord(`${prefix}TotalBytes`, usage.totalSize);
  } catch {
    // Heap diagnostics are optional and never change the primary readiness gate.
  }
}

async function paint(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done()))
      )
  );
}

async function verifyWorker(pane: Locator, phase: "cold" | "warm") {
  const rendered = (
    await pane.locator("[data-markdown-worker]").allTextContents()
  ).some((value) =>
    value.includes(`Performance streaming response (${phase})`)
  );
  assert(
    process.env.PERF_EXPECT_MARKDOWN_WORKER !== "1" || rendered,
    `${phase} streaming must render through the Markdown worker`
  );
}

async function ready(page: Page, index: number) {
  const pane = page.getByRole("region", {
    exact: true,
    name: `Chat with Performance Bot ${index}`,
  });
  await page.waitForFunction(
    ({ botIndex, marker }) => {
      const section = document.querySelector(
        `section[aria-label="Chat with Performance Bot ${botIndex}"]`
      );
      const textarea = section?.querySelector("textarea");
      const wrapper = section?.parentElement;
      return (
        (window as unknown as { __perfHydrated?: boolean }).__perfHydrated &&
        section?.checkVisibility() &&
        !section.querySelector("[data-markdown-loading]") &&
        textarea &&
        !textarea.disabled &&
        section.textContent?.includes(marker) &&
        wrapper &&
        Number(getComputedStyle(wrapper).opacity) >= 0.99
      );
    },
    { botIndex: index, marker: replyMarker(workload, index) },
    { polling: "raf", timeout: 15_000 }
  );
  await paint(page);
  return pane;
}

try {
  for (let sample = 0; sample < samples; sample += 1) {
    const userData = desktop
      ? await mkdtemp(resolve(tmpdir(), "busy-perf-electron-"))
      : null;
    activeUserData = userData;
    const desktopApp = desktop
      ? await _electron.launch({
          args: [resolve("../desktop/evals/performance-electron.mjs")],
          env: {
            ...process.env,
            BUSY_URL: baseURL,
            PERF_ELECTRON_PROFILE: userData ?? "",
          },
          executablePath: electronPath ?? undefined,
        })
      : null;
    activeDesktop = desktopApp;
    const context = desktopApp
      ? desktopApp.context()
      : await browser?.newContext({ viewport: { height: 900, width: 1440 } });
    assert(context, "Browser context unavailable");
    await context.addCookies([
      {
        httpOnly: true,
        name: "busy_session",
        sameSite: "Lax",
        url: baseURL,
        value: await createSession("performance-eval", secret),
      },
    ]);
    // External providers and bot computers are not part of navigation latency.
    // The page, RSC, chat data, panel APIs and JS/CSS are the actual production build.
    await context.route("**/api/account", (route) =>
      route.fulfill({
        json: {
          account: { avatarUrl: null, name: "Performance", username: "eval" },
          tokenPass: {
            dashboardUrl: "https://vercel.com",
            limitUsd: 80,
            percentUsed: 0,
            resetsAt: null,
            status: "active",
            usedUsd: 0,
          },
        },
      })
    );
    await context.route("**/api/ai/settings", (route) =>
      route.fulfill({
        json: {
          model: null,
          onboardingCompleted: true,
          provider: "gateway",
          providers: [],
        },
      })
    );
    await context.route("**/api/bots/*/live", (route) =>
      route.fulfill({
        json: { error: "Fixture computer is offline" },
        status: 503,
      })
    );
    await context.addInitScript(`(() => {
      window.__perfHydrated = false;
      window.__perfHydratedAt = 0;
      window.__perfStreams = new Map();
      window.__perfSources = [];
      window.__perfLongTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__perfLongTasks.push(entry.duration);
      }).observe({ type: "longtask", buffered: true });
      class FixtureEventSource extends EventTarget {
        static CLOSED = 2;
        static CONNECTING = 0;
        static OPEN = 1;
        readyState = 1;
        withCredentials = false;
        onerror = null;
        onmessage = null;
        onopen = null;
        url;
        constructor(url) {
          super();
          this.url = url;
          if (!window.__perfHydrated) window.__perfHydratedAt = performance.now();
          window.__perfHydrated = true;
          window.__perfStreams.set(new URL(url, location.href).pathname.split("/")[3], this);
          window.__perfSources.push(this);
        }
        close() {
          this.readyState = 2;
          const key = new URL(this.url, location.href).pathname.split("/")[3];
          if (window.__perfStreams.get(key) === this) window.__perfStreams.delete(key);
        }
      }
      Object.defineProperty(window, "EventSource", { value: FixtureEventSource });
    })()`);
    const page = desktopApp
      ? await desktopApp.firstWindow()
      : await context.newPage();
    if (desktopApp) {
      await page.waitForLoadState("load");
    }
    await page.setViewportSize({ height: 900, width: 1440 });
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error("[perf-eval]", error.stack ?? error.message);
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await cdp.send("Performance.enable");
    if (desktop && sample === 0) {
      browserVersion = (await cdp.send("Browser.getVersion")).product;
    }
    if (process.env.PERF_PROFILE && sample === 0) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.start");
    }
    const started = performance.now();
    const response = await page.goto(`${baseURL}/b/perf-bot-0`, {
      waitUntil: "commit",
    });
    assert(
      response?.status() === 200,
      "The fixture page must load successfully"
    );
    let pane = await ready(page, 0);
    record("loadReadyMs", performance.now() - started);
    if (historyDiagnostics) {
      const snapshot = await measureHistoryEndpoint(
        page,
        "/api/bots/perf-bot-0/snapshot"
      );
      diagnosticRecord("snapshotLoadMs", snapshot.durationMs);
      diagnosticRecord("snapshotResponseBytes", snapshot.bytes);
      diagnosticRecord("snapshotRows", snapshot.rows);
      diagnosticRecord("snapshotRequestCount", 1);
      if (snapshot.status !== 200 || snapshot.rows !== expectedSnapshotRows) {
        throw new Error(
          `Unexpected history snapshot shape: status=${snapshot.status}, rows=${snapshot.rows}`
        );
      }
      await recordRendererHeap(
        cdp as unknown as CdpSessionLike,
        "rendererHeapAfterSnapshot"
      );
    }
    const durations = (await cdp.send("Performance.getMetrics")).metrics;
    for (const [name, metric] of [
      ["scriptMs", "ScriptDuration"],
      ["layoutMs", "LayoutDuration"],
      ["styleMs", "RecalcStyleDuration"],
      ["taskMs", "TaskDuration"],
    ]) {
      record(
        name,
        (durations.find((entry) => entry.name === metric)?.value ?? 0) * 1000
      );
    }
    const navigation = await page.evaluate(() => {
      const timing = performance.getEntriesByType(
        "navigation"
      )[0] as PerformanceNavigationTiming;
      return {
        domContentLoaded: timing.domContentLoadedEventEnd,
        firstByte: timing.responseStart,
        hydrated: (window as unknown as { __perfHydratedAt: number })
          .__perfHydratedAt,
        loadEvent: timing.loadEventEnd,
        responseEnd: timing.responseEnd,
      };
    });
    record("firstByteMs", navigation.firstByte);
    record("responseEndMs", navigation.responseEnd);
    record("domContentLoadedMs", navigation.domContentLoaded);
    record("loadEventMs", navigation.loadEvent);
    record("hydratedMs", navigation.hydrated);
    if (process.env.PERF_PROFILE && sample === 0) {
      const profile = await cdp.send("Profiler.stop");
      await writeFile(
        resolve(process.env.PERF_PROFILE),
        JSON.stringify(profile.profile)
      );
    }
    record("documentBytes", Buffer.byteLength(await response.text()));
    record("domElements", await page.locator("*").count());
    record(
      "longTaskMs",
      await page.evaluate(() =>
        (
          window as unknown as { __perfLongTasks: number[] }
        ).__perfLongTasks.reduce((a, b) => a + b, 0)
      )
    );
    record(
      "javascriptBytes",
      await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .filter((r) => r.name.includes("/_next/") && r.name.endsWith(".js"))
          .reduce(
            (sum, r) => sum + (r as PerformanceResourceTiming).encodedBodySize,
            0
          )
      )
    );
    const streamFirst = sample % 2 === 1;
    if (streamFirst) {
      const coldStreamStarted = performance.now();
      await streamReply(page, "cold");
      record("coldStreamReadyMs", performance.now() - coldStreamStarted);
      await verifyWorker(pane, "cold");
      await finishColdReply(page);
    }
    const draft = "Preserve this evaluation draft";
    const textarea = pane.locator("textarea");
    await installNativeTypingProbe(page, draft);
    const typingDriverStarted = performance.now();
    await textarea.pressSequentially(draft);
    await paint(page);
    const typingDriverReadyMs = performance.now() - typingDriverStarted;
    const nativeTyping = await finishNativeTypingProbe(page);
    diagnosticRecord("typingDriverReadyMs", typingDriverReadyMs);
    diagnosticRecord("typingFirstInputAt", nativeTyping.firstInputAt);
    diagnosticRecord("typingLastInputAt", nativeTyping.lastInputAt);
    diagnosticRecord("typingPaintAt", nativeTyping.paintAt);
    diagnosticRecord(
      "typingInputDurationMs",
      nativeTyping.lastInputAt - nativeTyping.firstInputAt
    );
    diagnosticRecord(
      "typingInputToPaintMs",
      nativeTyping.paintAt - nativeTyping.lastInputAt
    );
    if (!streamFirst) {
      record("typingReadyMs", nativeTyping.paintAt - nativeTyping.lastInputAt);
    }
    const visited = new Set([0]);
    for (const index of workload.bots > 1 ? [1, 2, 0, 1, 0] : []) {
      const before = performance.now();
      await page.locator(`aside [data-bot-slug="perf-bot-${index}"]`).click();
      pane = await ready(page, index);
      record("switchReadyMs", performance.now() - before);
      record(
        visited.has(index) ? "warmSwitchReadyMs" : "coldSwitchReadyMs",
        performance.now() - before
      );
      visited.add(index);
    }
    await expect(pane.locator("textarea")).toHaveValue(draft);
    for (const name of ["Library", "Routines", "Search history"]) {
      let before = performance.now();
      const settings = pane.getByRole("button", {
        exact: true,
        name: "Bot settings",
      });
      if (await settings.count()) {
        await settings.click();
        const section = page.getByRole("tab", {
          exact: true,
          name: name === "Search history" ? "History" : name,
        });
        await section.waitFor({ state: "visible" });
        await page.waitForFunction(() =>
          Array.from(document.querySelectorAll('[role="dialog"]')).some(
            (element) =>
              element.checkVisibility() &&
              Number(getComputedStyle(element).opacity) >= 0.99
          )
        );
        await paint(page);
        record("settingsReadyMs", performance.now() - before);
        // Compare panel rendering from its own entry point; settings navigation is measured separately.
        before = performance.now();
        await section.click();
      } else {
        await pane.getByRole("button", { exact: true, name }).click();
      }
      const dialog = page.getByRole("dialog");
      await page.waitForFunction(
        (title) =>
          Array.from(document.querySelectorAll('[role="dialog"]')).some(
            (element) =>
              element.checkVisibility() &&
              Number(getComputedStyle(element).opacity) >= 0.99 &&
              ((title === "Library" &&
                element.textContent?.includes("Your library starts here")) ||
                (title === "Routines" &&
                  element.textContent?.includes("No routines yet")) ||
                (title === "Search history" &&
                  element.querySelector('input[id^="history-query-"]'))) &&
              (Array.from(element.querySelectorAll("h2")).some(
                (heading) => heading.textContent === title
              ) ||
                Array.from(
                  element.querySelectorAll('[role="tab"][aria-selected="true"]')
                ).some(
                  (tab) =>
                    tab.textContent?.trim() ===
                    (title === "Search history" ? "History" : title)
                ))
          ),
        name,
        { polling: "raf" }
      );
      await paint(page);
      record("panelReadyMs", performance.now() - before);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
    const streamStarted = performance.now();
    await streamReply(page);
    record("streamReadyMs", performance.now() - streamStarted);
    await verifyWorker(pane, "warm");
    const archiveFirstPage = historyPrimary
      ? await measureArchiveFirstPage(page)
      : null;
    if (historyPrimary) {
      record(
        "archiveFirstPageReadyMs",
        archiveFirstPage?.archiveFirstPageReadyMs ?? 0
      );
    }
    if (historyDiagnostics && archiveFirstPage) {
      const archiveData = archiveFirstPage;
      diagnosticRecord(
        "archiveFirstPageReadyMs",
        archiveData?.archiveFirstPageReadyMs ?? 0
      );
      diagnosticRecord(
        "archivePayloadReadyMs",
        archiveData?.archivePayloadReadyMs ?? 0
      );
      diagnosticRecord(
        "archiveResponseReadyMs",
        archiveData?.archiveResponseReadyMs ?? 0
      );
      diagnosticRecord(
        "archiveRevealPages",
        archiveData?.archiveRevealPages ?? 0
      );
      diagnosticRecord(
        "archiveResponseBytes",
        archiveData?.archiveResponseBytes ?? 0
      );
      diagnosticRecord(
        "archiveSessionCount",
        archiveData?.archiveSessionCount ?? 0
      );
      diagnosticRecord(
        "archiveRequestCount",
        archiveData?.archiveRequestCount ?? 0
      );
      await recordRendererHeap(
        cdp as unknown as CdpSessionLike,
        "rendererHeapAfterArchive"
      );
    }
    const routes = await verifyRouteNavigation(page, () => ready(page, 0));
    record("enterChatRouteReadyMs", routes.enterMs);
    record("leaveChatRouteReadyMs", routes.leaveMs);
    record("returnChatRouteReadyMs", routes.returnMs);
    if (process.env.PERF_VERIFY === "1" && sample === samples - 1) {
      await page.setViewportSize({ height: 900, width: 1440 });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.reload({ waitUntil: "commit" });
      pane = await ready(page, 0);
      await pane.locator("textarea").fill("Preserve this evaluation draft");
      await mkdir(dirname(output), { recursive: true });
      const functionalVerification = await verifyUi(page, dirname(output));
      if (historyDiagnostics) {
        diagnosticRecord(
          "functionalArchiveFirstPageReadyMs",
          functionalVerification.archiveFirstPageReadyMs
        );
        diagnosticRecord(
          "functionalArchivePayloadReadyMs",
          functionalVerification.archivePayloadReadyMs
        );
        diagnosticRecord(
          "functionalHistoryAnchorStable",
          functionalVerification.historyAnchorStable
        );
      }
    }
    assert(errors.length === 0, `Browser exceptions: ${errors.join(", ")}`);
    if (desktopApp) {
      await desktopApp.close();
    } else {
      await context.close();
    }
    if (userData) {
      await rm(userData, { force: true, recursive: true });
    }
    activeDesktop = null;
    activeUserData = null;
  }
} finally {
  await activeDesktop?.close().catch(() => undefined);
  await browser?.close();
  if (activeUserData) {
    await rm(activeUserData, { force: true, recursive: true });
  }
}
const metrics = Object.fromEntries(
  Object.entries(measurements).map(([name, values]) => {
    const sorted = values.toSorted((a, b) => a - b);
    return [
      name,
      {
        p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
        samples: values,
      },
    ];
  })
);
const result = {
  cpuSlowdown: 4,
  diagnostics,
  environment: {
    arch: process.arch,
    browser: browserVersion,
    cpu: cpus()[0]?.model,
    node: process.version,
    platform: process.platform,
  },
  evaluatorHash: await hashEvaluatorFiles(),
  fixture: workload,
  fixtureHash: await hashFixtureFiles(),
  historyExperiment,
  initialInteractions: {
    streaming: Math.floor(samples / 2),
    typing: Math.ceil(samples / 2),
  },
  metrics,
  recordedAt: new Date().toISOString(),
  runtime: desktop ? "electron" : "chromium",
  samples,
  schemaVersion: REPORT_SCHEMA_VERSION,
  sourcePatchHash: createHash("sha256")
    .update(
      execFileSync(
        "git",
        [
          "diff",
          "--binary",
          "HEAD",
          "--",
          ":/apps/hub",
          ":/apps/desktop",
          ":/templates",
          ":/images",
          ":/package.json",
          ":/pnpm-lock.yaml",
          ":/pnpm-workspace.yaml",
          ":/turbo.json",
          ":/patches",
          ":/.npmrc",
        ],
        {
          cwd: productSourceDirectory,
          maxBuffer: 16 * 1024 * 1024,
        }
      )
    )
    .digest("hex"),
  sourceRef: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: productSourceDirectory,
    encoding: "utf8",
  }).trim(),
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (process.env.PERF_BASELINE) {
  const baseline = JSON.parse(
    await readFile(resolve(process.env.PERF_BASELINE), "utf8")
  ) as typeof result;
  if (baseline.samples !== samples) {
    throw new Error("Sample count mismatch");
  }
  if (JSON.stringify(baseline.fixture) !== JSON.stringify(result.fixture)) {
    throw new Error("Fixture mismatch");
  }
  if (baseline.cpuSlowdown !== result.cpuSlowdown) {
    throw new Error("CPU slowdown mismatch");
  }
  if (
    baseline.fixtureHash !== result.fixtureHash ||
    baseline.evaluatorHash !== result.evaluatorHash ||
    baseline.runtime !== result.runtime ||
    baseline.schemaVersion !== result.schemaVersion ||
    JSON.stringify(baseline.environment) !== JSON.stringify(result.environment)
  ) {
    throw new Error("Reports must use the same evaluator and environment");
  }
  // Speed is inverse latency: +200% speed means <= one third of baseline time.
  const speedup = baseline.metrics.loadReadyMs.p50 / metrics.loadReadyMs.p50;
  console.log(`Initial readiness speedup: ${speedup.toFixed(2)}x`);
  const target = Number(process.env.PERF_TARGET_SPEEDUP ?? 3);
  if (!Number.isFinite(target) || target <= 0) {
    throw new Error("PERF_TARGET_SPEEDUP must be a positive number");
  }
  const failures =
    speedup < target
      ? [`Initial readiness must be at least ${target}x faster`]
      : [];
  for (const name of [
    "coldStreamReadyMs",
    ...(workload.bots > 1 ? ["switchReadyMs"] : []),
    "panelReadyMs",
    "typingReadyMs",
    "streamReadyMs",
    "enterChatRouteReadyMs",
    "leaveChatRouteReadyMs",
    "returnChatRouteReadyMs",
  ]) {
    if (!(metrics[name] && baseline.metrics[name])) {
      throw new Error(`Missing metric: ${name}`);
    }
    if (
      metrics[name].samples.length !== baseline.metrics[name].samples.length
    ) {
      throw new Error(`Metric sample count mismatch: ${name}`);
    }
    if (metrics[name].p95 > baseline.metrics[name].p95 * 1.1) {
      failures.push(`${name} must not regress by more than 10%`);
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
}
