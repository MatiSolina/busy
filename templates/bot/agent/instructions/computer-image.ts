import { defineDynamic, defineInstructions } from "eve/instructions";
import { computerImage, imageNotice } from "../lib/computer-image";

// Tells the agent when its computer comes from an older bot image (lib/computer-image.ts), so a
// misbehaving desktop/browser helper is reported to the user instead of "fixed" by the agent.
export default defineDynamic(() => {
  const notice = imageNotice(computerImage());
  return notice
    ? defineInstructions({ content: notice, role: "system" })
    : null;
});
