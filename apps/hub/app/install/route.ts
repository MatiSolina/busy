import { need } from "@/lib/env";
import { installScript, release } from "@/lib/install";

const SAFE_ORIGIN = /^https?:\/\/[a-z0-9.-]+(?<port>:\d+)?$/iu;

// `curl -fsSL https://busy.matisolina.com/install | sh` (spec 4.8). Always 200: with `curl -f`, an error
// status would hide the script's own message about why it refuses to install.
export function GET(req: Request) {
  // The origin is pasted into a shell script: only a plain scheme://host[:port] goes in.
  const { origin } = new URL(req.url);
  const hub = SAFE_ORIGIN.test(origin) ? origin : need("HUB_URL");
  return new Response(installScript(hub, release()), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/x-shellscript; charset=utf-8",
    },
  });
}
