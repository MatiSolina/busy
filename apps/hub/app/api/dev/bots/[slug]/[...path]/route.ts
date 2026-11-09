import { authorizeDevRelay } from "@/lib/dev-relay-access";
import { participantProof } from "@/lib/firesides/auth";
import { getFireside } from "@/lib/firesides/store";
import {
  isRoutineRunId,
  signFiresideToken,
  signHubToken,
  signRoutineToken,
} from "@/lib/hub-token";

// Local development uses a registered, expiring OIDC grant. The deployed hub signs for
// that one bot; its production signing key never needs to leave the server.
const DOMAIN = process.env.BOTS_DOMAIN ?? "bots.matisolina.com";
const FIRE_ID = /^[a-f0-9-]{36}$/u;
const SAFE_SLUG = /^[a-z0-9-]{1,40}$/u;

async function relay(
  req: Request,
  { params }: { params: Promise<{ slug: string; path: string[] }> }
) {
  const denied = await authorizeDevRelay(req);
  if (denied) {
    return denied;
  }
  const { slug, path } = await params;
  if (!SAFE_SLUG.test(slug)) {
    return new Response("bad slug", { status: 400 });
  }
  const routineRun = req.headers.get("x-busy-routine-run");
  if (routineRun !== null && !isRoutineRunId(routineRun)) {
    return new Response("bad routine run", { status: 400 });
  }
  const fireId = req.headers.get("x-busy-fireside-id");
  let token: string;
  if (fireId) {
    if (!FIRE_ID.test(fireId) || routineRun !== null) {
      return new Response("bad fireside", { status: 400 });
    }
    const fire = await getFireside(fireId);
    const person =
      fire &&
      Object.values(fire.state.participants).find(
        (p) =>
          p.id === req.headers.get("x-busy-fireside-participant") &&
          p.slug === slug
      );
    if (
      !person ||
      req.headers.get("x-busy-fireside-proof") !== participantProof(person.id)
    ) {
      return new Response("forbidden", { status: 403 });
    }
    token = await signFiresideToken(
      slug,
      fireId,
      person.id,
      participantProof(person.id)
    );
  } else {
    token =
      routineRun === null
        ? await signHubToken(slug)
        : await signRoutineToken(slug, routineRun);
  }
  const target = `https://${slug}.${DOMAIN}/${path.map(encodeURIComponent).join("/")}${new URL(req.url).search}`;
  const contentType = req.headers.get("content-type");
  const res = await fetch(target, {
    body: req.method === "GET" ? undefined : await req.text(),
    headers: {
      // The caller's header is only an occurrence id. It is never forwarded to
      // the bot and is used only after the relay authenticated the request.
      Authorization: `Bearer ${token}`,
      ...(contentType ? { "Content-Type": contentType } : {}),
    },
    method: req.method,
  });
  const headers = new Headers({
    "content-type": res.headers.get("content-type") ?? "",
  });
  res.headers.forEach((v, k) => {
    if (k.startsWith("x-eve-")) {
      headers.set(k, v);
    }
  });
  return new Response(res.body, { headers, status: res.status });
}

export const GET = relay;
export const POST = relay;
export const maxDuration = 300;
