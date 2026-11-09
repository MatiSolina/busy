import { getVercelOidcToken } from "@vercel/oidc";
import { getBot } from "../bots/service";
import { need } from "../env";
import type { BotCall } from "../eve/client";
import { signFiresideToken } from "../hub-token";
import {
  type ControlAction,
  desktopControlInSandbox,
  openLiveInSandbox,
  stopComputerInSandbox,
} from "../live";
import { participantProof } from "./auth";
import type { Participant } from "./types";

export function firesideCall(id: string, participant: Participant): BotCall {
  const proof = participantProof(participant.id);
  const relay = process.env.DEV_RELAY_URL;
  return {
    fetchImpl: (input, init) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }),
    headers: relay
      ? {
          "x-busy-fireside-id": id,
          "x-busy-fireside-participant": participant.id,
          "x-busy-fireside-proof": proof,
        }
      : undefined,
    token: relay
      ? () => getVercelOidcToken()
      : () => signFiresideToken(participant.slug, id, participant.id, proof),
    url: relay
      ? `${relay}/api/dev/bots/${participant.slug}`
      : `https://${participant.slug}.${need("BOTS_DOMAIN")}`,
  };
}

export type ComputerCommand =
  | { kind: "stop" }
  | { kind: "open" }
  | { kind: "control"; action: ControlAction; viewerId: string };
export async function firesideComputer(
  id: string,
  participant: Participant,
  command: ComputerCommand,
  sessionId = participant.sessionId
) {
  if (!sessionId) {
    throw new Error("The participant has no computer yet.");
  }
  const relay = process.env.DEV_RELAY_URL;
  if (relay) {
    const response = await fetch(`${relay}/api/dev/firesides/${id}/computer`, {
      body: JSON.stringify({
        command,
        participantId: participant.id,
        sessionId,
      }),
      headers: {
        authorization: `Bearer ${await getVercelOidcToken()}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error("The fireside computer is unavailable.");
    }
    return response.json();
  }
  const bot = await getBot(participant.slug);
  if (!bot) {
    throw new Error("The participant is unavailable.");
  }
  const isolated = { ...bot, sessionId };
  if (command.kind === "stop") {
    await stopComputerInSandbox(isolated);
    return { ok: true };
  }
  if (command.kind === "open") {
    return openLiveInSandbox(isolated, "control");
  }
  return desktopControlInSandbox(isolated, command.action, command.viewerId);
}
