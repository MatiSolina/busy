import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const LOOPBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/auth/callback";
const OPENAI_AUTHORIZE_ORIGIN = "https://auth.openai.com";
const OPENAI_AUTHORIZE_PATH = "/api/accounts/authorize";
const CALLBACK_TIMEOUT_MS = 15 * 60 * 1000;

function asUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function validAttempt(attempt, redirectUri, now) {
  if (!attempt || typeof attempt !== "object") {
    return null;
  }
  if (attempt.provider !== "chatgpt" || attempt.kind !== "browser") {
    return null;
  }
  if (typeof attempt.attemptId !== "string" || !attempt.attemptId) {
    return null;
  }
  if (typeof attempt.expiresAt !== "number" || attempt.expiresAt <= now) {
    return null;
  }
  const authorize = asUrl(attempt.url);
  const redirect = asUrl(redirectUri);
  if (!(authorize && redirect)) {
    return null;
  }
  if (
    authorize.protocol !== "https:" ||
    authorize.origin !== OPENAI_AUTHORIZE_ORIGIN ||
    authorize.pathname !== OPENAI_AUTHORIZE_PATH ||
    authorize.username ||
    authorize.password ||
    authorize.hash
  ) {
    return null;
  }
  if (authorize.searchParams.get("redirect_uri") !== redirect.href) {
    return null;
  }
  const state = authorize.searchParams.get("state");
  if (!state || state.length > 512) {
    return null;
  }
  return { attemptId: attempt.attemptId, expiresAt: attempt.expiresAt, state };
}

function callbackUrl(port, url) {
  const parsed = asUrl(new URL(url ?? "", `http://${LOOPBACK_HOST}:${port}`));
  if (
    !parsed ||
    parsed.pathname !== CALLBACK_PATH ||
    parsed.search.length > 2048
  ) {
    return null;
  }
  return `http://${LOOPBACK_HOST}:${port}${parsed.pathname}${parsed.search}`;
}

function reply(res, status, title, message) {
  const safeTitle = ["Connected", "Connection pending"].includes(title)
    ? title
    : "Connection failed";
  const nonce = randomBytes(16).toString("base64url");
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`;
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><title>${safeTitle}</title><style>body{background:#0a0a0a;color:#f5f5f5;font:16px system-ui,sans-serif;display:grid;min-height:100vh;place-items:center;margin:0}main{max-width:30rem;padding:2rem;text-align:center}p{color:#a3a3a3;line-height:1.5}</style></head><body><main><h1>${safeTitle}</h1><p>${message}</p><script nonce="${nonce}">window.close()</script></main></body></html>`;
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": csp,
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

/**
 * Owns the short-lived loopback listener used by Sign in with ChatGPT.
 * Tokens never pass through this module: it forwards only the OAuth callback
 * to the authenticated hub session.
 */
export function createChatGptBroker({
  hub,
  fetchImpl,
  now = () => Date.now(),
  openExternal = async () => {
    // The desktop process supplies the real external-browser handler.
  },
} = {}) {
  const base = new URL(hub ?? "https://app.busybot.dev");
  let server = null;
  let port = null;
  let prepared = null;
  let opened = null;
  let forwardingGeneration = null;
  let expirationTimer = null;
  let listenerGeneration = 0;
  let preparePromise = null;

  const clear = () => {
    listenerGeneration += 1;
    if (expirationTimer) {
      clearTimeout(expirationTimer);
    }
    expirationTimer = null;
    opened = null;
    prepared = null;
    const current = server;
    server = null;
    port = null;
    preparePromise = null;
    forwardingGeneration = null;
    if (current) {
      current.close();
    }
  };

  const clearGeneration = (generation) => {
    if (generation === listenerGeneration) {
      clear();
    }
  };

  const forward = async (fullCallbackUrl) => {
    const currentOpened = opened;
    if (!currentOpened) {
      return false;
    }
    const fetcher = fetchImpl ?? fetch;
    const response = await fetcher(
      `${base.origin}/api/ai/connections/chatgpt/complete`,
      {
        body: JSON.stringify({
          attemptId: currentOpened.attemptId,
          callbackUrl: fullCallbackUrl,
        }),
        credentials: "include",
        headers: { "Content-Type": "application/json", Origin: base.origin },
        method: "POST",
        signal: AbortSignal.timeout(20_000),
      }
    );
    const body = await response.json().catch(() => null);
    if (response.ok && body?.status === "connected") {
      return "connected";
    }
    if (
      body?.status === "pending" ||
      (response.status === 429 && body?.error === "pending")
    ) {
      return "pending";
    }
    return "failed";
  };

  const handle = async (req, res) => {
    if (req.method !== "GET") {
      reply(
        res,
        405,
        "Connection failed",
        "This callback can only be opened by ChatGPT."
      );
      return;
    }
    const current = callbackUrl(port, req.url ?? "");
    if (
      !(current && opened) ||
      opened.generation !== listenerGeneration ||
      forwardingGeneration === listenerGeneration
    ) {
      reply(
        res,
        400,
        "Connection failed",
        "This connection window is no longer valid."
      );
      return;
    }
    const parsed = new URL(current);
    const requestGeneration = listenerGeneration;
    if (
      parsed.searchParams.get("state") !== opened.state ||
      now() >= opened.expiresAt
    ) {
      reply(
        res,
        400,
        "Connection failed",
        "This connection window is no longer valid."
      );
      return;
    }
    try {
      forwardingGeneration = requestGeneration;
      const forwarded = await forward(current);
      if (forwarded === "failed") {
        reply(
          res,
          502,
          "Connection failed",
          "Busy could not finish the connection. Close this window and try again."
        );
        return;
      }
      if (forwarded === "pending") {
        reply(
          res,
          202,
          "Connection pending",
          "Busy is still finishing the connection. You can close this window."
        );
        return;
      }
      reply(
        res,
        200,
        "Connected",
        "Busy finished the connection. You can close this window."
      );
    } catch {
      reply(
        res,
        502,
        "Connection failed",
        "Busy could not finish the connection. Close this window and try again."
      );
    } finally {
      if (forwardingGeneration === requestGeneration) {
        forwardingGeneration = null;
      }
      clearGeneration(requestGeneration);
    }
  };

  const prepare = () => {
    if (server && prepared) {
      return Promise.resolve({ redirectUri: prepared });
    }
    if (preparePromise) {
      return preparePromise;
    }
    const generation = listenerGeneration;
    const next = createServer((req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) {
          reply(
            res,
            502,
            "Connection failed",
            "Busy could not finish the connection."
          );
        }
      });
    });
    const listen = new Promise((resolve, reject) => {
      next.once("error", reject);
      next.listen(0, LOOPBACK_HOST, () => {
        next.off("error", reject);
        resolve();
      });
    });
    const pending = listen.then(() => {
      const address = next.address();
      if (
        generation !== listenerGeneration ||
        !address ||
        typeof address === "string"
      ) {
        next.close();
        throw new Error(
          "Busy could not start the local authorization callback."
        );
      }
      server = next;
      ({ port } = address);
      prepared = `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`;
      expirationTimer = setTimeout(
        () => clearGeneration(generation),
        CALLBACK_TIMEOUT_MS
      );
      return { redirectUri: prepared };
    });
    preparePromise = pending;
    pending.then(
      () => {
        if (preparePromise === pending) {
          preparePromise = null;
        }
      },
      () => {
        if (preparePromise === pending) {
          preparePromise = null;
        }
      }
    );
    return pending;
  };

  const open = async (attempt) => {
    const identity = validAttempt(attempt, prepared, now());
    if (!(identity && server && prepared)) {
      throw new Error("The ChatGPT authorization is invalid.");
    }
    opened = { ...identity, generation: listenerGeneration };
    await openExternal(attempt.url);
  };

  return {
    cancel: clear,
    open,
    prepare,
    get redirectUri() {
      return prepared;
    },
  };
}

export {
  CALLBACK_PATH,
  LOOPBACK_HOST,
  OPENAI_AUTHORIZE_ORIGIN,
  OPENAI_AUTHORIZE_PATH,
};
