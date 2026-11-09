// Creates the hub's ES256 key for per-bot tokens (lib/hub-token.ts) and stores the private
// half as HUB_SIGNING_KEY on busy-hub production only: whoever can sign can talk to every bot as the
// hub, so a `vercel env pull` must never bring it. Prints only the public half.
// Usage, from apps/hub: node scripts/gen-hub-key.ts
// Fails if the key already exists: a new key means redeploying every bot with its public half.
import { execFileSync } from "node:child_process";
import { exportJWK, generateKeyPair } from "jose";

const { privateKey, publicKey } = await generateKeyPair("ES256", {
  extractable: true,
});
const signingKey = JSON.stringify(await exportJWK(privateKey));

// Through stdin, so the key never shows in argv or shell history.
execFileSync(
  "vercel",
  ["env", "add", "HUB_SIGNING_KEY", "production", "--sensitive", "--yes"],
  {
    input: signingKey,
    stdio: ["pipe", "inherit", "inherit"],
  }
);

// Public. The hub derives it from HUB_SIGNING_KEY and sets it on every bot it deploys.
console.log(`HUB_PUBLIC_KEY=${JSON.stringify(await exportJWK(publicKey))}`);
