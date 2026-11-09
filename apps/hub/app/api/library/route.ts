import { cookies } from "next/headers";
import { readSession, SESSION_COOKIE } from "@/lib/auth/session";
import { listLibraryFiles, parseLibraryQuery } from "@/lib/library";

async function authenticated(): Promise<boolean> {
  if (
    process.env.NODE_ENV === "development" &&
    process.env.BUSY_DEV_NO_AUTH === "1"
  ) {
    return true;
  }
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    return false;
  }
  return Boolean(
    await readSession((await cookies()).get(SESSION_COOKIE)?.value, secret)
  );
}

export async function GET(req: Request) {
  if (!(await authenticated())) {
    return Response.json(
      { error: "unauthorized" },
      { headers: { "Cache-Control": "no-store" }, status: 401 }
    );
  }

  const query = parseLibraryQuery(new URL(req.url).searchParams);
  if (!query) {
    return Response.json(
      { error: "invalid_query" },
      { headers: { "Cache-Control": "no-store" }, status: 400 }
    );
  }

  const result = await listLibraryFiles(query);
  return Response.json(result, {
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
