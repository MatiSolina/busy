import { defineState } from "eve/context";
import { isConsultation } from "./caller";

// Which session opened this computer, written by the sandbox selector. A built-in `agent` copy
// runs its parent's selector and records the parent's id, so only the owner ever stops it.
const owner = defineState("busy.computer-owner", (): string | null => null);

export function markComputerOpened(sessionId: string) {
  try {
    owner.update(() => sessionId);
  } catch (error) {
    // Bookkeeping must never break opening the computer: worst case it idles until its timeout.
    console.warn("lifecycle: could not record who opened the computer", {
      error,
    });
  }
}

export const computerOwner = (): string | null => owner.get();

interface Session {
  auth: Parameters<typeof isConsultation>[0];
  id: string;
  parent?: unknown;
}

export function shouldStop({
  idle,
  owner: sessionOwner,
  session,
}: {
  idle: boolean;
  owner: string | null;
  session: Session;
}) {
  // Something is about to use the computer again: a working task, a queued message, a compaction.
  if (!idle) {
    return false;
  }
  // The hub's chat (no parent, not a bot) owns its computer and needs one anyway, so it also stops
  // one opened before this marker existed. Consultations carry no parent lineage: tell them by caller.
  if (session.parent === undefined && !isConsultation(session.auth)) {
    return true;
  }
  // A consultation stops only a computer it opened: asking for one it never had would create it.
  // A copy shares its parent's computer, which the parent stops when its own turn settles.
  return sessionOwner === session.id;
}

// Prints `running` for each bash command still running in the background (eve keeps them in
// /tmp/.eve/jobs/<id>/ until they write `exit`). Files outlive a stop but processes don't,
// so a job whose process group is gone doesn't count.
export const runningJobs = (root = "/tmp/.eve/jobs") =>
  `for d in ${root}/*/; do [ -e "\${d}exit" ] && continue; p=$(cat "\${d}pid" 2>/dev/null) && kill -0 -- "-$p" 2>/dev/null && echo running; done; true`;
