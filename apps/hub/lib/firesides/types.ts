import type { Billing } from "../bots/models";
import type { ChatItem, ClientRow } from "../chat/items";

export type Speaker = "primary" | "guest";
export type FiresideStatus =
  | "running"
  | "paused"
  | "waiting"
  | "closing"
  | "closed"
  | "failed";
export interface Participant {
  allocating: boolean;
  avatar: string | null;
  billing: Billing;
  botId: string;
  cursor: number;
  generation: number;
  id: string;
  memory: string;
  memoryVersion: number;
  model: string;
  name: string;
  sessionId: string | null;
  slug: string;
  temporary: boolean;
}
export interface FiresideMessage {
  at: string;
  id: string;
  interrupted?: boolean;
  items?: ChatItem[];
  runtime?: FiresideRuntime;
  speaker: Speaker | "user";
  text: string;
}
export interface FiresideRuntimeEvent {
  at: string | null;
  callId: string | null;
  interactionId: string | null;
  line: number;
  outcome: string | null;
  runId: string | null;
  spanId: string | null;
  traceId: string | null;
  turnId: string | null;
  type: string;
}
export interface FiresideRuntime {
  calls: ClientRow[];
  deliveryId?: string | null;
  events?: FiresideRuntimeEvent[];
  /** Optional for old persisted states; true means earlier events exceeded the private cap. */
  eventsTruncated?: boolean;
  model?: string;
  provider?: Billing;
  sessionId: string;
  turnId?: string | null;
}
export interface ActiveTurn {
  contentKinds?: Record<string, string>;
  deliveryId: string | null;
  deltas: Record<string, string>;
  eventMetadata?: FiresideRuntimeEvent[];
  /** Optional for old active states; set once event metadata evicts older entries. */
  eventsTruncated?: boolean;
  messageId: string;
  modelRequests: number;
  participant: Speaker;
  revision: number;
  rows: ClientRow[];
  startedAt: string;
  turnId: string | null;
}
/**
 * One participant session being ended (N-05): requested → `session.ended` confirmed
 * (`computerStopPending`) → computer stopped → removed. Time only spaces retries; it never confirms.
 */
export interface FiresideCancellation {
  attempts: number;
  /** `session.ended` is confirmed; the computer stop still has to succeed. */
  computerStopPending: boolean;
  /** The participant's generation when the cancellation was requested. */
  generation: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  participantId: string;
  requestedAt: string;
}
export interface FiresideState {
  active: ActiveTurn | null;
  cancellations?: Record<string, FiresideCancellation>;
  /** Session ids still to end. Metadata lives in `cancellations` (absent in older rows). */
  cancelSessions: string[];
  context: string;
  error: string | null;
  lastSpeaker: Speaker;
  messages: FiresideMessage[];
  participants: Record<Speaker, Participant>;
  remaining: Record<Speaker, number>;
  revision: number;
  status: FiresideStatus;
  summary: string | null;
  summaryVersion: number;
}
export type FiresideCommand =
  | { id: string; revision: number; kind: "continue" | "pause" | "close" }
  | { id: string; revision: number; kind: "intervene"; text: string };
export type PublicParticipant = Pick<
  Participant,
  "id" | "name" | "avatar" | "model" | "billing" | "slug"
>;
export interface FiresideView {
  active: { speaker: Speaker; messageId: string; items: ChatItem[] } | null;
  createdAt: string;
  error: string | null;
  id: string;
  messages: FiresideMessage[];
  participants: Record<Speaker, PublicParticipant>;
  primarySlug: string;
  revision: number;
  status: FiresideStatus;
  summary: string | null;
}
export const SECOND_OPINION_COMMAND = /^\/second[ -]opinion\s*$/iu;
export const otherSpeaker = (speaker: Speaker): Speaker =>
  speaker === "primary" ? "guest" : "primary";
