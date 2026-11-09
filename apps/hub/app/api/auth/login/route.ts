import { sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { verifyPassword } from "@/lib/auth/password";
import {
  clientIp,
  LOGIN_WINDOW_MINUTES,
  loginBlocked,
} from "@/lib/auth/rate-limit";
import {
  createSession,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from "@/lib/auth/session";
import { db, loginFailures } from "@/lib/db";
import { need } from "@/lib/env";

const inWindow = sql`${loginFailures.at} > now() - make_interval(mins => ${LOGIN_WINDOW_MINUTES})`;

async function recentFailures(ip: string) {
  const [row] = await db()
    .select({
      ip: sql<number>`count(*) filter (where ${loginFailures.ip} = ${ip})`.mapWith(
        Number
      ),
      total: sql<number>`count(*)`.mapWith(Number),
    })
    .from(loginFailures)
    .where(inWindow);
  return row ?? { ip: 0, total: 0 };
}

// Every try is recorded before the password check and counted with itself, so parallel guesses
// can't all read the same count: the n-th one recorded sees at least n.
async function reserveTry(ip: string) {
  // ctid names this exact row: `at` comes back with millisecond precision and Postgres keeps microseconds.
  const [row] = await db()
    .insert(loginFailures)
    .values({ ip })
    .returning({ ctid: sql<string>`ctid::text` });
  if (!row) {
    throw new Error("Login attempt could not be recorded");
  }
  const seen = await recentFailures(ip);
  const release = () =>
    db().delete(loginFailures).where(sql`ctid = ${row.ctid}::tid`);
  return { earlier: { ip: seen.ip - 1, total: seen.total - 1 }, release };
}

export async function POST(req: Request) {
  const ip = clientIp(req.headers);
  const attempt = await reserveTry(ip);
  // Checked before the password so a blocked guess learns nothing; blocked tries aren't counted.
  if (loginBlocked(attempt.earlier)) {
    await attempt.release();
    return Response.json(
      { ok: false },
      {
        headers: { "Retry-After": String(LOGIN_WINDOW_MINUTES * 60) },
        status: 429,
      }
    );
  }

  const { user, password } = ((await req.json().catch(() => null)) ?? {}) as {
    user?: string;
    password?: string;
  };
  const ok =
    typeof user === "string" &&
    typeof password === "string" &&
    user === need("BUSY_USER") &&
    (await verifyPassword(password, need("BUSY_PASSWORD_HASH")));
  if (!ok) {
    // The delay still slows a single client between counted failures. Only the window matters, so prune here.
    await Promise.all([
      db().delete(loginFailures).where(sql`not (${inWindow})`),
      new Promise((r) => setTimeout(r, 600)),
    ]);
    return Response.json({ ok: false }, { status: 401 });
  }
  await attempt.release();
  (await cookies()).set(
    SESSION_COOKIE,
    await createSession(user, need("SESSION_SECRET")),
    SESSION_COOKIE_OPTIONS
  );
  return Response.json({ ok: true });
}
