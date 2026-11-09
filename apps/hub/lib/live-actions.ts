import type { BotRow } from "./db";
import { computer } from "./live";

// Work the hub does on the bot's screen for the user: filling request_form's fields and recording a
// demonstration (Teach). Both run inside the bot's computer through the Sandbox SDK's runCommand.

/** One value the user typed into a request_form card. `value` is a secret: see fillForm. */
export interface FormValue {
  id: string;
  target: string;
  value: string;
}

/**
 * Types each value into its field through the browser wrapper's CLI, which drives the visible tab
 * (its \`mcp call\` path lands on another target). The wrapper requires a fresh observation before
 * every mutation, so each fill follows a snapshot; on an unchanged page that snapshot gives the same
 * refs the bot saw, so its \`@eN\` still resolves. The values travel to this command only in its
 * environment; inside the computer each is briefly a \`browser fill\` argument (the CLI takes no
 * stdin). agent-browser parses a leading "-" as an option even inside its JSON channels, so a target
 * or value starting with "-" is never passed: that field fails and the bot falls back to request_login.
 * It prints only the ids that failed: no value comes back, and none is logged or stored.
 */
export const FILL_SCRIPT = `import json, os, subprocess
fields = json.loads(os.environ.pop("BUSY_FORM"))
failed = []
def ok(args):
    run = subprocess.run(["browser", *args], capture_output=True, text=True, timeout=30)
    return run.returncode == 0 and not run.stdout.lstrip().startswith('{"ok":false')
for f in fields:
    if f["target"].startswith("-") or f["value"].startswith("-"):
        failed.append(f["id"])
        continue
    try:
        filled = ok(["snapshot", "-i"]) and ok(["fill", f["target"], f["value"]])
    except Exception:
        filled = False
    if not filled:
        failed.append(f["id"])
print(json.dumps({"failed": failed}))`;

/** The ids that failed (all of them when the computer is gone or the script breaks). */
export async function fillForm(
  bot: BotRow,
  fields: readonly FormValue[]
): Promise<string[]> {
  const all = fields.map((f) => f.id);
  const found = await computer(bot);
  if (!found) {
    return all;
  }
  const run = await found.sandbox.runCommand({
    args: ["-c", FILL_SCRIPT],
    cmd: "python3",
    env: { BUSY_FORM: JSON.stringify(fields) },
  });
  try {
    const out = JSON.parse(
      (await run.stdout()).trim().split("\n").at(-1) ?? ""
    );
    return Array.isArray(out.failed)
      ? out.failed.filter((id: unknown) => all.includes(id as string))
      : all;
  } catch {
    return all;
  }
}

const SPACES = /\s+/u;
export const DEMO_ROOT = "/data/demos";
export const DEMO_ID = /^[0-9a-z-]{8,40}$/u;
export const DEMO_MAX_FRAMES = 300;
export const DEMO_MAX_SECONDS = 600;

/**
 * The recorder (argv: its folder). Every ~2 s a read-only `desktop screenshot` (allowed while the user
 * holds control; no lease) and, when the screen changed, the frame plus Chrome's URL in log.jsonl.
 * The URL comes from Chrome's local DevTools list, read-only: `browser get url` would take the lease.
 */
export const RECORDER = `import hashlib, json, os, subprocess, sys, time, urllib.request
d = sys.argv[1]
start = time.time()
last = None
n = 0
local = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def url():
    try:
        with open("/tmp/desktop-runtime/browser.json") as f:
            endpoint = json.load(f)["cdp"]["http_endpoint"].rstrip("/")
        with local.open(endpoint + "/json/list", timeout=1) as r:
            pages = [t for t in json.load(r) if t.get("type") == "page"]
        # ponytail: Chrome lists the most recently active tab first; good enough for a demo log.
        return pages[0].get("url") if pages else None
    except Exception:
        return None
while n < ${DEMO_MAX_FRAMES} and time.time() - start < ${DEMO_MAX_SECONDS}:
    shot = os.path.join(d, "next.png")
    try:
        subprocess.run(["desktop", "screenshot", shot, "--screen", "0"], capture_output=True, timeout=20)
        with open(shot, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()
    except Exception:
        digest = None
    if digest and digest != last:
        last = digest
        n += 1
        name = "%04d.png" % n
        os.replace(shot, os.path.join(d, name))
        with open(os.path.join(d, "log.jsonl"), "a") as log:
            log.write(json.dumps({"t": int((time.time() - start) * 1000), "frame": name, "url": url()}) + "\\n")
    time.sleep(2)
`;

/** argv: recorder script, folder. Detached (setsid), its pid and start time kept in the folder. */
export const START_RECORDER = `set -e
mkdir -p "$2"
date +%s > "$2/started"
setsid nohup python3 -c "$1" "$2" >/dev/null 2>&1 < /dev/null &
echo $! > "$2/pid"`;

/** argv: folder. Stops the recorder and prints "<frames> <seconds>". */
export const STOP_RECORDER = `[ -f "$1/pid" ] && kill "$(cat "$1/pid")" 2>/dev/null
rm -f "$1/pid" "$1/next.png"
frames=$(find "$1" -maxdepth 1 -name '[0-9]*.png' | wc -l)
started=$(cat "$1/started" 2>/dev/null || date +%s)
echo "$frames $(( $(date +%s) - started ))"`;

export const newDemoId = (now = new Date()) =>
  `${now.toISOString().slice(0, 19).replace(/[T:]/gu, "-")}-${Math.random()
    .toString(36)
    .slice(2, 6)}`.toLowerCase();

/** Starts recording; null when the bot has no running computer. */
export async function startTeaching(bot: BotRow): Promise<string | null> {
  const found = await computer(bot);
  if (found?.sandbox.status !== "running") {
    return null;
  }
  const id = newDemoId();
  const run = await found.sandbox.runCommand({
    args: ["-c", START_RECORDER, "teach", RECORDER, `${DEMO_ROOT}/${id}`],
    cmd: "bash",
  });
  if (run.exitCode !== 0) {
    throw new Error(`teach recorder failed to start (${run.exitCode})`);
  }
  return id;
}

/** Stops recording; null when the computer is gone. */
export async function stopTeaching(
  bot: BotRow,
  id: string
): Promise<{ frames: number; seconds: number } | null> {
  const found = await computer(bot);
  if (!found) {
    return null;
  }
  const run = await found.sandbox.runCommand({
    args: ["-c", STOP_RECORDER, "teach", `${DEMO_ROOT}/${id}`],
    cmd: "bash",
  });
  const [frames = 0, seconds = 0] = (await run.stdout())
    .trim()
    .split(SPACES)
    .map(Number);
  return {
    frames: Number.isFinite(frames) ? frames : 0,
    seconds: Number.isFinite(seconds) ? seconds : 0,
  };
}

/** The chat message the user sends when they stop teaching. */
export function teachMessage(
  id: string,
  { frames, seconds }: { frames: number; seconds: number }
): string {
  const length =
    seconds >= 60
      ? `${Math.floor(seconds / 60)} min ${seconds % 60} s`
      : `${seconds} s`;
  return `I just showed you how to do something on your screen. The recording is in ${DEMO_ROOT}/${id}/ (${frames} frames over ${length}, with log.jsonl). Load the built-in skill learn-from-demonstration and use it to turn it into a reusable skill.`;
}
