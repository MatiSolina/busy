// One-time setup: asks for the account and the Vercel token without echoing
// them, generates internal secrets and stores them in the linked hub project.
// Usage (from apps/hub): node scripts/setup-secrets.ts
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { hashPassword } from "../lib/auth/password.ts";

function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  return new Promise((resolve) => {
    process.stdout.write(question);
    if (hidden) {
      (
        rl as unknown as { _writeToOutput: (s: string) => void }
      )._writeToOutput = () => undefined;
    }
    rl.question("", (answer) => {
      rl.close();
      if (hidden) {
        process.stdout.write("\n");
      }
      resolve(answer.trim());
    });
  });
}

function setEnv(key: string, value: string, environments: string[]) {
  for (const target of environments) {
    const r = spawnSync("vercel", ["env", "add", key, target, "--force"], {
      input: value,
      stdio: ["pipe", "ignore", "inherit"],
    });
    if (r.status !== 0) {
      throw new Error(`vercel env add ${key} ${target} failed`);
    }
  }
  console.log(`✓ ${key}`);
}

const user = (await ask("App username [owner]: ")) || "owner";
const password = await ask("App password (hidden): ", true);
if (password.length < 12) {
  throw new Error(
    "Use a password of 12 characters or more: the hub is on the internet."
  );
}
const token = await ask("Vercel token for this Vercel team (hidden): ", true);
if (!token) {
  throw new Error("A Vercel token is required to deploy and manage bots");
}
const tokenPass = await ask(
  "Token Pass key, or Enter to use AI Gateway: ",
  true
);

const both = ["production", "development"];
setEnv("BUSY_USER", user, both);
setEnv("BUSY_PASSWORD_HASH", await hashPassword(password), both);
// One per environment: a `vercel env pull` must never bring the key that signs production cookies.
for (const env of both) {
  setEnv("SESSION_SECRET", randomBytes(32).toString("base64url"), [env]);
}
setEnv("CRON_SECRET", randomBytes(32).toString("base64url"), ["production"]);
if (token) {
  setEnv("VERCEL_TOKEN", token, both);
}
if (tokenPass) {
  setEnv("TOKEN_PASS_API_KEY", tokenPass, both);
}
console.log("\nDone. Redeploy the linked hub project to apply these values.");
