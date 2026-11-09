export type ChatErrorKind =
  | "rate_limit"
  | "credits"
  | "context"
  | "auth"
  | "model_unavailable"
  | "timeout"
  | "network"
  | "content_filter"
  | "unknown";

const RULES: { kind: ChatErrorKind; test: RegExp }[] = [
  {
    kind: "credits",
    test: /insufficient (?:funds|credits|balance)|out of credits|payment required|\b402\b|billing|quota exceeded|spend limit/iu,
  },
  {
    kind: "rate_limit",
    test: /rate.?limit|usage limit|limit reached|· resets|too many requests|\b429\b|overloaded|capacity|try again (?:later|at|in)/iu,
  },
  {
    kind: "context",
    test: /context (?:length|window)|too many tokens|maximum.*tokens|prompt is too long|input is too long/iu,
  },
  {
    kind: "auth",
    test: /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid api key|authentication/iu,
  },
  {
    kind: "model_unavailable",
    test: /model.*(?:not found|does not exist|not supported|unavailable|deprecated)|no (?:such|available) model|\b404\b/iu,
  },
  { kind: "content_filter", test: /content (?:filter|policy)|safety|refus/iu },
  { kind: "timeout", test: /timed? ?out|deadline exceeded|\b504\b/iu },
  {
    kind: "network",
    test: /fetch failed|network|econn(?:reset|refused)|socket|\b50[023]\b|bad gateway|service unavailable/iu,
  },
];

export function classifyChatError(message: string): ChatErrorKind {
  return RULES.find((rule) => rule.test.test(message))?.kind ?? "unknown";
}

const COPY: Record<ChatErrorKind, string> = {
  auth: "The model refused this bot's credentials. Check the bot's model settings.",
  content_filter:
    "The model declined to answer this one. Try rephrasing the request.",
  context:
    "This conversation got too long for the model. Ask for a shorter task, or start fresh by editing the bot.",
  credits:
    "The AI provider ran out of credit for this bot. Top up AI Gateway credits or switch the bot to another model.",
  model_unavailable:
    "This bot's model isn't available. Pick another model in the bot's settings.",
  network: "Couldn't reach the model. Send your message again in a moment.",
  rate_limit:
    "The model is busy right now. Wait a minute and send your message again.",
  timeout: "The model took too long to answer. Send your message again.",
  unknown: "Something went wrong with the model. Send your message again.",
};

const CLAUDE_RESET = /· resets [^·]+/iu;
const CLAUDE_RESET_PREFIX = /^· resets /iu;
const CODEX_RESET = /try again at .+?\.?$/iu;
const CODEX_RESET_PREFIX = /^try again at /iu;
const TRAILING_DOT = /\.$/u;

// A reset time the provider gave ("· resets 6:50pm", "try again at 4:44 PM") is worth more than the generic copy.
function resetTime(message: string): string | undefined {
  const claude = CLAUDE_RESET.exec(message)?.[0].replace(
    CLAUDE_RESET_PREFIX,
    ""
  );
  const codex = CODEX_RESET.exec(message)?.[0]
    .replace(CODEX_RESET_PREFIX, "")
    .replace(TRAILING_DOT, "");
  return (claude ?? codex)?.trim() || undefined;
}

/** What the user reads when the model fails: plain words and the one thing to do next, never a stack of codes. */
export function chatErrorCopy(message: string | undefined): string {
  if (!message?.trim()) {
    return COPY.unknown;
  }
  const kind = classifyChatError(message);
  const reset = kind === "rate_limit" ? resetTime(message) : undefined;
  return reset
    ? `The model hit its usage limit. It resets at ${reset}.`
    : COPY[kind];
}
