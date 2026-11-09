import type { BotRow } from "../db";
import type { FiresideState, Participant, Speaker } from "./types";

export function bot(
  slug = "primary",
  model = "chatgpt/gpt-6",
  billing: BotRow["billing"] = "chatgpt"
): BotRow {
  return {
    avatar: null,
    billing,
    createdAt: new Date(),
    deletionAttempts: 0,
    deletionLastError: null,
    deletionNextAttemptAt: null,
    deletionProjectId: null,
    deletionRequestedAt: null,
    deletionState: null,
    deletionToken: null,
    deployFinishedAt: null,
    deployGeneration: 1,
    deploymentId: null,
    deployRecoveries: 0,
    deployStartedAt: null,
    description: "",
    error: null,
    fast: false,
    historyPending: false,
    id:
      slug === "primary"
        ? "11111111-1111-4111-8111-111111111111"
        : "22222222-2222-4222-8222-222222222222",
    instructions: "",
    liveUntil: null,
    model,
    name: slug,
    promotionDeploymentId: null,
    promotionUntil: null,
    sessionId: "normal-session",
    slug,
    status: "ready",
    updatedAt: new Date(),
    url: null,
    vercelProjectId: null,
  };
}
export function initialState(): FiresideState {
  const participant = (role: Speaker): Participant => ({
    allocating: false,
    avatar: null,
    billing: role === "primary" ? "chatgpt" : "grok",
    botId: bot(role).id,
    cursor: 0,
    generation: 0,
    id:
      role === "primary"
        ? "33333333-3333-4333-8333-333333333333"
        : "44444444-4444-4444-8444-444444444444",
    memory: "Private memory",
    memoryVersion: 0,
    model: role === "primary" ? "chatgpt/gpt-6" : "grok/grok-4.7",
    name: role,
    sessionId: `fire-${role}`,
    slug: role,
    temporary: false,
  });
  return {
    active: null,
    cancelSessions: [],
    context: "User: Should we ship?",
    error: null,
    lastSpeaker: "primary",
    messages: [],
    participants: {
      guest: participant("guest"),
      primary: participant("primary"),
    },
    remaining: { guest: 1, primary: 1 },
    revision: 1,
    status: "running",
    summary: null,
    summaryVersion: 0,
  };
}
export function activate(state: FiresideState, participant: Speaker) {
  state.active = {
    deliveryId: `delivery-${state.revision}`,
    deltas: {},
    messageId: `message-${state.revision}`,
    modelRequests: 0,
    participant,
    revision: state.revision,
    rows: [],
    startedAt: new Date().toISOString(),
    turnId: null,
  };
}
