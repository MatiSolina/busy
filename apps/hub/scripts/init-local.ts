// Prepare a local .env.local without placing secrets in a command line.
// Usage: pnpm setup:local

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

const envPath = ".env.local";
const examplePath = ".env.example";
const secret = () => randomBytes(32).toString("base64url");

if (!existsSync(envPath)) {
  if (!existsSync(examplePath)) {
    throw new Error(`Missing ${examplePath}`);
  }
  copyFileSync(examplePath, envPath);
}

let contents = readFileSync(envPath, "utf8");
const values: Record<string, string> = {
  CRON_SECRET: secret(),
  SESSION_SECRET: secret(),
};

for (const [key, value] of Object.entries(values)) {
  const pattern = new RegExp(`^${key}=(.*)$`, "mu");
  const current = contents.match(pattern)?.[1]?.trim() ?? "";
  if (!current || current.includes("replace-with-")) {
    if (pattern.test(contents)) {
      contents = contents.replace(pattern, `${key}=${value}`);
    } else {
      contents += `${contents.endsWith("\n") ? "" : "\n"}${key}=${value}\n`;
    }
  }
}

writeFileSync(envPath, contents, { mode: 0o600 });
chmodSync(envPath, 0o600);
console.log(`Prepared ${envPath} with fresh local session and cron secrets.`);
console.log(
  "Run `pnpm hash-password` and put its output in BUSY_PASSWORD_HASH."
);
