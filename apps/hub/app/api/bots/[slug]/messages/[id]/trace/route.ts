import { cookies } from "next/headers";
import { z } from "zod";
import { readSession, SESSION_COOKIE } from "@/lib/auth/session";
import { getBot } from "@/lib/bots/service";
import { loadChatTrace } from "@/lib/chat/trace-query";

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

interface Ctx {
  params: Promise<{ id: string; slug: string }>;
}

export async function GET(_req: Request, { params }: Ctx) {
  if (!(await authenticated())) {
    return Response.json(
      { error: "unauthorized" },
      { headers: { "Cache-Control": "no-store" }, status: 401 }
    );
  }

  const { id: rawId, slug } = await params;
  const parsedId = z.uuid().safeParse(rawId);
  if (!parsedId.success) {
    return Response.json(
      { error: "invalid_id" },
      { headers: { "Cache-Control": "no-store" }, status: 400 }
    );
  }
  const bot = await getBot(slug);
  if (!bot) {
    return Response.json(
      { error: "not_found" },
      { headers: { "Cache-Control": "no-store" }, status: 404 }
    );
  }
  const timeline = await loadChatTrace(bot, parsedId.data);
  if (!timeline) {
    return Response.json(
      { error: "not_found" },
      { headers: { "Cache-Control": "no-store" }, status: 404 }
    );
  }
  return Response.json(timeline, {
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
