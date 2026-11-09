// Dev CLI: talk to a deployed bot as the hub.
// Usage: node --env-file=.env.local scripts/chat.ts <slug> <sessionId|new> "<message>" [fileUrl mediaType filename]
import { randomUUID } from "node:crypto";
import {
  type BotCall,
  createSession,
  readStream,
  sendMessage,
} from "../lib/eve/client.ts";

const [slug, sessionArg, text, fileUrl, mediaType, filename] =
  process.argv.slice(2);
if (!(slug && sessionArg && text)) {
  throw new Error('usage: chat.ts <slug> <sessionId|new> "<message>"');
}

const token = process.env.VERCEL_OIDC_TOKEN;
if (!token) {
  throw new Error("VERCEL_OIDC_TOKEN is required");
}
if (fileUrl && !(mediaType && filename)) {
  throw new Error("File attachments require a media type and filename");
}

// Through the deployed hub's dev relay: bots reject tokens from `vercel env pull`.
const bot: BotCall = {
  token: () => Promise.resolve(token),
  url: `${process.env.RELAY_URL ?? "https://app.busybot.dev"}/api/dev/bots/${slug}`,
};
const sessionId =
  sessionArg === "new" ? await createSession(bot, randomUUID()) : sessionArg;
const files =
  fileUrl && mediaType && filename
    ? [{ filename, mediaType, url: fileUrl }]
    : [];
const { deliveryId } = await sendMessage(bot, sessionId, {
  files,
  id: randomUUID(),
  text,
});
console.error(`session ${sessionId} delivery ${deliveryId}`);

interface Fact {
  data: Record<string, unknown>;
  type: string;
}
let reply = "";
let started = false;
for await (const { record } of readStream(bot, sessionId, 0, true)) {
  for (const fact of (record.facts as Fact[] | undefined) ?? []) {
    if (
      fact.type === "delivery.admitted" &&
      fact.data.deliveryId === deliveryId
    ) {
      started = true;
    }
    if (!started) {
      continue;
    }
    if (fact.type === "call.requested") {
      console.error(
        `  → ${String(fact.data.name ?? fact.data.toolName ?? "tool")}`
      );
    }
    if (fact.type === "content.completed" && fact.data.kind === "text") {
      reply += String(fact.data.value);
    }
    if (fact.type === "turn.settled") {
      console.log(reply || `(turn ${String(fact.data.outcome)})`);
      process.exit(0);
    }
  }
}
