import { connection } from "next/server";
import { release } from "@/lib/install";

// Public (lib/auth/session.ts): the Mac app polls it to update itself, before anyone logs in.
// Read per request from this deployment's env, the only place the expected SHA-256 lives.
export async function GET() {
  await connection();
  const rel = release();
  const headers = { "Cache-Control": "no-store" };
  if (!rel) {
    return Response.json(
      { error: "no release published" },
      { headers, status: 503 }
    );
  }
  return Response.json(rel, { headers });
}
