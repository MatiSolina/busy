import { createServer, type Server } from "node:http";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import { afterEach, expect, it as test } from "vitest";
import {
  clickAndProbeArchive,
  readArchiveResponseBody,
  revealNewestArchivedReply,
} from "./verify-ui";

const browsers: Awaited<ReturnType<typeof chromium.launch>>[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(browsers.map((browser) => browser.close()));
  browsers.length = 0;
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  servers.length = 0;
});

test("captures one UI archive request and decodes after visible readiness", async () => {
  const browser = await chromium.launch();
  browsers.push(browser);
  const page = await browser.newPage();
  let requestCount = 0;
  const server = createServer((request, response) => {
    if (request.url?.endsWith("/past-sessions")) {
      requestCount += 1;
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ past: [] }));
      }, 50);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`
      <main>
        <div data-chat-scroll style="height:100px; overflow:auto">
          <p data-chat-earlier>Earlier</p>
          <div style="height:1000px"></div>
        </div>
      </main>
      <script>
        document.querySelector('[data-chat-scroll]').addEventListener('scroll', async () => {
          await fetch('/api/bots/perf-bot-0/past-sessions');
          document.querySelector('[data-chat-earlier]').remove();
        }, { once: true });
      </script>
    `);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a port");
  }
  await page.goto(`http://127.0.0.1:${address.port}`);
  const started = performance.now();
  const capture = await clickAndProbeArchive(
    page,
    page.locator("main"),
    started
  );
  await playwrightExpect(page.locator("[data-chat-earlier]")).toHaveCount(0);
  const visibleReadyMs = performance.now() - started;
  expect(capture.requestCount).toBe(1);
  expect(requestCount).toBe(1);
  expect(capture.responseReadyMs).toBeLessThanOrEqual(visibleReadyMs);
  const decoded = JSON.parse(
    (await readArchiveResponseBody(capture)).toString("utf8")
  ) as {
    past: unknown[];
  };
  expect(decoded.past).toHaveLength(0);
  expect(performance.now() - started).toBeGreaterThanOrEqual(visibleReadyMs);
});

test("bounds a response that never finishes", async () => {
  const browser = await chromium.launch();
  browsers.push(browser);
  const page = await browser.newPage();
  const server = createServer((request, response) => {
    if (!request.url?.endsWith("/past-sessions")) {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<div data-chat-scroll style="height:100px;overflow:auto"><div style="height:1000px"></div></div><script>document.querySelector("[data-chat-scroll]").onscroll=()=>fetch("/api/bots/perf-bot-0/past-sessions");</script>'
      );
    }
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a port");
  }
  await page.goto(`http://127.0.0.1:${address.port}`);
  await expect(
    clickAndProbeArchive(page, page.locator("body"), performance.now(), 25)
  ).rejects.toThrow("Archive response timed out");
});

test("reveals an offscreen and partially rendered archive marker", async () => {
  const browser = await chromium.launch();
  browsers.push(browser);
  const page = await browser.newPage();
  await page.setContent(`
    <section aria-label="Chat with Performance Bot 0">
      <div data-chat-scroll style="height:100px; overflow:auto">
        <div style="height:1000px"></div>
        <p data-chat-block id="reply" style="display:none">
          Evaluation 0/1/102.
        </p>
      </div>
    </section>
    <script>
      document.querySelector('[data-chat-scroll]').addEventListener('scroll', () => {
        document.querySelector('#reply').style.display = 'block';
      });
    </script>
  `);
  const pane = page.getByRole("region", {
    exact: true,
    name: "Chat with Performance Bot 0",
  });
  expect(
    await revealNewestArchivedReply(page, pane, "Evaluation 0/1/102.")
  ).toBe(1);
  expect(
    await page.locator("#reply").evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= innerHeight;
    })
  ).toBe(true);
});
