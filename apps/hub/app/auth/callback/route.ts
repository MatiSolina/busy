import { randomBytes } from "node:crypto";
import { attemptIdFromState } from "@/lib/ai/subscription-protocols";
import {
  completeLoopbackCallback,
  SubscriptionAttemptNotFoundError,
} from "@/lib/ai/subscription-store";
import { SubscriptionConnectionError } from "@/lib/ai/subscription-types";

const headers = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "no-referrer",
};

function page(title: string, message: string, status: number): Response {
  const nonce = randomBytes(16).toString("base64");
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style nonce="${nonce}">:root{color-scheme:dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#f5f5f5}body{display:grid;min-height:100vh;margin:0;place-items:center}main{width:min(420px,calc(100% - 40px));border:1px solid #2a2a2a;background:#111;padding:28px;box-sizing:border-box}h1{font-size:20px;font-weight:600;margin:0 0 10px}p{color:#a3a3a3;line-height:1.5;margin:0}</style></head><body><main><h1>${title}</h1><p>${message}</p></main><script nonce="${nonce}">window.close()</script></body></html>`,
    {
      headers: {
        ...headers,
        "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; frame-ancestors 'none'`,
        "X-Content-Type-Options": "nosniff",
      },
      status,
    }
  );
}

function loopbackRequestUrl(request: Request): URL | null {
  const source = URL.parse(request.url);
  const host = request.headers.get("host");
  if (!(source && host)) {
    return null;
  }
  const parsedHost = URL.parse(`http://${host}`);
  if (
    parsedHost?.hostname !== "127.0.0.1" ||
    !parsedHost?.port ||
    parsedHost?.username ||
    parsedHost?.password ||
    parsedHost?.pathname !== "/"
  ) {
    return null;
  }
  const port = Number(parsedHost.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }
  return URL.parse(
    `http://127.0.0.1:${port}${source.pathname}${source.search}`
  );
}

export async function GET(request: Request) {
  const url = loopbackRequestUrl(request);
  if (!url) {
    return page(
      "Busy connection",
      "This callback must be opened on Busy locally.",
      400
    );
  }
  const state = url.searchParams.get("state");
  const attemptId = state ? attemptIdFromState(state) : null;
  if (!attemptId) {
    return page(
      "Connection could not be verified",
      "Start the connection again in Busy.",
      400
    );
  }
  try {
    const result = await completeLoopbackCallback(attemptId, url.href);
    if (result.status === "connected") {
      return page(
        "ChatGPT connected",
        "You can return to Busy. This window can be closed.",
        200
      );
    }
    if (result.status === "failed") {
      return page(
        "Connection could not be completed",
        "Start the connection again in Busy.",
        409
      );
    }
    return page(
      "Connection is still waiting",
      "Return to Busy while the connection finishes.",
      202
    );
  } catch (error) {
    if (error instanceof SubscriptionAttemptNotFoundError) {
      return page(
        "Connection expired",
        "Start the connection again in Busy.",
        404
      );
    }
    if (error instanceof SubscriptionConnectionError) {
      return page(
        "Connection could not be completed",
        "Start the connection again in Busy.",
        409
      );
    }
    return page(
      "Connection could not be completed",
      "Start the connection again in Busy.",
      503
    );
  }
}
