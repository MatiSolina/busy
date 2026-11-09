import { cookies } from "next/headers";
import { accountSnapshot } from "@/lib/account";
import { readSession, SESSION_COOKIE } from "@/lib/auth/session";

export async function GET() {
  const devBypass =
    process.env.NODE_ENV === "development" &&
    process.env.BUSY_DEV_NO_AUTH === "1";
  const secret = process.env.SESSION_SECRET;
  const session = secret
    ? await readSession((await cookies()).get(SESSION_COOKIE)?.value, secret)
    : null;
  const user =
    session?.user ?? (devBypass ? (process.env.BUSY_USER ?? "dev") : null);
  if (!user) {
    return Response.json(
      { error: "unauthorized" },
      { headers: { "Cache-Control": "no-store" }, status: 401 }
    );
  }

  return Response.json(await accountSnapshot(user), {
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
