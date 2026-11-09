import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, firesides } from "../db";
import { need } from "../env";
import { getFireside } from "./store";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const PROOF = /^[a-f0-9]{64}$/u;

export function participantProof(id: string) {
  return createHmac("sha256", need("SESSION_SECRET"))
    .update(`busy:fireside:${id}`)
    .digest("hex");
}

/** OIDC proves the deployment; this separate opaque proof binds its private runtime session. */
export async function runtimeParticipant(req: Request, slug: string) {
  const id = req.headers.get("x-busy-fireside-id");
  const participantId = req.headers.get("x-busy-fireside-participant");
  const session = req.headers.get("x-busy-fireside-session");
  const proof = req.headers.get("x-busy-fireside-proof");
  if (
    !(
      id &&
      participantId &&
      session &&
      proof &&
      UUID.test(id) &&
      UUID.test(participantId) &&
      PROOF.test(proof)
    )
  ) {
    return null;
  }
  const expected = participantProof(participantId);
  if (!timingSafeEqual(Buffer.from(proof), Buffer.from(expected))) {
    return null;
  }
  const row = await getFireside(id);
  if (row?.state.status !== "running" || !row.state.active) {
    return null;
  }
  const participant = row.state.participants[row.state.active.participant];
  if (
    participant.id !== participantId ||
    participant.slug !== slug ||
    participant.sessionId !== session
  ) {
    return null;
  }
  return {
    participant,
    revision: row.state.active.revision,
    row,
    sessionId: session,
  };
}

export async function countModelRequest(
  id: string,
  participantId: string,
  sessionId: string,
  revision: number
) {
  const rows = await db()
    .update(firesides)
    .set({
      state: sql`jsonb_set(${firesides.state}, '{active,modelRequests}', to_jsonb(coalesce((${firesides.state}->'active'->>'modelRequests')::integer, 0) + 1))`,
    })
    .where(
      sql`${firesides.id} = ${id} and ${firesides.status} = 'running' and (${firesides.state}->'active'->>'revision')::integer = ${revision} and ${firesides.state}->'participants'->(${firesides.state}->'active'->>'participant')->>'sessionId' = ${sessionId} and ${firesides.state}->'active' is not null and coalesce((${firesides.state}->'active'->>'modelRequests')::integer, 0) < 32 and ${firesides.state}->'participants'->(${firesides.state}->'active'->>'participant')->>'id' = ${participantId}`
    )
    .returning({ id: firesides.id });
  return rows.length === 1;
}
