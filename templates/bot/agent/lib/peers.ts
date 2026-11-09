import { defineDynamic, defineRemoteAgent } from "eve";
import { vercelOidc } from "eve/agents/auth";
import { isConsultation } from "./caller";
import {
  consultationAuth,
  sendsConsultationCredentials,
} from "./consultation-auth";
import { hubFetch } from "./hub";

export interface Peer {
  description: string;
  /** Stable bot id (hub /api/bot/directory). Older hubs omit it. */
  id?: string;
  name: string;
  slug: string;
  url: string;
}

/** agent/subagents/peer-1.ts … peer-12.ts: bots past the last slot can't be consulted. */
export const PEER_SLOTS = 12;

// The newest PEER_SLOTS peers, still oldest first: a bot the user just created is always
// consultable. The hub maps peer-N the same way (apps/hub/lib/chat/sync.ts peerWindow).
// ponytail: past 12 peers, a new bot shifts every slot by one; more slot files if that bites.
const consultable = (dir: readonly Peer[]) =>
  dir.slice(Math.max(0, dir.length - PEER_SLOTS));

export const pickPeer = (dir: readonly Peer[], n: number): Peer | null =>
  consultable(dir)[n - 1] ?? null;

// Process cache, not ctx.memo: eve rebuilds a child's credentials from the memos it opened
// with, so a time-keyed memo breaks follow-ups (checkpoint C). Slots stay stable because
// the directory has a total order (created_at, id). The hub binds each consultation to the
// deployment that really holds the child, not to this slot (H-24). ponytail: 30 s until a new
// bot shows up.
let cached: { at: number; peers: Promise<Peer[]> } | undefined;
export function fetchDirectory(): Promise<Peer[]> {
  if (cached && Date.now() - cached.at < 30_000) {
    return cached.peers;
  }
  const peers = hubFetch("/api/bot/directory").then(async (res) => {
    if (!res.ok) {
      throw new Error(`hub directory failed: ${res.status}`);
    }
    return (await res.json()) as Peer[];
  });
  cached = { at: Date.now(), peers };
  peers.catch(() => {
    cached = undefined;
  });
  return peers;
}

// Names and descriptions are user text inside the prompt: one line each, and angle brackets as
// look-alikes, so a description can't close the block and speak as instructions.
const inline = (text: string) =>
  text.replace(/</gu, "‹").replace(/>/gu, "›").replace(/\s+/gu, " ").trim();

// Recalled every turn like memory: data about peers, never instructions.
export function formatDirectory(dir: readonly Peer[]): string {
  const peers = consultable(dir);
  const lines = peers.map(
    (p, i) =>
      `- ${inline(p.name)} (tool peer-${i + 1}): ${inline(p.description)}`
  );
  // Older bots past the slots still exist: name them so the bot never says they don't.
  const older = dir
    .slice(0, dir.length - peers.length)
    .map((p) => inline(p.name));
  return [
    "<bot_directory>",
    "Other bots you can consult with a private question. They reply with text only.",
    ...(lines.length ? lines : ["No other bots yet."]),
    ...(older.length
      ? [
          `Also exist but can't be consulted (no free slot): ${older.join(", ")}.`,
        ]
      : []),
    "</bot_directory>",
  ].join("\n");
}

// A fixed number of slots so bots created later appear without redeploying this one (spec 4.7).
export function peerSlot(n: number) {
  return defineDynamic(async (ctx) => {
    if (isConsultation(ctx.session.auth)) {
      return null; // one hop
    }
    const peer = pickPeer(await fetchDirectory(), n);
    if (!peer) {
      return null;
    }
    return defineRemoteAgent({
      // H-26: a hub credential scoped to this peer once the switch is on (docs/consultations.md);
      // until then, and for a hub that doesn't send ids yet, the bot's own OIDC token.
      auth:
        sendsConsultationCredentials() && peer.id
          ? consultationAuth(peer.id)
          : vercelOidc(),
      description: `${peer.name}: ${peer.description} Ask it a question; it replies with text only.`,
      url: peer.url,
    });
  });
}
