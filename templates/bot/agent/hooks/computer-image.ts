import { defineHook } from "eve/hooks";
import {
  BOT_BASE_IMAGE_VERSION,
  checkComputerImage,
  needsImageCheck,
} from "../lib/computer-image";
import { computerOwner } from "../lib/lifecycle";

// eve runs the sandbox selector once per session; later turns and deployments resume the same
// computer without it. So the image check the selector does after opening also runs here, before
// the first model call of a turn, once per session and expected image version. It only reads the
// marker of a computer this session already opened (it never creates one) and only reports.
export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      if (
        computerOwner() === null ||
        !needsImageCheck(BOT_BASE_IMAGE_VERSION)
      ) {
        return;
      }
      try {
        const sandbox = await ctx.getSandbox();
        await checkComputerImage(
          sandbox,
          BOT_BASE_IMAGE_VERSION,
          ctx.session.id
        );
      } catch (error) {
        console.warn(
          "computer-image: could not check this session's computer",
          {
            error,
            sessionId: ctx.session.id,
          }
        );
      }
    },
  },
});
