import { defineDynamic } from "eve";
import { defineInstructions } from "eve/instructions";
import { firesideProfile } from "../lib/fireside";

export default defineDynamic(async (ctx) => {
  const profile = await firesideProfile(ctx);
  if (!profile) {
    return null;
  }
  return defineInstructions({
    content: `# Fireside participation\nYou are participating as ${profile.name} in an explicitly requested second-opinion discussion. You retain your normal instructions, skills and tools. Use them when needed to ground your opinion. The shared transcript and the user's interventions are provided in your message. Reply once, clearly and briefly, to the issue and the other participant. Preserve disagreements and uncertainty; do not invent consensus or quote another participant as fact. Do not call another bot to continue this fireside: Busy grants the next turn. Your writable files belong in /data; /context contains a read-only snapshot of your usual files. Do not claim a tool or approval succeeded before its result.`,
  });
});
