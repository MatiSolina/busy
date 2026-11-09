import { idle } from "eve/events";
import { defineHook } from "eve/hooks";
import {
  claimShutdown,
  confirmShutdown,
  releaseShutdown,
  type ShutdownClaim,
} from "../lib/computer";
import { computerOwner, runningJobs, shouldStop } from "../lib/lifecycle";

// Stop the bot's computer when a turn settles instead of billing it until the 45-minute timeout.
// eve resumes a stopped sandbox on its next use (it already resumes it at each turn's start),
// files and /data intact; only processes die, and `desktop` restarts the screen. Stopping also
// makes /data writes visible to consultations' Drive snapshots.
//
// The hub must grant the stop (apps/hub/app/api/bot/live): a claim bound to this session, checked
// again before closing Chrome and committed right before `sandbox.stop()`. The user opening Live, a
// new message or a login hold in between invalidates it. Without a verified claim (the hub down or
// an unclear answer) nothing is stopped: the sandbox's own timeout ends it later.
export default defineHook({
  events: {
    async "turn.settled"(_event, ctx) {
      let lease: ShutdownClaim | null = null;
      try {
        if (
          !shouldStop({
            idle: idle(ctx.view),
            owner: computerOwner(),
            session: ctx.session,
          })
        ) {
          return;
        }
        lease = await claimShutdown(ctx.session.id, ctx.occurrence.abortSignal);
        if (!lease) {
          return; // watched, kept on, or not verifiable: the timeout bounds it
        }
        const sandbox = await ctx.getSandbox();
        const signal = AbortSignal.any([
          ctx.occurrence.abortSignal,
          AbortSignal.timeout(10_000),
        ]);
        const jobs = await sandbox.run({ command: runningJobs(), signal });
        if (jobs.stdout.trim()) {
          return; // a background command the model expects to keep running
        }
        if (!(await confirmShutdown(lease, "verify", signal))) {
          return; // Live opened or work arrived: Chrome stays as it is
        }
        // Close the shared browser connection before stopping compute. The image wrapper's stop
        // command is a no-op when no browser was opened and must never boot Chrome or create one.
        try {
          const browser = await sandbox.run({
            command: "desktop-browser stop",
            signal,
          });
          if (browser.exitCode !== 0) {
            console.warn("suspend: could not close the desktop browser", {
              exitCode: browser.exitCode,
              sessionId: ctx.session.id,
              stderr: browser.stderr,
            });
          }
        } catch (error) {
          // Closing the wrapper is best effort; the commit below still decides the stop.
          console.warn("suspend: could not close the desktop browser", {
            error,
            sessionId: ctx.session.id,
          });
        }
        if (!(await confirmShutdown(lease, "commit", signal))) {
          return; // lost after closing Chrome: Live or the next turn opens it again
        }
        // Awaited: the sandbox handle belongs to this step, and a late stop could hit the next turn.
        await sandbox.stop();
      } catch (error) {
        // The reply is already out; a failed stop only means the timeout stops it later.
        console.warn("suspend: could not stop the computer", {
          error,
          sessionId: ctx.session.id,
        });
      } finally {
        if (lease) {
          await releaseShutdown(lease);
        }
      }
    },
  },
});
