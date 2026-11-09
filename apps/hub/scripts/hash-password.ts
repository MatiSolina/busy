// Prints the BUSY_PASSWORD_HASH for a password typed without echo.
// Usage: pnpm -C apps/hub hash-password
import { createInterface } from "node:readline";
import { hashPassword } from "../lib/auth/password.ts";

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});
const muted = rl as unknown as { _writeToOutput: (s: string) => void };
process.stdout.write("Password: ");
muted._writeToOutput = () => undefined;
rl.question("", async (pw) => {
  rl.close();
  process.stdout.write("\n");
  if (!pw) {
    process.exit(1);
  }
  console.log(await hashPassword(pw));
});
